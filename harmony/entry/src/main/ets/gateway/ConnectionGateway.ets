import { webSocket, connection } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { backoffDelayMs } from '../logic/backoff';
import { normalizeEvent, WsFrame, NormalizedEvent } from '../logic/normalizeEvent';
import { assistantMessageFromFrame } from '../logic/assistantMessageFromFrame';
import { mergeHistoryMessages } from '../logic/mergeHistory';
import { Outbox, OutboxStatus, RetryPolicy } from '../logic/outbox';
import { WsEvents, ChatMessage } from '../model/Protocol';
import { ChatStore } from '../store/ChatStore';
import { SessionStore } from '../store/SessionStore';
import { TaskStore } from '../store/TaskStore';
import { ConnectionStore, ConnectionPhase } from '../store/ConnectionStore';
import { AuthStore } from '../store/AuthStore';
import { NotificationGateway } from './NotificationGateway';
import { HistoryApi } from './HistoryApi';
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
   * True when the last history-backfill attempt failed for a reason other
   * than 401 (a 401 logs the user out instead, see `backfillHistory`).
   * Plain field, not `@Trace` — this class isn't a Store (see class doc)
   * — so `MessageList`'s `ErrorBanner` reads it through the same
   * tick-gated polling trick it already uses for outbox status
   * (`outboxEntriesOf`/`statusOf`), not a new poll.
   */
  private historyError: boolean = false;
  /**
   * Task 17 fix round, Important-3: `retryHistory` (the `ErrorBanner`'s
   * manual retry) and the reconnect-scheduled call from the
   * `bridge:manifest` dispatch branch can both target the same `chatKey`
   * concurrently — each would otherwise snapshot its own cursor and apply
   * its own result independently, and whichever resolves later could stomp
   * the other (including leaving `historyError` on a stale value). A plain
   * `Set`, not `@Trace` — nothing renders off it directly, only
   * `backfillHistory` reads/writes it.
   */
  private backfillInFlight: Set<string> = new Set<string>();

  start(baseUrl: string, token: string): void {
    this.baseUrl = baseUrl;
    this.token = token;
    this.stopped = false;
    this.attempt = 0;
    this.observeNetwork();
    this.startAckSweep();
    this.open();
  }

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
    ConnectionStore.connect().setPhase('disconnected');
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
      this.outbox.expireTimedOut(Date.now());
    }, ACK_SWEEP_MS);
  }

  sendMessage(chatKey: string, text: string): string {
    const clientMsgId: string = util.generateRandomUUID(true);
    const parts: string[] = chatKey.split('::');
    const connectionId: string = parts[0] ?? '';
    const sessionKey: string = parts[1] ?? '';
    const now: number = Date.now();

    ChatStore.connect().append(chatKey, {
      id: clientMsgId, role: 'user', content: text, timestamp: now,
      connectionId: connectionId, sessionKey: sessionKey,
    });

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
      const parts: string[] = entry.chatKey.split('::');
      const envelope: OutgoingEnvelope = {
        type: WsEvents.SEND_MESSAGE,
        connectionId: parts[0] ?? '',
        sessionKey: parts[1] ?? '',
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
   * Whether `MessageList`'s `ErrorBanner` should be showing for the
   * current chat — see the `historyError` field doc.
   */
  historyErrorFlag(): boolean {
    return this.historyError;
  }

  /** `ErrorBanner`'s "重试" button — Task 17 degradation-table row 5. */
  retryHistory(chatKey: string): void {
    this.backfillHistory(chatKey);
  }

  /**
   * Incremental history backfill (Task 17 Step 1) — runs after every
   * successful connection's `bridge:manifest` (see the dispatch handler
   * above for why there, not directly in `open()`), not just the first
   * connect, so a long-disconnected client's transcript catches up on
   * reconnect too.
   *
   * `ChatStore.maxSeqOf(chatKey)` is read once, *before* the async `fetch`
   * call, and passed straight into `HistoryApi.fetch(chatKey, cursor)`
   * (Task 17 fix round, Minor) — `fetch` no longer independently re-derives
   * the same value, so the branch decision here and the request URL it
   * builds can never desync even if an `await` is ever introduced between
   * them.
   *
   * There is no `cursor === 0` branch anymore (Task 17 fix round,
   * Important-1/Important-2): both the cold-start case and the incremental
   * case now go through the same `mergeHistoryMessages(current, messages)`
   * call, reading `current` fresh from `ChatStore` *after* the fetch
   * resolves rather than reusing the pre-fetch snapshot. That fresh read is
   * what lets a message the user sent — or one the live socket delivered —
   * while this fetch was in flight survive instead of being wiped by a bare
   * `replaceAll`, and lets `mergeHistoryMessages`'s id-based dedup collapse
   * a message that arrived by both paths into one. See that function's doc
   * for the full merge/ordering rationale.
   *
   * `backfillInFlight` guards against two concurrent runs for the same
   * `chatKey` (Task 17 fix round, Important-3) — `retryHistory`'s manual tap
   * and a reconnect-triggered call can otherwise race; a re-entrant call
   * here is a plain no-op rather than a second in-flight fetch that could
   * apply its result after (or instead of) the first.
   *
   * Failure handling is exactly the Step 2 + Step 4 contract: a
   * `UnauthorizedError` from `RestClient` (thrown by any REST call,
   * `HistoryApi.fetch` included) clears the token and stops this gateway —
   * no silent retry, a dead token never succeeds on retry. Any other
   * failure (network blip, server 5xx) sets `historyError` instead, which
   * `MessageList` surfaces as a top banner with a manual retry
   * (`retryHistory` above) — it must not interrupt the current
   * conversation, so nothing here blocks sending/receiving on this path.
   */
  private backfillHistory(chatKey: string): void {
    if (chatKey.length === 0) {
      // No session selected yet — nothing to backfill. Can still happen
      // here (not just at the very first `open()`): a manifest with zero
      // bridges, or one that arrives before the user has ever picked a
      // session and the deferred default-pick (see the caller) hasn't run
      // yet either.
      return;
    }
    if (this.backfillInFlight.has(chatKey)) {
      hilog.info(DOMAIN, TAG, 'history backfill already in flight for %{public}s, skipping', chatKey);
      return;
    }
    this.backfillInFlight.add(chatKey);
    const cursor: number = ChatStore.connect().maxSeqOf(chatKey);
    const historyApi: HistoryApi = new HistoryApi(this.baseUrl, this.token);
    historyApi.fetch(chatKey, cursor).then((messages: ChatMessage[]) => {
      const current: ChatMessage[] = ChatStore.connect().messagesOf(chatKey);
      ChatStore.connect().replaceAll(chatKey, mergeHistoryMessages(current, messages));
      this.historyError = false;
    }).catch((err: Error) => {
      if (err instanceof UnauthorizedError) {
        hilog.warn(DOMAIN, TAG, 'history backfill got 401, logging out (no retry)');
        // Fire-and-forget, same pattern as ChatWindow's
        // NotificationGateway.requestPermission call: `clear()`'s
        // synchronous prefix (before its first internal `await`) already
        // flips `AuthStore.authorized`, which is what Index's
        // `@Monitor('auth.authorized')` reacts to — nothing here needs to
        // wait for the preferences flush to finish.
        AuthStore.connect().clear();
        // Stop outright, not just log out: without this, a dead token
        // would keep bouncing through backoffDelayMs() forever in the
        // background after the UI has already fallen back to LoginGate.
        this.stop();
        return;
      }
      hilog.error(DOMAIN, TAG, 'history backfill failed: %{public}s', err.message);
      this.historyError = true;
    }).finally(() => {
      this.backfillInFlight.delete(chatKey);
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

  private dispatch(event: NormalizedEvent): void {
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
