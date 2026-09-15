import { AppStorageV2 } from '@kit.ArkUI';
import { Session, SlashCommandSpec } from '../model/Protocol';
import { WsFrame, BridgeInfo, chatKeyOf, splitChatKey } from '../logic/normalizeEvent';

const APP_STORAGE_KEY: string = 'SessionStore';

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

  @Trace currentChatKey: string = '';
  @Trace skillCommands: SlashCommandSpec[] = [];
  /** Populated from bridge:manifest's `bridges` field. */
  @Trace bridges: BridgeInfo[] = [];

  @Trace private sessions: Map<string, Session> = new Map<string, Session>();
  @Trace private unread: Map<string, number> = new Map<string, number>();
  @Trace private residentKeys: Set<string> = new Set<string>();

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

  setCurrent(chatKey: string): void {
    this.currentChatKey = chatKey;
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
   */
  clearAll(): void {
    this.currentChatKey = '';
    this.skillCommands = [];
    this.bridges = [];
    this.sessions = new Map<string, Session>();
    this.unread = new Map<string, number>();
    this.residentKeys = new Set<string>();
  }

  applyManifest(frame: WsFrame): void {
    this.bridges = frame.bridges ?? [];
  }

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
  }

  /** `bridge:skills-updated`'s command list (`WsFrame.commands`, see normalizeEvent.ets). */
  applySkills(frame: WsFrame): void {
    this.skillCommands = frame.commands ?? [];
  }
}
