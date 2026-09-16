import { AppStorageV2 } from '@kit.ArkUI';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { Session, SlashCommandSpec } from '../model/Protocol';
import {
  WsFrame, BridgeInfo, ChatKeyParts, chatKeyOf, splitChatKey, DEFAULT_SESSION_KEY,
} from '../logic/normalizeEvent';
import { serializeStringMap, deserializeStringMap } from '../logic/sessionMaps';

const APP_STORAGE_KEY: string = 'SessionStore';
const STORE_NAME: string = 'cc_pet_sessions';
const KEY_ACTIVE_SESSION_KEYS: string = 'activeSessionKeys';
const KEY_STICKY_SESSIONS: string = 'stickySessions';

/**
 * What `persist()` writes to preferences and what `persistedSnapshot()`
 * hands to a unit test -- see that method's doc for why a plain snapshot
 * object, rather than the preferences store itself, is the testable seam.
 */
interface PersistedSessionSnapshot {
  activeSessionKeysJson: string;
  stickySessionsJson: string;
}

/** Carries a session's position in the incoming list through `sortSessions`. */
interface OrderedSession {
  session: Session;
  index: number;
}

/**
 * Newest-active first, `createdAt` as the tie-break, original order last.
 *
 * The index decoration is not decoration. ArkTS's `Array.sort` publishes no
 * stability guarantee, and two sessions with an identical `lastActiveAt`
 * AND `createdAt` is exactly what a pair of sessions seeded in the same
 * request looks like — without the index they could swap places between two
 * renders of an otherwise unchanged list, which a `ForEach` keyed on
 * position would render as the two rows trading places by themselves.
 */
function sortSessions(list: Session[]): Session[] {
  const ordered: OrderedSession[] = list.map((session: Session, index: number): OrderedSession => {
    return { session: session, index: index };
  });
  ordered.sort((a: OrderedSession, b: OrderedSession): number => {
    if (b.session.lastActiveAt !== a.session.lastActiveAt) {
      return b.session.lastActiveAt - a.session.lastActiveAt;
    }
    if (b.session.createdAt !== a.session.createdAt) {
      return b.session.createdAt - a.session.createdAt;
    }
    return a.index - b.index;
  });
  return ordered.map((entry: OrderedSession): Session => entry.session);
}

/**
 * Must be obtained through `AppStorageV2.connect()` — see Global Constraints
 * in docs/superpowers/plans/2026-09-15-harmony-client.md and
 * .superpowers/sdd/2026-09-15-harmony-client/reactivity-fix-report.md for
 * why a bare `static readonly instance` does not register consumers as V2
 * observers. A `private constructor()` was not attempted here — it is known
 * to fail ArkTS compilation (see AuthStore.ets for the exact error); the
 * single-access-point rule is enforced by convention/review only.
 */
@ObservedV2
export class SessionStore {
  static connect(): SessionStore {
    const instance: SessionStore | undefined =
      AppStorageV2.connect(SessionStore, APP_STORAGE_KEY, (): SessionStore => new SessionStore());
    if (instance === undefined) {
      throw new Error('SessionStore.connect(): AppStorageV2.connect returned undefined');
    }
    return instance;
  }

  /**
   * Derived state, never assigned from outside this class.
   *
   * It stays a plain `@Trace` FIELD, recomputed and written by
   * `recomputeCurrentChatKey()`, rather than becoming a getter over
   * `activeConnection` + `activeSessionKeys`. ArkUI V2 collects a
   * component's render dependencies from the `@Trace` fields its `build()`
   * READS; a getter reads the backing fields inside the store's own method
   * frame, where no observer is registered, so every component that shows
   * the current chat (`ChatWindow`, `MessageList`, `MessageInput`,
   * `PetMini`, `Index`'s top bar, both session shells) would silently stop
   * re-rendering on a session switch.
   */
  @Trace currentChatKey: string = '';
  @Trace skillCommands: SlashCommandSpec[] = [];
  /** Populated from bridge:manifest's `bridges` field. */
  @Trace bridges: BridgeInfo[] = [];

  /** chatKey (`${connectionId}::${sessionKey}`) → Session. */
  @Trace private sessions: Map<string, Session> = new Map<string, Session>();
  /**
   * connectionId → that connection's sessions, pre-sorted by `sortSessions`.
   *
   * A second index over the same records as `sessions`, not a second source
   * of truth: every writer (`applySessions`, `upsertSession`,
   * `removeSession`) updates `sessions` and then calls
   * `rebuildConnectionIndex()` in the same method, so the two can never
   * disagree. Sorting happens on write because `sessionsOf()` is called
   * from `build()`, where a per-render sort would also hand back a new
   * array identity every frame.
   */
  @Trace private sessionsByConnection: Map<string, Session[]> = new Map<string, Session[]>();
  /**
   * connectionId → the session the user last looked at ON THAT CONNECTION.
   *
   * Per-connection rather than global so switching bridges and switching
   * back returns to the conversation you left, instead of resetting to
   * 'default'.
   */
  @Trace private activeSessionKeys: Map<string, string> = new Map<string, string>();
  /**
   * connectionId → the session a pending turn is pinned to.
   *
   * Separate from `activeSessionKeys` because the two answer different
   * questions: "what is on screen" versus "where does an unlabelled reply
   * belong". They diverge exactly when the user sends into one session and
   * switches away before the reply lands.
   */
  @Trace private stickySessions: Map<string, string> = new Map<string, string>();
  @Trace private activeConnection: string = '';

  @Trace private unread: Map<string, number> = new Map<string, number>();
  @Trace private residentKeys: Set<string> = new Set<string>();

  /**
   * Not `@Trace`: a preferences handle isn't render state, and (unlike
   * `activeSessionKeys`/`stickySessions`) nothing in `build()` ever reads
   * it. `undefined` until `initPersistence()` runs, exactly like
   * `AuthStore.store` -- `persist()` below is a deliberate no-op until then
   * (there's nothing to write to yet, and unit tests never call
   * `initPersistence`, so `persist()` staying a no-op is what keeps every
   * existing `SessionStore` test working unchanged).
   */
  private store: preferences.Preferences | undefined = undefined;

  unreadOf(chatKey: string): number {
    return this.unread.get(chatKey) ?? 0;
  }

  totalUnread(): number {
    let total: number = 0;
    this.unread.forEach((count: number) => {
      total += count;
    });
    return total;
  }

  /**
   * The ONE place that decides what a chat is called. Three files used to
   * answer this question separately — `SessionRow.labelForBridge` (both
   * session shells), `Index.currentSessionLabel()` (the top bar), and this
   * method (notification titles) — and only the first two knew about the
   * bridge-name fallback below. The third is what a lock screen actually
   * rendered: a literal `b1::default` next to the reply text, because
   * `/api/sessions` was never called, so `sessions` was always empty and
   * this returned the raw chatKey.
   *
   * Preference order, and why:
   * 1. the server's own `Session.label` — it is the only one that knows a
   *    user-set or auto-derived title;
   * 2. the advertised bridge name from `bridge:manifest` ("工作台A") — known
   *    from the first frame of every connection, before any REST call;
   * 3. the bare session key ('default') — better than nothing;
   * 4. the raw chatKey, for a key belonging to neither a known session nor
   *    a known bridge.
   *
   * `bridges` is already a field of this store, so no caller has to thread
   * the manifest in to get the fallback.
   *
   * One caller deliberately does not come here: the session ROWS in
   * `SessionSidebar`/`SessionSheet` (`SessionRow.rowLabel`). Fallback 2 is
   * what makes that right for a notification title or the top bar and wrong
   * for a list of one connection's sessions — every unlabelled row would read
   * the same bridge name. Fallback 1, the only one that can name an
   * individual session, reads the same `Session.label` field either way.
   */
  labelOf(chatKey: string): string {
    const session: Session | undefined = this.sessions.get(chatKey);
    if (session !== undefined && session.label !== undefined && session.label.length > 0) {
      return session.label;
    }
    const bridgeName: string = this.bridgeNameFor(chatKey);
    if (bridgeName.length > 0) {
      return bridgeName;
    }
    if (session !== undefined) {
      return session.key;
    }
    return chatKey;
  }

  /** '' when this chatKey's connectionId matches no advertised bridge. */
  private bridgeNameFor(chatKey: string): string {
    const connectionId: string = splitChatKey(chatKey).connectionId;
    if (connectionId.length === 0) {
      return '';
    }
    for (const bridge of this.bridges) {
      if (bridge.id === connectionId) {
        return bridge.name;
      }
    }
    return '';
  }

  isResident(chatKey: string): boolean {
    return this.residentKeys.has(chatKey);
  }

  // ---------------------------------------------------------------------
  // Two-level model: connection → sessions
  // ---------------------------------------------------------------------

  /**
   * Reads back `activeSessionKeys`/`stickySessions` from a previous run,
   * mirroring `AuthStore.init()`'s pattern (same preferences channel, same
   * "no store yet" guard on every write). Call once at startup, before
   * anything routes an inbound frame — a cold start followed by a
   * `sessionKey`-less reply is exactly the case web's localStorage mirror
   * of these two maps exists to fix; see task-3-brief.md.
   *
   * `deserializeStringMap` only inserts keys that were actually persisted,
   * so a connectionId this run never calls `setActiveSession` on again
   * still reads back as `''` from `activeSessionKeyRawOf` — the "never
   * picked" sentinel survives the round trip, not just the substituted
   * `'default'` value. `activeConnection`/`currentChatKey` are NOT
   * restored here: this task persists only the two per-connection pointer
   * maps (task-3-brief.md's stated scope); which bridge lands on screen at
   * cold start is `Index.defaultToFirstBridgeIfNoneSelected`'s job.
   */
  async initPersistence(context: common.UIAbilityContext): Promise<void> {
    this.store = await preferences.getPreferences(context, STORE_NAME);
    const activeRaw: string = await this.store.get(KEY_ACTIVE_SESSION_KEYS, '') as string;
    const stickyRaw: string = await this.store.get(KEY_STICKY_SESSIONS, '') as string;
    this.activeSessionKeys = deserializeStringMap(activeRaw);
    this.stickySessions = deserializeStringMap(stickyRaw);
  }

  /**
   * The JSON `persist()` would write for each map RIGHT NOW, computed
   * straight off the live `activeSessionKeys`/`stickySessions` fields.
   *
   * Public only so a unit test can assert the persisted half of
   * `clearAll()`'s contract. `preferences.Preferences` itself can't be
   * exercised inside `hvigorw test`'s host runtime -- `AuthStore.init` /
   * `save` / `clear` are the existing, permanently-uncovered precedent for
   * that -- but the BYTES `persist()` computes are a pure function of
   * in-memory state, so a test can check those without a real store. If
   * `clearAll()` ever stops resetting one of the two maps, this method's
   * output for that map stops being `'{}'` and the test that reads it
   * fails, exactly as if the real on-disk copy had leaked into the next
   * account.
   */
  persistedSnapshot(): PersistedSessionSnapshot {
    return {
      activeSessionKeysJson: serializeStringMap(this.activeSessionKeys),
      stickySessionsJson: serializeStringMap(this.stickySessions),
    };
  }

  /**
   * Writes both pointer maps to preferences. Called after every mutator
   * that can change either map, and from `clearAll()` -- there, it runs
   * AFTER both maps have already been reset to empty, so the write that
   * follows persists the wipe rather than the account that just logged
   * out. Without this call in `clearAll()`, the next `initPersistence()`
   * (the next app launch, now under a different account) would read the
   * previous account's pointers straight back off disk, undoing the
   * in-memory clear a moment after it happened -- the exact leak this
   * task's brief warns `clearAll()` must not reintroduce.
   *
   * A no-op until `initPersistence()` has run (`this.store` still
   * `undefined`), same guard as every `AuthStore` write. Fire-and-forget,
   * same as `AuthStore.connect().clear()`'s callers: nothing here needs to
   * wait for the flush to land before returning, and every call site above
   * is a synchronous method.
   */
  private persist(): void {
    if (this.store === undefined) {
      return;
    }
    const snapshot: PersistedSessionSnapshot = this.persistedSnapshot();
    this.writeSnapshot(this.store, snapshot);
  }

  private async writeSnapshot(store: preferences.Preferences, snapshot: PersistedSessionSnapshot): Promise<void> {
    await store.put(KEY_ACTIVE_SESSION_KEYS, snapshot.activeSessionKeysJson);
    await store.put(KEY_STICKY_SESSIONS, snapshot.stickySessionsJson);
    await store.flush();
  }

  /**
   * That connection's sessions, newest-active first.
   *
   * Returns the stored array by reference (not a defensive copy) so a
   * `ForEach` over it sees a stable identity across renders that did not
   * change the list. Treat it as read-only: mutating it would desync this
   * index from `sessions` without going through a writer.
   */
  sessionsOf(connectionId: string): Session[] {
    return this.sessionsByConnection.get(connectionId) ?? [];
  }

  /** `sessionsOf` reduced to keys — the shape `resolveIncomingSessionRouting` wants. */
  knownSessionKeysOf(connectionId: string): string[] {
    return this.sessionsOf(connectionId).map((session: Session): string => session.key);
  }

  /**
   * 'default' for a connection the user has never picked a session on.
   *
   * Deliberately NOT "first known session": a connection's session list
   * arrives asynchronously (`/api/sessions`), and answering with whatever
   * happened to be first would make the active session change under the
   * user when that response lands. `resolveIncomingSessionRouting` already
   * owns the known-session fallback for inbound frames.
   */
  activeSessionKeyOf(connectionId: string): string {
    return this.activeSessionKeys.get(connectionId) ?? DEFAULT_SESSION_KEY;
  }

  /**
   * The same pointer WITHOUT the `'default'` substitution — `''` means "this
   * connection has never been looked at".
   *
   * Inbound session routing must use this one, not `activeSessionKeyOf`.
   * Web passes the raw value into the router
   * (`packages/web/src/lib/web-adapter.ts`: `activeSessionKey:
   * s.activeSessionKey[connectionId]`), so on a connection the user has
   * never touched it arrives as `undefined` and the router falls through to
   * its `'known'` branch. Feeding the `'default'`-substituted value in
   * instead makes `active.length > 0` always true, which would render
   * `resolveIncomingSessionRouting`'s `'known'` AND `'fallback'` branches
   * unreachable — an unlabelled frame would land in `default` here while web
   * put it in `knownSessions[0]`. Found by the Task 2 review before Task 6
   * could wire the wrong accessor in.
   */
  activeSessionKeyRawOf(connectionId: string): string {
    return this.activeSessionKeys.get(connectionId) ?? '';
  }

  activeConnectionId(): string {
    return this.activeConnection;
  }

  setActiveConnection(connectionId: string): void {
    this.activeConnection = connectionId;
    this.recomputeCurrentChatKey();
  }

  setActiveSession(connectionId: string, sessionKey: string): void {
    if (connectionId.length === 0 || sessionKey.length === 0) {
      return;
    }
    this.activeSessionKeys.set(connectionId, sessionKey);
    this.recomputeCurrentChatKey();
    this.persist();
  }

  /** '' when no turn is pinned on this connection. */
  stickySessionOf(connectionId: string): string {
    return this.stickySessions.get(connectionId) ?? '';
  }

  noteStickySession(connectionId: string, sessionKey: string): void {
    if (connectionId.length === 0 || sessionKey.length === 0) {
      return;
    }
    // Unchanged value is a no-op, matching web's own guard
    // (`packages/web/src/lib/store/session.ts`: `if (s.stickySession...
    // === sessionKey) return s`). Not cosmetic: Task 6c made every outgoing
    // message call this, and without the guard each send wrote the same
    // value straight back to preferences. Skipping it also avoids a
    // pointless `@Trace` write, which would wake every observer of this
    // store for a change that isn't one.
    if (this.stickySessions.get(connectionId) === sessionKey) {
      return;
    }
    this.stickySessions.set(connectionId, sessionKey);
    this.persist();
  }

  clearStickySession(connectionId: string): void {
    this.stickySessions.delete(connectionId);
    this.persist();
  }

  /**
   * The single config-declared resident session, wherever it lives.
   *
   * Searched across connections, not within one, because the resident
   * session is a property of the account: callers (notification taps, the
   * cold-start landing pick) know they want "the resident chat" without
   * knowing which bridge declares it.
   */
  residentSession(): Session | undefined {
    const all: Session[] = [];
    this.sessions.forEach((session: Session) => {
      all.push(session);
    });
    for (const session of all) {
      if (session.isResident === true) {
        return session;
      }
    }
    return undefined;
  }

  /** Inserts or replaces one session without waiting for the next `applySessions`. */
  upsertSession(session: Session): void {
    const key: string = chatKeyOf(session.connectionId, session.key);
    if (key.length === 0) {
      return;
    }
    this.sessions.set(key, session);
    if (session.isResident === true) {
      this.residentKeys.add(key);
    } else {
      this.residentKeys.delete(key);
    }
    this.rebuildConnectionIndex();
  }

  /**
   * Forgets a session everywhere it is referenced.
   *
   * The active-session fallback is the reason this can't just be two
   * `Map.delete` calls: deleting the session the user is looking at would
   * otherwise leave `currentChatKey` pointing at a chat that no longer
   * exists, and every history fetch for it comes back empty — the exact
   * "history never loads" symptom this task exists to remove.
   */
  removeSession(connectionId: string, sessionKey: string): void {
    const key: string = chatKeyOf(connectionId, sessionKey);
    if (key.length === 0) {
      return;
    }
    this.sessions.delete(key);
    this.residentKeys.delete(key);
    this.unread.delete(key);
    this.rebuildConnectionIndex();

    if (this.stickySessions.get(connectionId) === sessionKey) {
      this.stickySessions.delete(connectionId);
    }
    if (this.activeSessionKeys.get(connectionId) === sessionKey) {
      const remaining: Session[] = this.sessionsOf(connectionId);
      this.activeSessionKeys.set(
        connectionId,
        remaining.length > 0 ? remaining[0].key : DEFAULT_SESSION_KEY,
      );
    }
    this.recomputeCurrentChatKey();
    this.persist();
  }

  /**
   * Kept because most existing callers (`SessionRow.selectSession`,
   * `Index.defaultToFirstBridgeIfNoneSelected`) hold a chatKey, not a pair.
   * It is a thin adapter onto the same two writes `setActiveConnection` +
   * `setActiveSession` perform, so both entry points land in one place —
   * a second assignment straight to `currentChatKey` here is what would let
   * the field and `activeSessionKeys` drift apart.
   */
  setCurrent(chatKey: string): void {
    const parts: ChatKeyParts = splitChatKey(chatKey);
    if (parts.connectionId.length === 0 || parts.sessionKey.length === 0) {
      // Not a chat key at all (`splitChatKey` yields two empty strings for
      // anything without a `::`). Preserve the pre-two-level behaviour of
      // storing it verbatim rather than silently dropping the call.
      this.currentChatKey = chatKey;
      return;
    }
    this.setActiveSession(parts.connectionId, parts.sessionKey);
    this.setActiveConnection(parts.connectionId);
  }

  private recomputeCurrentChatKey(): void {
    if (this.activeConnection.length === 0) {
      this.currentChatKey = '';
      return;
    }
    this.currentChatKey = chatKeyOf(this.activeConnection, this.activeSessionKeyOf(this.activeConnection));
  }

  /**
   * Re-derives `sessionsByConnection` from `sessions`. Every writer of
   * `sessions` calls this before returning, which is what makes the two
   * maps one piece of state rather than two that have to be kept in step.
   */
  private rebuildConnectionIndex(): void {
    const buckets: Map<string, Session[]> = new Map<string, Session[]>();
    this.sessions.forEach((session: Session) => {
      const bucket: Session[] | undefined = buckets.get(session.connectionId);
      if (bucket === undefined) {
        buckets.set(session.connectionId, [session]);
      } else {
        bucket.push(session);
      }
    });
    const next: Map<string, Session[]> = new Map<string, Session[]>();
    buckets.forEach((list: Session[], connectionId: string) => {
      next.set(connectionId, sortSessions(list));
    });
    this.sessionsByConnection = next;
  }

  /**
   * Local, notification-driven unread bump. Resident sessions get their
   * unread count from the server (resident:unread → setUnread) — server is
   * the sole source of truth there, so this is a deliberate no-op for them.
   */
  incrementUnread(chatKey: string): void {
    if (this.residentKeys.has(chatKey)) {
      return;
    }
    this.unread.set(chatKey, this.unreadOf(chatKey) + 1);
  }

  /** The only method allowed to change a resident session's unread count. */
  setUnread(chatKey: string, count: number): void {
    this.unread.set(chatKey, count);
  }

  /**
   * Local "I've seen this" reset. Gated the same as incrementUnread: a
   * resident session's true unread count is only known to the server, so
   * clearing it locally would just be overwritten (or worse, momentarily
   * wrong) until the next resident:unread arrives.
   */
  clearUnread(chatKey: string): void {
    if (this.residentKeys.has(chatKey)) {
      return;
    }
    this.unread.set(chatKey, 0);
  }

  /** `bridge:manifest`'s bridge list (`WsFrame.bridges`, see normalizeEvent.ets). */
  /**
   * Logout only. Mirrors `ChatStore.clearAll()`: `ConnectionGateway.stop()`
   * already drops the outbox and the transcript so account A's data cannot
   * reach account B, but `currentChatKey` and `bridges` used to survive that
   * same boundary. A stale `currentChatKey` pointing at a bridge the next
   * account does not have makes `Index.defaultToFirstBridgeIfNoneSelected()`
   * return early (it only fires when the key is empty), so B would land on a
   * permanently blank chat surface until it picked a session by hand.
   *
   * `skillCommands` goes too: slash commands are advertised per account.
   *
   * The two-level state (`sessionsByConnection`, `activeSessionKeys`,
   * `stickySessions`, `activeConnection`) crosses the same boundary for the
   * same reason: an `activeConnection` left pointing at account A's bridge
   * would be recomputed straight back into `currentChatKey` the moment B
   * selected anything.
   *
   * `persist()` runs LAST, after both pointer maps are already empty --
   * without it, the on-disk copy `initPersistence()` reads on the next
   * launch would still hold account A's pointers, and B's fresh login would
   * silently reload them the moment `initPersistence()` ran. That is the
   * same class of leak this method already exists to close for in-memory
   * state; see `persist()`'s doc for why it can and cannot be unit-tested.
   */
  clearAll(): void {
    this.currentChatKey = '';
    this.skillCommands = [];
    this.bridges = [];
    this.sessions = new Map<string, Session>();
    this.sessionsByConnection = new Map<string, Session[]>();
    this.activeSessionKeys = new Map<string, string>();
    this.stickySessions = new Map<string, string>();
    this.activeConnection = '';
    this.unread = new Map<string, number>();
    this.residentKeys = new Set<string>();
    this.persist();
  }

  applyManifest(frame: WsFrame): void {
    this.bridges = frame.bridges ?? [];
  }

  /**
   * Called ONCE with every bridge's sessions aggregated (see
   * `SessionApi.fetchAll` / `ConnectionGateway.fetchSessions`), never once
   * per bridge — so rebuilding both maps globally here is correct, and a
   * per-connection merge would be wrong: a connection absent from the
   * payload has no sessions, it has not merely "gone unmentioned".
   *
   * `activeSessionKeys` and `stickySessions` are deliberately left alone. A
   * session can be selected locally (a just-created one) before the server
   * lists it, and pruning here would yank the user out of it mid-flight.
   * `removeSession` owns the explicit-deletion path.
   */
  applySessions(sessions: Session[]): void {
    const nextSessions: Map<string, Session> = new Map<string, Session>();
    const nextResidents: Set<string> = new Set<string>();
    const nextUnread: Map<string, number> = new Map<string, number>(this.unread);
    for (const session of sessions) {
      const key: string = chatKeyOf(session.connectionId, session.key);
      if (key.length === 0) {
        continue;
      }
      nextSessions.set(key, session);
      if (session.isResident === true) {
        nextResidents.add(key);
        nextUnread.set(key, session.unreadCount ?? 0);
      }
    }
    // Drop unread counts for chatKeys that no longer appear in the incoming
    // session list, so a removed session's count doesn't linger in
    // totalUnread() forever.
    const staleKeys: string[] = [];
    nextUnread.forEach((_count: number, key: string) => {
      if (!nextSessions.has(key)) {
        staleKeys.push(key);
      }
    });
    for (const key of staleKeys) {
      nextUnread.delete(key);
    }
    this.sessions = nextSessions;
    this.residentKeys = nextResidents;
    this.unread = nextUnread;
    this.rebuildConnectionIndex();
    this.persist();
  }

  /** `bridge:skills-updated`'s command list (`WsFrame.commands`, see normalizeEvent.ets). */
  applySkills(frame: WsFrame): void {
    this.skillCommands = frame.commands ?? [];
  }
}
