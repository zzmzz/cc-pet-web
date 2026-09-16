import { webSocket, connection } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { backoffDelayMs } from '../logic/backoff';
import {
  normalizeEvent, WsFrame, NormalizedEvent, splitChatKey, ChatKeyParts, BridgeInfo, chatKeyOf,
} from '../logic/normalizeEvent';
import { resolveIncomingSessionRouting, SessionRouteDecision } from '../logic/sessionRouting';
import { assistantMessageFromFrame } from '../logic/assistantMessageFromFrame';
import { Outbox, OutboxStatus, RetryPolicy } from '../logic/outbox';
import { WsEvents, ChatMessage, Session, isRoutedEventType } from '../model/Protocol';
import { ChatStore } from '../store/ChatStore';
import { SessionStore } from '../store/SessionStore';
import { TaskStore } from '../store/TaskStore';
import { ConnectionStore, ConnectionPhase } from '../store/ConnectionStore';
import { AuthStore } from '../store/AuthStore';
import { NotificationGateway } from './NotificationGateway';
import { HistoryBackfill } from './HistoryBackfill';
import { SessionApi } from './SessionApi';
import { UnauthorizedError } from './RestClient';

// ConnectionPhase itself lives in store/ConnectionStore.ets — the field it
// types belongs to that store, and Store must not import from Gateway
// (dependency direction is Gateway -> Store, per Global Constraints).

const DOMAIN = 0x0000;
const TAG = 'ConnectionGateway';

const ACK_SWEEP_MS: number = 5000;

interface OutgoingEnvelope {
  type: string;
  connectionId: string;
  sessionKey: string;
  content: string;
  clientMsgId: string;
}

/**
 * Minimal read-only view of one Outbox entry's send status, for
 * `ConnectionGateway.outboxEntriesOf` — the UI only ever needs these two
 * fields to render/retry a bubble, never the entry's `text`/`policy`/
 * `createdAt`/`transmittedAt`.
 */
export interface OutboxStatusView {
  clientMsgId: string;
  status: OutboxStatus;
}

/**
 * Gateway, not a Store: it holds no `@Trace` state of its own and nothing
 * observes it reactively, so — unlike ChatStore/SessionStore/TaskStore/
 * ConnectionStore — it stays a plain `static readonly instance` per Global
 * Constraints (that rule is scoped to Store singletons).
 */
export class ConnectionGateway {
  static readonly instance: ConnectionGateway = new ConnectionGateway();

  private socket: webSocket.WebSocket | undefined = undefined;
  private netConn: connection.NetConnection | undefined = undefined;
  private attempt: number = 0;
  private timer: number = -1;
  private sweepTimer: number = -1;
  private baseUrl: string = '';
  private token: string = '';
  private outbox: Outbox = new Outbox();
  private stopped: boolean = true;
  private foreground: boolean = true;
  /**
   * History backfill lives in its own collaborator (see `HistoryBackfill`);
   * this gateway keeps only the handle and forwards `retryHistory`. Rebuilt
   * on every `start()` so a re-login after a 401 never reuses the dead
   * token or a stale in-flight set. `undefined` until the first `start()`.
   */
  private backfill: HistoryBackfill | undefined = undefined;
  /**
   * Which chats have a turn still in flight, as told by
   * `bridge:typing-start` / `bridge:typing-stop` and by nothing else. Read
   * only by `routeIncoming`, to answer "which session asked?" on a turn where
   * no frame ever names one.
   *
   * A plain field, not a store, and that is not a loophole in the "no
   * `@Trace` state in the gateway" rule: nothing renders this. The UI's
   * notion of "is this chat busy" is `TaskStore`'s phase, which is written
   * independently in `dispatch` below and is what `PetView`/`MessageList`
   * observe. Putting this in an observable store would publish a value no
   * component reads and invite a future component to read it, at which point
   * the two notions of "typing" would have to stay in sync forever.
   *
   * And it is NOT `TaskStore`, which looks equivalent
   * (`setPhase(chatKey, 'working')` is already written on typing-start) but
   * is not, in two ways that both break routing:
   *   1. `dispatch` also drives `TaskStore` to `'working'` from every
   *      `bridge:stream-delta`. Web's `typingActiveByChatKey` is written by
   *      the two typing events only. Reusing the phase would let a keyless
   *      delta that was just mis-guessed into `c1::s2` mark `c1::s2` busy and
   *      thereby confirm its own guess for every frame after it — the exact
   *      failure mode sticky's read-only-on-guess discipline exists to avoid.
   *   2. `TaskStore` is persistent `@Trace` state that outlives a logout;
   *      web's map is a local of the `[authToken]` effect and dies with it.
   *      Account A's in-flight turn must not steer account B's frames.
   *
   * Cleared in `start()`/`stop()` and nowhere else — in particular NOT on
   * reconnect, matching web: `createWebAdapter`'s socket reconnects inside
   * the adapter (`packages/web/src/lib/web-adapter.ts`), the App effect never
   * re-runs, and the map survives. A turn that spans a dropped socket keeps
   * its pin on both clients.
   */
  private typingByChatKey: Map<string, boolean> = new Map();

  start(baseUrl: string, token: string): void {
    this.baseUrl = baseUrl;
    this.token = token;
    this.stopped = false;
    this.attempt = 0;
    this.typingByChatKey.clear();
    this.backfill = new HistoryBackfill(baseUrl, token, (): void => { this.logoutAndStop(); });
    this.observeNetwork();
    this.startAckSweep();
    this.open();
  }

  /**
   * Tears the connection down AND drops everything the previous session
   * queued or displayed.
   *
   * The teardown half was always here. The forgetting half was not, and that
   * was the more serious bug: all three logout paths (this gateway's own 401
   * handler, `HistoryBackfill`'s, and `MessageInput.toggleBridge`'s) end
   * here, but `ConnectionGateway` is an `AppStorageV2`-outliving singleton
   * and `ChatStore`/`Outbox` are process-lifetime state, so account A's
   * unsent messages and A's whole transcript survived into account B's
   * session on the same device. `flushOutbox()` would then put A's queued
   * text on B's socket on B's first connect.
   *
   * Does NOT clear `AuthStore` — the three callers each decide whether this
   * is a logout or just a shutdown, and `EntryAbility` shutting the app down
   * must not wipe a perfectly good token.
   */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    if (this.sweepTimer !== -1) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = -1;
    }
    if (this.socket !== undefined) {
      this.socket.close();
      this.socket = undefined;
    }
    if (this.netConn !== undefined) {
      this.netConn.unregister(() => {});
      this.netConn = undefined;
    }
    this.outbox.clear();
    this.typingByChatKey.clear();
    this.backfill = undefined;
    ChatStore.connect().clearAll();
    SessionStore.connect().clearAll();
    ConnectionStore.connect().clearHistoryErrors();
    ConnectionStore.connect().setPhase('disconnected');
  }

  /**
   * The one 401 reaction, shared by this gateway's own REST callers and by
   * `HistoryBackfill` (through the callback handed to its constructor).
   *
   * Fire-and-forget on `clear()`, same pattern as `ChatWindow`'s
   * `NotificationGateway.requestPermission` call: `clear()`'s synchronous
   * prefix (before its first internal `await`) already flips
   * `AuthStore.authorized`, which is what Index's
   * `@Monitor('auth.authorized')` reacts to — nothing here needs to wait for
   * the preferences flush to finish.
   *
   * `stop()` outright, not just log out: without it a dead token would keep
   * bouncing through `backoffDelayMs()` forever in the background after the
   * UI has already fallen back to `LoginGate`.
   */
  private logoutAndStop(): void {
    AuthStore.connect().clear();
    this.stop();
  }

  setForeground(value: boolean): void {
    this.foreground = value;
  }

  private clearTimer(): void {
    if (this.timer !== -1) {
      clearTimeout(this.timer);
      this.timer = -1;
    }
  }

  private wsUrl(): string {
    const scheme: string = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
    const host: string = this.baseUrl.replace(/^https?/, '');
    return `${scheme}${host}/ws?token=${encodeURIComponent(this.token)}`;
  }

  private open(): void {
    if (this.stopped) {
      return;
    }
    this.clearTimer();
    ConnectionStore.connect().setPhase('connecting');

    if (this.socket !== undefined) {
      this.socket.close();
    }
    const socket: webSocket.WebSocket = webSocket.createWebSocket();
    this.socket = socket;

    // Every handler below is registered on this exact `socket` instance, but
    // `this.socket.close()` above does not synchronously unregister them —
    // the old socket's 'close'/'error' still fire asynchronously afterward.
    // Without the `this.socket !== socket` guard, that stale event calls
    // scheduleReconnect() against the *current* gateway state even once a
    // newer socket has already connected successfully, producing a
    // self-inflicted reconnect loop with a period of exactly
    // backoffDelayMs(0) (1000ms) — reproduced live on the emulator against a
    // real server (see Task 11 report) before this guard was added.
    socket.on('open', () => {
      if (this.socket !== socket) {
        return;
      }
      this.attempt = 0;
      ConnectionStore.connect().setPhase('connected');
      ConnectionStore.connect().markConnectedAt(Date.now());
      this.flushOutbox();
      // History backfill itself is triggered from the `bridge:manifest`
      // dispatch below, not here — see that branch's doc for why.
    });

    socket.on('message', (err: Error | undefined, data: string | ArrayBuffer) => {
      if (this.socket !== socket || err !== undefined || typeof data !== 'string') {
        return;
      }
      // The server spreads payload fields onto the top level, so the frame
      // parses directly — no envelope unwrapping, no shim.
      this.dispatch(normalizeEvent(JSON.parse(data as string) as WsFrame));
    });

    socket.on('close', () => {
      if (this.socket !== socket) {
        return;
      }
      this.scheduleReconnect();
    });
    socket.on('error', () => {
      if (this.socket !== socket) {
        return;
      }
      this.scheduleReconnect();
    });

    socket.connect(this.wsUrl(), (err: Error | undefined) => {
      if (this.socket !== socket) {
        return;
      }
      if (err !== undefined) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== -1) {
      return;
    }
    ConnectionStore.connect().setPhase('backoff');
    const delay: number = backoffDelayMs(this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = -1;
      this.open();
    }, delay);
  }

  /** Network came back: retry immediately instead of waiting out the backoff. */
  private observeNetwork(): void {
    if (this.netConn !== undefined) {
      return;
    }
    const netConn: connection.NetConnection = connection.createNetConnection();
    this.netConn = netConn;
    netConn.on('netAvailable', () => {
      // netAvailable also fires on Wi-Fi/cellular handoff and DHCP renewal,
      // not just after an outage. Tearing down an already-connected (or
      // in-flight) socket here would kill a healthy connection and make
      // flushOutbox() re-revive and re-send messages that were merely
      // awaiting ack.
      const phase: ConnectionPhase = ConnectionStore.connect().phase;
      if (phase === 'connected' || phase === 'connecting') {
        return;
      }
      this.attempt = 0;
      this.clearTimer();
      this.open();
    });
    netConn.register(() => {});
  }

  /** Entries whose ack never arrived turn failed, so their bubbles can go red. */
  private startAckSweep(): void {
    if (this.sweepTimer !== -1) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      // Bump the store only when something actually expired. This is the
      // whole reason `MessageList` no longer runs a 1 Hz timer of its own:
      // the sweep is the only event that can change a bubble's send status
      // without any other `@Trace` write happening, so it is the only thing
      // that needs to announce itself. A quiet sweep writes nothing and
      // re-renders nothing.
      if (this.outbox.expireTimedOut(Date.now()).length > 0) {
        ConnectionStore.connect().bumpOutboxRevision();
      }
    }, ACK_SWEEP_MS);
  }

  /**
   * Task 6c: web pins sticky from its outgoing sends too (`ChatWindow.tsx`
   * L245/293/318, one per send path — plain text, staged attachment, inline
   * base64 fallback), unconditionally and before/at the moment the frame
   * goes out. This gateway had only ever pinned sticky from the inbound side
   * (`routeIncoming`, on a payload/reply_ctx frame), which the Task 6b review
   * traced back to a premise ("sticky is only ever written by a frame that
   * already identified its own session") that is true of THIS client's
   * history but was never true of web's. The gap it leaves: a bridge that
   * streams a keyless reply and never sends `bridge:typing-start` routed
   * correctly on web, because the user's own send had already pinned the
   * session, and wrongly here, because nothing had.
   *
   * Written from `parts.sessionKey`, the session the text actually went
   * into — not `SessionStore.currentChatKey`, which can already have moved
   * on by the time this runs (there is no `await` between the tap and here,
   * but a future attachment-upload path, mirroring web's staged-attachment
   * send, would introduce exactly that gap; reading the argument instead of
   * store state keeps this correct either way).
   *
   * Unconditional, matching web: gating this further (e.g. only-if-empty)
   * would diverge from every one of web's three call sites, none of which
   * checks the existing pin before writing. The no-op-on-unchanged guard
   * lives in `SessionStore.noteStickySession`, mirroring web's — an earlier
   * version of this comment claimed that guard as an existing fact when
   * harmony's store had no such check, so every send wrote the same value
   * back to preferences. Found by the Task 6c review; the guard is real now.
   */
  sendMessage(chatKey: string, text: string): string {
    const clientMsgId: string = util.generateRandomUUID(true);
    const parts: ChatKeyParts = splitChatKey(chatKey);
    const now: number = Date.now();

    ChatStore.connect().append(chatKey, {
      id: clientMsgId, role: 'user', content: text, timestamp: now,
      connectionId: parts.connectionId, sessionKey: parts.sessionKey,
    });
    SessionStore.connect().noteStickySession(parts.connectionId, parts.sessionKey);

    const policy: RetryPolicy = 'auto';
    this.outbox.enqueue(clientMsgId, chatKey, text, policy, now);
    if (ConnectionStore.connect().phase === 'connected') {
      this.transmit([clientMsgId]);
    }
    return clientMsgId;
  }

  /** User tapped retry on one failed bubble. */
  retry(clientMsgId: string): void {
    this.outbox.resend(clientMsgId, Date.now());
    // `resend` flips the entry back to 'sending' inside the outbox, which is
    // not observable state — so without this the bubble keeps rendering red
    // with 「发送失败」 until the ack lands. The 1 Hz `MessageList` timer used
    // to paper over this; now that it is gone, every outbox mutation the UI
    // can see has to announce itself, exactly like the ack sweep does.
    ConnectionStore.connect().bumpOutboxRevision();
    if (ConnectionStore.connect().phase === 'connected') {
      this.transmit([clientMsgId]);
    }
  }

  /**
   * Per-message send-status view for one chat's bubbles. Added for Task 12:
   * the Task 11 contract (see that brief's Interfaces block) didn't expose
   * the outbox, but the send-state UI it specifies ("failed 的气泡标红...来自
   * Outbox，不在 ChatStore 里另存一份") has no other way to read per-message
   * status. Narrowed (Task 12 fix round) to a small read-only view carrying
   * only `clientMsgId`/`status` — the UI never needs `text`/`policy`/
   * `createdAt`/`transmittedAt`, and handing out live `OutboxEntry` objects
   * leaked those fields for no reason. Returns a fresh array of fresh view
   * objects every call; mutates nothing.
   */
  outboxEntriesOf(chatKey: string): OutboxStatusView[] {
    const views: OutboxStatusView[] = [];
    for (const entry of this.outbox.entriesOf(chatKey)) {
      views.push({ clientMsgId: entry.clientMsgId, status: entry.status });
    }
    return views;
  }

  private transmit(ids: string[]): void {
    if (this.socket === undefined) {
      return;
    }
    const sent: string[] = [];
    for (const entry of this.outbox.takeSendable(Date.now())) {
      let wanted: boolean = false;
      for (const id of ids) {
        if (entry.clientMsgId === id) {
          wanted = true;
        }
      }
      if (!wanted) {
        continue;
      }
      const parts: ChatKeyParts = splitChatKey(entry.chatKey);
      const envelope: OutgoingEnvelope = {
        type: WsEvents.SEND_MESSAGE,
        connectionId: parts.connectionId,
        sessionKey: parts.sessionKey,
        content: entry.text,
        clientMsgId: entry.clientMsgId,
      };
      this.socket.send(JSON.stringify(envelope));
      sent.push(entry.clientMsgId);
    }
    this.outbox.markTransmitted(sent, Date.now());
  }

  /** Reconnect path: everything still sendable goes back out, oldest first. */
  private flushOutbox(): void {
    this.outbox.reviveAuto(Date.now());
    const ids: string[] = [];
    for (const entry of this.outbox.takeSendable(Date.now())) {
      ids.push(entry.clientMsgId);
    }
    this.transmit(ids);
  }

  /**
   * `ErrorBanner`'s "重试" button — Task 17 degradation-table row 5.
   * Forwards to `HistoryBackfill`; the banner's visibility itself is read
   * straight off `ConnectionStore.historyErrorOf(chatKey)` by
   * `MessageList`, so there is no `historyErrorFlag()` here anymore (that
   * method existed only because the flag used to live on this class, where
   * the UI could not observe it).
   */
  retryHistory(chatKey: string): void {
    this.backfillHistory(chatKey);
  }

  /**
   * "Show me this chat's transcript" — called on every session switch
   * (`SessionRow.selectSession`), which is the trigger web gets from its
   * lazy loader (`setActiveSession` -> `lazyLoadChat`, see
   * `packages/web/src/lib/hydrateFromServer.ts`). Before this, the only
   * backfill trigger in this client was the single `currentChatKey` known at
   * `bridge:manifest` time, so every session except the one you landed on
   * opened empty and stayed empty until the next reconnect.
   *
   * Idempotent and cheap to call on every switch, which is why the
   * shared row helper can call it unconditionally: `HistoryBackfill` skips a
   * chatKey it is already fetching, and reads `ChatStore.maxSeqOf(chatKey)`
   * as an `afterSeq` cursor — so returning to an already-loaded chat asks
   * only for what arrived since, not the whole transcript. There is no
   * "already loaded" flag to keep in step (web needs one because its loader
   * always fetches from zero).
   *
   * Separate from `retryHistory` despite the identical body: they are
   * different contracts with different callers (a user tapping 重试 on the
   * error banner vs. the shells switching session), and only one of them is
   * allowed to grow a "don't refetch" guard later.
   *
   * NOT called for a session this client just created — see
   * `SessionRow.applyCreatedSession`.
   */
  ensureHistory(chatKey: string): void {
    this.backfillHistory(chatKey);
  }

  /**
   * Drops every client-only leftover under one session key: its messages and
   * half-streamed text (`ChatStore.clear`), its task phase, its unread count.
   * Web's `resetSessionResidue` (`packages/web/src/lib/store/session.ts`),
   * same three things.
   *
   * Lives on the gateway, not on `SessionStore`: it spans three stores, and
   * the stores in this codebase deliberately do not import one another
   * (dependency direction is Gateway -> Store). The gateway is already the
   * place that writes all three in `dispatch`.
   *
   * Called for a freshly created key and nothing else. That is the whole
   * justification for it being safe: a `session-${Date.now()}` key the server
   * has never heard of can only hold state that leaked in from another
   * conversation — a keyless reply mis-routed into it, say — so there is
   * nothing here to lose.
   *
   * THE OUTBOX IS DELIBERATELY NOT TOUCHED. A queued-but-unacked message is
   * the one piece of state in this client that exists nowhere else: the
   * server has not seen it, so no backfill can bring it back, and dropping it
   * would be silent, permanent data loss of something the user typed. (This
   * codebase has shipped that shape of bug before; see the first-release
   * cold-start report.) Under the only key this is called with, the outbox is
   * always empty anyway — and if a future caller ever points it at a live
   * chat, the queued text still goes out on the next flush and comes back
   * with the next backfill, rather than disappearing. `ChatStore.clear` does
   * make its bubble vanish from the transcript until then; that is the price
   * of not deleting it, and it is the right way round.
   *
   * `ConnectionStore.historyErrorOf` is left alone for the same "only ever a
   * brand-new key" reason: nothing can have fetched history for a key that
   * did not exist a moment ago, so there is no banner to clear.
   */
  resetSessionResidue(connectionId: string, sessionKey: string): void {
    const chatKey: string = chatKeyOf(connectionId, sessionKey);
    if (chatKey.length === 0) {
      return;
    }
    ChatStore.connect().clear(chatKey);
    TaskStore.connect().clearPhase(chatKey);
    SessionStore.connect().clearUnread(chatKey);
  }

  /**
   * The ~90 lines that used to live here are now `HistoryBackfill.run` —
   * all that is left is the forward, plus the `undefined` guard for the
   * window between `stop()` and the next `start()` (a manifest frame can
   * still be in flight when a 401 tears the gateway down).
   */
  private backfillHistory(chatKey: string): void {
    if (this.backfill === undefined) {
      return;
    }
    this.backfill.run(chatKey);
  }

  /**
   * `/api/sessions`, once per connection, one request per advertised bridge
   * (the route answers `{ sessions: [] }` without a `connectionId`).
   *
   * Runs off `bridge:manifest` rather than `socket.on('open')` for the same
   * reason the backfill does: the bridge list this needs arrives with that
   * frame and nowhere else.
   *
   * What it buys, both of which were broken while this was never called:
   * notification titles stop being the raw `b1::default` chatKey
   * (`SessionStore.labelOf` needs a `Session` record or a manifest bridge to
   * name a chat), and `residentKeys` finally gets populated so spec §6.3's
   * "resident sessions ignore all local unread increments; the server is the
   * sole truth" invariant is actually armed.
   *
   * Failure never touches the socket — same posture as the history
   * backfill, minus the banner: there is no per-session UI to degrade, the
   * labels simply stay at their manifest-name fallback. A 401 is the one
   * exception and is handled like every other 401 in this codebase.
   */
  private fetchSessions(bridges: BridgeInfo[]): void {
    const connectionIds: string[] = [];
    for (const bridge of bridges) {
      connectionIds.push(bridge.id);
    }
    if (connectionIds.length === 0) {
      return;
    }
    new SessionApi(this.baseUrl, this.token).fetchAll(connectionIds)
      .then((sessions: Session[]) => {
        SessionStore.connect().applySessions(sessions);
      })
      .catch((err: Error) => {
        if (err instanceof UnauthorizedError) {
          hilog.warn(DOMAIN, TAG, 'session list got 401, logging out (no retry)');
          this.logoutAndStop();
          return;
        }
        hilog.error(DOMAIN, TAG, 'session list fetch failed: %{public}s', err.message);
      });
  }

  /**
   * Notification predicate: is the user not looking at this chat right now?
   * Deliberately separate from unread counting — resident sessions take their
   * unread from the server, but "should I buzz" is always a local question.
   */
  private isAway(chatKey: string): boolean {
    return chatKey !== SessionStore.connect().currentChatKey || !this.foreground;
  }

  /**
   * Decides which session an inbound frame belongs to, before any store sees
   * it.
   *
   * A reply that arrives without a `sessionKey` belongs to the session that
   * ASKED, not to whichever session the user has since switched to. That
   * sentence is the whole feature: without it, sending into one chat,
   * switching to another while the model thinks, and getting the answer in
   * the second chat is indistinguishable, from the user's side, from the
   * message having been sent to the wrong place.
   *
   * Only the 11 types in `ROUTED_EVENT_TYPES` go through this; everything
   * else keeps the `sessionKey` that was on the wire (`bridge:manifest` is
   * connection-wide, `message-ack` is addressed by `clientMsgId`,
   * `resident:unread` names its own chatKey and is server-authoritative).
   *
   * `activeSessionKeyRawOf`, NOT `activeSessionKeyOf`. The raw accessor
   * answers `''` for a connection the user has never opened, which is the
   * `undefined` web passes in (`activeSessionKey: s.activeSessionKey[
   * connectionId]` in `packages/web/src/lib/web-adapter.ts`) and which lets
   * the router fall through to `knownSessions[0]`. The substituting accessor
   * would hand back `'default'`, making `active.length > 0` permanently true
   * — the router's `'known'` and `'fallback'` branches would become dead
   * code and a keyless frame would land in `c1::default`, a chat that may not
   * exist, while web put the same frame in the connection's first real
   * session. `activeSessionKeyRawOf` exists for no other reason; see its doc.
   *
   * Sticky is written when the frame TOLD us its session (`'payload'`,
   * `'reply_ctx'`) and only read when we GUESSED (`'active'`, `'known'`,
   * `'fallback'`) — mirroring `packages/web/src/App.tsx`. Letting a guess
   * write the pin would let one mis-guessed frame drag the rest of the turn
   * after it, and the pin would no longer mean "where this turn came from".
   *
   * Typing is the layer BELOW sticky (see the block itself): it is what keeps
   * a turn pinned when no frame of that turn ever names a session, which is
   * the only case sticky cannot cover at all.
   *
   * Public, not private, purely as a test seam (same rationale as
   * `SessionStore.persistedSnapshot`): it is the one part of `dispatch` that
   * can be exercised without a socket, a notification manager or a clock, and
   * `DispatchRouting.test.ets` is what proves the accessor above is the raw
   * one. It has exactly one production caller, the first line of `dispatch`.
   */
  routeIncoming(event: NormalizedEvent): NormalizedEvent {
    if (event.connectionId.length === 0 || !isRoutedEventType(event.type)) {
      return event;
    }
    const sessions: SessionStore = SessionStore.connect();
    const connectionId: string = event.connectionId;
    const decision: SessionRouteDecision = resolveIncomingSessionRouting({
      payloadSessionKey: event.frame.sessionKey,
      // Whichever spelling the upstream bridge chose — see `WsFrame.replyCtx`.
      replyCtx: event.frame.replyCtx ?? event.frame.reply_ctx,
      knownSessions: sessions.knownSessionKeysOf(connectionId),
      activeSessionKey: sessions.activeSessionKeyRawOf(connectionId),
    });

    let sessionKey: string = decision.sessionKey;
    if (decision.source === 'payload' || decision.source === 'reply_ctx') {
      sessions.noteStickySession(connectionId, sessionKey);
    } else {
      let decidedBy: string = 'router';
      const sticky: string = sessions.stickySessionOf(connectionId);
      if (sticky.length > 0) {
        sessionKey = sticky;
        decidedBy = 'sticky';
      }
      // Typing runs AFTER sticky and overrides it unconditionally. Web's
      // `if` here (App.tsx L209-216) tests `guessedFromActiveSession`, a
      // `const` that the sticky block never touches — the sticky block
      // narrows a *different* variable (`sessionIsGuess`). Reading it as an
      // `else` of the sticky block is the one mistake that makes this layer
      // look redundant, and it is not: sticky is ONE slot per connection —
      // Task 6c made `sendMessage` write it too (see that method's doc), so a
      // bridge that never sends `session_key` no longer leaves it empty for
      // the whole turn, but that same write means a second send, or a second
      // turn's keyed reply, on a DIFFERENT session overwrites it while the
      // first turn is still in flight. Typing is what still remembers the
      // first turn's home in that overlap; sticky alone cannot, because it
      // has nowhere to keep two answers.
      //
      // (Earlier drafts of this comment, and of the Task 6b/6c briefs, said
      // "sticky is only ever written by a frame that already identified its
      // own session" as if that were a general truth. It described this
      // gateway's OWN write from `routeIncoming` accurately but was never
      // true of `packages/web`, which pins sticky from three outgoing send
      // sites too (`ChatWindow.tsx` L245/293/318) — see the Task 6c report.)
      const typing: string = this.typingSessionOf(connectionId);
      if (typing.length > 0) {
        sessionKey = typing;
        decidedBy = 'typing';
      }
      if (sessionKey !== decision.sessionKey) {
        // The server log records that the frame carried no `session_key` but
        // not where it ended up; this is the other half, so a reported
        // "reply went to the wrong chat" can be traced from logs without a
        // live repro. Only the frames a pin actually MOVED are logged, not
        // every guess web logs (App.tsx L188-198): after this task the
        // interesting question is which layer won, and on a bridge that never
        // sends `session_key` the every-guess form would log each delta.
        // Placed after the typing layer, unlike web, which logs inside the
        // sticky block and so prints a `resolvedSessionKey` that the typing
        // layer may still overwrite — a breadcrumb naming a chat the frame
        // did not go to is worse than none.
        // Fields match web's payload (type/connectionId/routeSource/sticky/
        // resolvedSessionKey): identifiers only, never token, URL or content.
        hilog.warn(DOMAIN, TAG,
          'keyless %{public}s on %{public}s: %{public}s -> %{public}s by %{public}s (sticky %{public}s)',
          event.type, connectionId, decision.source, sessionKey, decidedBy,
          sticky.length > 0 ? sticky : '-');
      }
    }

    this.noteTyping(event.type, chatKeyOf(connectionId, sessionKey));

    if (sessionKey === event.sessionKey) {
      return event;
    }
    return {
      type: event.type,
      connectionId: connectionId,
      sessionKey: sessionKey,
      chatKey: chatKeyOf(connectionId, sessionKey),
      // The same frame object, not a rebuilt one: every consumer below reads
      // its raw fields (`content`, `msgId`, `seq`, `delta`) straight off it.
      frame: event.frame,
    };
  }

  /**
   * The session on this connection whose turn is still in flight, or `''`.
   *
   * Insertion order, first match wins — `Object.entries` order is what web's
   * `findTypingActiveSession` walks, and `Map` preserves the same thing
   * (re-`set`ting an existing key does not move it, exactly like assigning to
   * an existing object property). With two turns overlapping on one
   * connection both clients therefore pick the one that started typing
   * FIRST, which is not obviously the better answer — the newer turn is the
   * likelier owner of a frame arriving now. Copied rather than improved:
   * a client that quietly disagrees with web about where a reply belongs is
   * worse than both being wrong identically, because nobody can see it. See
   * the Task 6b report's note raising this as a web-side question.
   *
   * `substring`, not a rebuilt key: a session key may itself contain `::`,
   * and the prefix is the only part we know the length of.
   */
  private typingSessionOf(connectionId: string): string {
    const prefix: string = `${connectionId}::`;
    for (const chatKey of this.typingByChatKey.keys()) {
      if (this.typingByChatKey.get(chatKey) === true && chatKey.startsWith(prefix)) {
        return chatKey.substring(prefix.length);
      }
    }
    return '';
  }

  /**
   * Records a turn as started/finished, keyed by where the typing frame
   * actually LANDED rather than by what it claimed — typing frames are
   * routed like every other frame, so a keyless typing-start on a pinned
   * connection belongs to the pinned session.
   *
   * Lives here rather than in `dispatch`'s typing branches (where web puts
   * it, inside the switch) so that the whole typing lifecycle — write and
   * read — is one reviewable block, and so `routeIncoming` stays the single
   * seam `DispatchTypingRouting.test.ets` drives. Observationally identical:
   * nothing between routing and the switch touches the map.
   *
   * A stop for a chat that is not typing writes nothing, mirroring web's
   * early `break` (App.tsx L446-449). That matters for more than tidiness:
   * inserting a `false` entry would give that chatKey an insertion-order
   * slot it has not earned, ahead of chats already typing, and a later
   * typing-start on it would inherit that slot.
   */
  private noteTyping(type: string, chatKey: string): void {
    if (chatKey.length === 0) {
      return;
    }
    if (type === WsEvents.BRIDGE_TYPING_START) {
      this.typingByChatKey.set(chatKey, true);
      return;
    }
    if (type === WsEvents.BRIDGE_TYPING_STOP && this.typingByChatKey.get(chatKey) === true) {
      this.typingByChatKey.set(chatKey, false);
    }
  }

  private dispatch(incoming: NormalizedEvent): void {
    // Routing runs before anything reads `chatKey`, because `chatKey` is what
    // every branch below stores against — `normalizeEvent` can only build it
    // from the `sessionKey` that was on the wire, and the frames this task
    // exists for have none.
    const event: NormalizedEvent = this.routeIncoming(incoming);
    if (event.type === WsEvents.MESSAGE_ACK) {
      const clientMsgId: string = event.frame.clientMsgId ?? '';
      if (clientMsgId.length === 0) {
        return;
      }
      this.outbox.markSent(clientMsgId);
      ChatStore.connect().applyAck(clientMsgId, event.frame.id ?? clientMsgId, event.frame.seq ?? 0);
      return;
    }
    if (event.type === WsEvents.RESIDENT_UNREAD) {
      SessionStore.connect().setUnread(event.chatKey, event.frame.unreadCount ?? 0);
      return;
    }
    if (event.type === WsEvents.BRIDGE_CONNECTED) {
      ConnectionStore.connect().setBridgeConnected(true);
      ConnectionStore.connect().markConnectedAt(Date.now());
      return;
    }
    if (event.type === WsEvents.BRIDGE_ERROR) {
      ConnectionStore.connect().setBridgeConnected(false);
      return;
    }
    if (event.type === WsEvents.BRIDGE_MANIFEST) {
      SessionStore.connect().applyManifest(event.frame);
      // Task 17 Step 1's backfill trigger lives here, not in socket.on('open')
      // above: the server (see `hub.onClientConnected` in
      // `packages/server/src/index.ts`) sends `bridge:manifest` on *every*
      // successful connection — first connect and every reconnect alike —
      // so this fires exactly once per connection too, with one guarantee
      // `open()` alone can't give: `SessionStore.currentChatKey` is only
      // ever non-empty starting from a bridge list, and `applyManifest`
      // just supplied that list. On a cold start (no session ever picked),
      // `currentChatKey` was still `''` at `open()` time — Index.ets's
      // `@Monitor('session.bridges')` (which runs its own default-session
      // pick) fires synchronously off the `@Trace` write `applyManifest`
      // just made, so by the next line `currentChatKey` already reflects
      // that pick if one just happened, and is otherwise already whatever
      // the user had selected before this reconnect.
      // `setTimeout(..., 0)`, not a direct call: `applyManifest` above is a
      // synchronous `@Trace` write, but Index.ets's own
      // `@Monitor('session.bridges')` (which does the actual default-session
      // pick into `currentChatKey` on a cold start) does not run inside that
      // same call stack — confirmed on-device (see Task 17 report) reading
      // `currentChatKey` synchronously right here still saw `''` even though
      // `bridges` had already updated. Deferring one macrotask is enough for
      // ArkUI's reactive update pass to run first; this is a single one-shot
      // callback, not a poll (`ConnectionGateway`'s only sanctioned repeating
      // timer is the ack sweep).
      // `/api/sessions` goes out immediately (it needs only the bridge ids
      // this frame just delivered, not `currentChatKey`), while the backfill
      // still waits a macrotask for the default-session pick described
      // above.
      this.fetchSessions(event.frame.bridges ?? []);
      setTimeout(() => { this.backfillHistory(SessionStore.connect().currentChatKey); }, 0);
      return;
    }
    if (event.type === WsEvents.BRIDGE_SKILLS_UPDATED) {
      SessionStore.connect().applySkills(event.frame);
      return;
    }
    if (event.type === WsEvents.BRIDGE_TYPING_START) {
      TaskStore.connect().setPhase(event.chatKey, 'working');
      return;
    }
    if (event.type === WsEvents.BRIDGE_TYPING_STOP) {
      TaskStore.connect().setPhase(event.chatKey, 'completed');
      return;
    }
    if (event.type === WsEvents.BRIDGE_STREAM_DELTA) {
      ChatStore.connect().appendDelta(event.chatKey, event.frame.delta ?? '');
      TaskStore.connect().setPhase(event.chatKey, 'working');
      return;
    }
    if (event.type === WsEvents.BRIDGE_STREAM_DONE) {
      // Use the server's own id and seq. Synthesising them breaks maxSeqOf(),
      // which Task 17's incremental history backfill reads as its cursor.
      const message: ChatMessage = assistantMessageFromFrame(event.frame, event.chatKey, Date.now());
      ChatStore.connect().finalizeStream(
        event.chatKey, message.content, message.id, message.timestamp, message.seq ?? 0,
      );
      TaskStore.connect().setPhase(event.chatKey, 'completed');
      this.afterAssistantReply(event.chatKey, message.content);
      return;
    }
    if (event.type === WsEvents.BRIDGE_MESSAGE) {
      const message: ChatMessage = assistantMessageFromFrame(event.frame, event.chatKey, Date.now());
      ChatStore.connect().append(event.chatKey, message);
      TaskStore.connect().setPhase(event.chatKey, 'completed');
      this.afterAssistantReply(event.chatKey, message.content);
    }
  }

  private afterAssistantReply(chatKey: string, text: string): void {
    if (!this.isAway(chatKey)) {
      return;
    }
    // Resident sessions get their unread from resident:unread; incrementUnread
    // is a no-op for them by design (see SessionStore).
    SessionStore.connect().incrementUnread(chatKey);
    NotificationGateway.instance.notifyReply(
      chatKey,
      SessionStore.connect().labelOf(chatKey),
      text.length > 80 ? `${text.slice(0, 80)}…` : text,
    );
  }
}
