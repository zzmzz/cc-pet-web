import { AppStorageV2 } from '@kit.ArkUI';
import { Session, SlashCommandSpec } from '../model/Protocol';
import { WsPayload, chatKeyOf } from '../logic/normalizeEvent';

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

  labelOf(chatKey: string): string {
    const session: Session | undefined = this.sessions.get(chatKey);
    if (session === undefined) {
      return chatKey;
    }
    return session.label !== undefined && session.label.length > 0 ? session.label : session.key;
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

  /**
   * Placeholder: `bridge:manifest`'s real payload carries a `bridges` array
   * (see packages/server/src/index.ts, `send(WS_EVENTS.BRIDGE_MANIFEST, {
   * bridges: ... })`), but `WsPayload` (logic/normalizeEvent.ets, owned by
   * an earlier task) does not declare that field, so it cannot be read here
   * without an indexed/dynamic access ArkTS strict mode forbids
   * (arkts-no-props-by-index). Session bootstrapping instead goes through
   * applySessions(), which a later task feeds from a REST
   * GET Endpoints.SESSIONS call. This method is kept as a documented no-op
   * so ConnectionGateway.dispatch() matches the Task 11 contract and
   * compiles; real behavior needs WsPayload extended with a `bridges` field
   * first — flagged in the Task 11 report as a concern, not silently
   * papered over.
   */
  applyManifest(payload: WsPayload): void {
    // No-op until WsPayload declares the `bridges` field bridge:manifest sends.
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
    this.sessions = nextSessions;
    this.residentKeys = nextResidents;
    this.unread = nextUnread;
  }

  /**
   * Placeholder: `bridge:skills-updated`'s real payload carries a `commands`
   * array (see packages/server/src/index.ts,
   * `send(WS_EVENTS.BRIDGE_SKILLS_UPDATED, { connectionId, commands })`),
   * but `WsPayload` does not declare that field for the same reason noted on
   * applyManifest() above. Kept as a documented no-op for the same reason.
   */
  applySkills(payload: WsPayload): void {
    // No-op until WsPayload declares the `commands` field bridge:skills-updated sends.
  }
}
