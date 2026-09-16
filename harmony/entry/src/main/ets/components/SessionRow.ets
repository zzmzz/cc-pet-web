import { promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SessionStore } from '../store/SessionStore';
import { AuthStore } from '../store/AuthStore';
import { ChatStore } from '../store/ChatStore';
import { TaskStore } from '../store/TaskStore';
import { ConnectionGateway } from '../gateway/ConnectionGateway';
import { SessionApi } from '../gateway/SessionApi';
import { UnauthorizedError } from '../gateway/RestClient';
import { BridgeInfo, chatKeyOf, DEFAULT_SESSION_KEY } from '../logic/normalizeEvent';
import { ChatMessage, Session, TaskPhase } from '../model/Protocol';

const DOMAIN = 0x0000;
const TAG = 'SessionRow';

/**
 * Shared row logic for `SessionSidebar` (persistent MEDIUM/EXPANDED column)
 * and `SessionSheet` (COMPACT bottom sheet) — both shells render the exact
 * same `SessionStore` data and must keep agreeing on what a row means (its
 * key, label, current/unread state, and what "select" does). Lives here
 * rather than under `logic/` because most of these functions take a live
 * `SessionStore` instance — several mutate it, and three of them talk to the
 * server — so this isn't a pure, store-independent function set.
 *
 * The pure functions here (plain data in, plain data out, no store:
 * `chatKeyForBridge`, `rowLabel`, `nonResidentSessions`, `activeSessionOf`,
 * `visibleSessions`, `hiddenSessionCount`, `newSessionKey`, `formatUnread`,
 * `formatSessionPhase`, `phaseDisplay`, `latestMessageTimestamp`,
 * `fallbackActivityTimestamp`, `formatTime`) are covered by
 * `SessionRow.test.ets`; the rest are covered by on-device verification of
 * the two shells.
 *
 * A row used to mean "one bridge" (one switchable chat per connection, its
 * `DEFAULT_SESSION_KEY` session) — the `*ForBridge` family. Task 7 added a
 * `*ForSession` set alongside it: a row is now one `Session`
 * (`SessionStore.sessionsOf(connectionId)`), so the same bridge can surface
 * several rows, one per open session.
 *
 * Task 7 expected Task 8 to keep using the whole `*ForBridge` family for the
 * panel's "switch connection" section. Reading web's real
 * `packages/web/src/components/SessionDropdown.tsx` showed otherwise: its
 * connection rows key off the CONNECTION (`conn.id === activeConnectionId`,
 * `conn.name`, unread summed across that connection's chats) and their click
 * handler is `setActiveConnection` ALONE — deliberately, so switching back to
 * a connection returns to the session you left there rather than resetting it
 * to `default`. Routing that click through a `${bridgeId}::default` chatKey,
 * which is all the `*ForBridge` helpers can express, would have silently
 * thrown that pointer away on every connection switch. So the four
 * chatKey-shaped bridge helpers (`labelForBridge`, `isCurrentBridge`,
 * `unreadForBridge`, `selectBridge`) are replaced below by the
 * connection-shaped `isActiveConnection`/`unreadForConnection`/
 * `selectConnection`. `chatKeyForBridge` stays: `Index.ets` still uses it for
 * the cold-start landing pick, which genuinely does mean "that bridge's
 * default session".
 *
 * `DEFAULT_SESSION_KEY` is imported, not declared: `pages/Index.ets` used to
 * declare its own copy of the same constant alongside its own copy of the
 * label rule, so it now lives once, next to `chatKeyOf`/`splitChatKey` in
 * `logic/normalizeEvent.ets`.
 */

export function chatKeyForBridge(bridge: BridgeInfo): string {
  return chatKeyOf(bridge.id, DEFAULT_SESSION_KEY);
}

// ---------------------------------------------------------------------
// One row per connection — the panel's "switch connection" section.
// ---------------------------------------------------------------------

export function isActiveConnection(store: SessionStore, bridge: BridgeInfo): boolean {
  return bridge.id === store.activeConnectionId();
}

/**
 * Every unread message under a connection, not just its `default` session's.
 *
 * Web sums its flat `unread` map by chatKey prefix
 * (`unreadByConnection` in `SessionDropdown.tsx`); `SessionStore.unread` is
 * private with per-key lookups only, so this sums over that connection's
 * known sessions instead. Same number whenever the session list is known,
 * which is the only time a connection row can be on screen at all.
 */
export function unreadForConnection(store: SessionStore, bridge: BridgeInfo): number {
  let total: number = 0;
  for (const session of store.sessionsOf(bridge.id)) {
    total += unreadForSession(store, session);
  }
  return total;
}

/**
 * Switches the connection and NOTHING else — no session pick, no unread
 * clear. Mirrors web's `handleSwitchConnection`, and the omission is the
 * point: `SessionStore.setActiveConnection` recomputes `currentChatKey` from
 * the session pointer that connection already had
 * (`activeSessionKeyOf`), so the user lands back in the conversation they
 * left there.
 */
export function selectConnection(store: SessionStore, bridge: BridgeInfo): void {
  store.setActiveConnection(bridge.id);
}

// ---------------------------------------------------------------------
// One row per session (Task 7). `SessionStore.sessionsOf(connectionId)`
// is the enumerable list these functions walk, already sorted
// newest-active-first by `sortSessions` — none of the functions below
// re-sort.
// ---------------------------------------------------------------------

export function chatKeyForSession(session: Session): string {
  return chatKeyOf(session.connectionId, session.key);
}

/**
 * What a session row is LABELLED — web's `sessionLabelText`, rule for rule:
 * the server's own `Session.label`, else the last `:`-separated segment of
 * the session key, with a 📌 prefix for the resident session (web applies the
 * pin to every row a resident session could appear in, not just the pinned
 * entry, so it can never render unpinned if it ever reaches the ordinary
 * list).
 *
 * It deliberately does NOT go through `SessionStore.labelOf`, which Task 7's
 * `labelForSession` forwarded to. `labelOf` falls back to the BRIDGE NAME
 * before the session key — correct for the two questions it was written for
 * (a notification title and the top bar, where "this chat" means the
 * connection), and wrong for a list of that connection's sessions: nothing
 * this client creates carries a server label (`SessionApi.create` omits it),
 * so under `labelOf` every row of a connection would read "工作台A" — a list
 * of identical rows, which is precisely the defect this panel exists to fix.
 * Confirmed on the emulator: rows read their real keys ('session-17895…'),
 * while the top bar above them still reads the bridge name. Only the FIRST
 * branch matters for divergence anyway, and it is the same branch:
 * `labelOf`'s server-label case reads `Session.label` off the same record
 * this function does.
 *
 * Pure (no store), so `SessionRow.test.ets` covers it.
 */
export function rowLabel(session: Session): string {
  const label: string = session.label === undefined ? '' : session.label.trim();
  const base: string = label.length > 0 ? label : lastKeySegment(session.key);
  return session.isResident === true ? `📌 ${base}` : base;
}

/** Web's `key.split(":").pop() || key` — a session key may be namespaced. */
function lastKeySegment(key: string): string {
  const segments: string[] = key.split(':');
  const last: string = segments[segments.length - 1];
  return last.length > 0 ? last : key;
}

export function isCurrentSession(store: SessionStore, session: Session): boolean {
  return chatKeyForSession(session) === store.currentChatKey;
}

export function unreadForSession(store: SessionStore, session: Session): number {
  return store.unreadOf(chatKeyForSession(session));
}

/**
 * Web's `formatUnread` — Task 8's review found the `>99 ? '99+' : String(n)`
 * rule inlined once per unread badge across both shells (resident, connection,
 * active and recent rows: eight sites, not the six the badge count alone
 * would suggest, once the connection-row badge is counted too). One place,
 * matching every other display rule `SessionRow.ets` exists to hold.
 */
export function formatUnread(count: number): string {
  return count > 99 ? '99+' : String(count);
}

// ---------------------------------------------------------------------
// Phase dot + phase text — web's `isActivePhaseCss` and `formatSessionPhase`
// (`packages/web/src/components/SessionDropdown.tsx`). Narrowed to the 7
// `TaskPhase` values this client's `TaskStore` can actually hold: web's
// functions also branch on legacy bridge strings ('processing',
// 'waiting_confirm', 'possibly_stuck') that predate the shared `TaskPhase`
// union and never reach this client's store, so those branches have no
// counterpart here.
//
// Web additionally distinguishes a spinning border (thinking/working) from a
// pulsing dot (awaiting_confirmation) from a solid one (stalled/failed) via
// CSS animation classes. This client renders a plain solid `Circle` for all
// of them, like `ConnectionBadge` already does for `ConnectionStore.phase` —
// color and label carry the same information the animation would, and no
// animated dot exists anywhere else in this codebase to make that consistent
// with. If a reviewer wants the spin/pulse restored, `PhaseDisplay` is the
// one place a `spin`/`pulse` flag would need to be added.
// ---------------------------------------------------------------------

const PHASE_COLOR_ACCENT: string = '#0A59F7';
const PHASE_COLOR_AMBER: string = '#F59E0B';
const PHASE_COLOR_RED: string = '#E03131';
/** Web's "text-gray-600" — used both for the default phase text AND the row
 * timestamp text, since both are that exact web class. */
export const ROW_MUTED_TEXT_COLOR: string = '#4B5563';
const PHASE_COLOR_GRAY_DOT: string = '#6B7280';

/** Web's `formatSessionPhase`, minus the legacy-alias branches (see above). */
export function formatSessionPhase(phase: TaskPhase): string {
  if (phase === 'thinking') {
    return '思考中';
  }
  if (phase === 'working') {
    return '处理中';
  }
  if (phase === 'awaiting_confirmation') {
    return '待确认';
  }
  if (phase === 'completed') {
    return '已完成';
  }
  if (phase === 'failed') {
    return '失败';
  }
  if (phase === 'stalled') {
    return '可能卡住';
  }
  return '空闲';
}

/** What `phaseDisplay` hands back — a row's dot color, phase-text color, and label. */
export interface PhaseDisplay {
  dotColor: string;
  textColor: string;
  label: string;
}

/**
 * Web's `isActivePhaseCss` + `formatSessionPhase`, merged into one struct a
 * row needs. `activeAccent` is web's own parameter, true only for the「当前
 * 会话」row so its dot reads accent-blue instead of gray even in the
 * `idle`/`completed` default branch — the branch's TEXT color stays gray
 * either way, matching web's `text: "text-gray-600"` in that same branch.
 */
export function phaseDisplay(phase: TaskPhase, activeAccent: boolean): PhaseDisplay {
  const label: string = formatSessionPhase(phase);
  if (phase === 'thinking' || phase === 'working') {
    return { dotColor: PHASE_COLOR_ACCENT, textColor: PHASE_COLOR_ACCENT, label: label };
  }
  if (phase === 'awaiting_confirmation') {
    return { dotColor: PHASE_COLOR_AMBER, textColor: PHASE_COLOR_AMBER, label: label };
  }
  if (phase === 'stalled') {
    return { dotColor: PHASE_COLOR_AMBER, textColor: PHASE_COLOR_AMBER, label: label };
  }
  if (phase === 'failed') {
    return { dotColor: PHASE_COLOR_RED, textColor: PHASE_COLOR_RED, label: label };
  }
  return {
    dotColor: activeAccent ? PHASE_COLOR_ACCENT : PHASE_COLOR_GRAY_DOT,
    textColor: ROW_MUTED_TEXT_COLOR,
    label: label,
  };
}

/** Store-dependent one-liner pairing `TaskStore.phaseOf` with `phaseDisplay`, same shape as `unreadForSession`. */
export function phaseDisplayForSession(task: TaskStore, session: Session, activeAccent: boolean): PhaseDisplay {
  return phaseDisplay(task.phaseOf(chatKeyForSession(session)), activeAccent);
}

// ---------------------------------------------------------------------
// Last-activity timestamp — web's `lastMessageOrCreatedAt` and `formatTime`
// (same file). Split into two pure halves (`latestMessageTimestamp`,
// `fallbackActivityTimestamp`) plus one store-dependent join
// (`lastActivityOf`), the same pattern `formatUnread`/phase display use.
// ---------------------------------------------------------------------

/** The max `timestamp` in `messages`, or `undefined` for an empty transcript. */
export function latestMessageTimestamp(messages: ChatMessage[]): number | undefined {
  if (messages.length === 0) {
    return undefined;
  }
  let latest: number = messages[0].timestamp;
  for (const message of messages) {
    if (message.timestamp > latest) {
      latest = message.timestamp;
    }
  }
  return latest;
}

/**
 * Web's `session.lastActiveAt ?? session.createdAt` — for a session whose
 * history hasn't been lazy-loaded yet, so `latestMessageTimestamp` above has
 * nothing to work with. Takes `lastActiveAt` as `number | undefined` rather
 * than reading `Session.lastActiveAt` directly: that field's static type is
 * non-optional, but session records here ultimately come from
 * `JSON.parse(...) as Session` (`SessionApi.fetch`), which validates
 * nothing, so a malformed payload could still omit it at runtime. Kept
 * pure and separate from `lastActivityOf` so this fallback rule alone is
 * unit-testable without a live `ChatStore`.
 */
export function fallbackActivityTimestamp(lastActiveAt: number | undefined, createdAt: number): number {
  return lastActiveAt ?? createdAt;
}

/** Store-dependent join of the two pure halves above — what a row's timestamp actually shows. */
export function lastActivityOf(chat: ChatStore, session: Session): number {
  const latest: number | undefined = latestMessageTimestamp(chat.messagesOf(chatKeyForSession(session)));
  if (latest !== undefined) {
    return latest;
  }
  return fallbackActivityTimestamp(session.lastActiveAt, session.createdAt);
}

const DAY_MS: number = 86_400_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Web's `formatTime`, reimplemented without `Intl`/`toLocaleString` — this
 * runtime's ICU support is unverified (see the ArkTS/HarmonyOS gotchas
 * this project has already hit elsewhere), and manual formatting is
 * trivially testable without depending on locale data at all. Output
 * shapes match web's zh-CN formatting exactly (`HH:MM` 24-hour, `M/D` with
 * no year), verified against Node's own `Intl` output while writing this.
 *
 * `now` is a parameter, not `Date.now()` read internally, so this stays a
 * pure function a test can pin — the same reason `newSessionKey` above
 * takes `now` rather than calling `Date.now()` itself.
 */
export function formatTime(ts: number, now: number): string {
  const target: Date = new Date(ts);
  const current: Date = new Date(now);
  const todayStart: Date = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  const yesterdayStart: Date = new Date(todayStart.getTime() - DAY_MS);
  const targetDay: Date = new Date(target.getFullYear(), target.getMonth(), target.getDate());

  if (targetDay.getTime() >= todayStart.getTime()) {
    return `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  }
  if (targetDay.getTime() >= yesterdayStart.getTime()) {
    return '昨天';
  }
  const daysDiff: number = Math.floor((todayStart.getTime() - targetDay.getTime()) / DAY_MS);
  if (daysDiff < 7) {
    return `${daysDiff}天前`;
  }
  return `${target.getMonth() + 1}/${target.getDate()}`;
}

/**
 * Applies the store-side effect of a row tap: switch the active session,
 * and mark it read. Callers add their own shell-specific follow-up at the
 * call site (`SessionSheet.select` additionally closes the sheet, both
 * shells disarm a pending delete) — that difference stays out of this
 * shared helper on purpose.
 *
 * `setCurrent` (rather than `setActiveSession`) is what makes this work for
 * a session on ANOTHER connection too: it writes the session pointer and the
 * active connection together, in that order, so `currentChatKey` is never
 * momentarily pointed at the new connection's previous session. That is what
 * `openResidentSession` below relies on.
 *
 * The history fetch lives HERE, in the shared helper, rather than at each
 * shell's call site the brief suggested: the two shells exist to render the
 * same rows, and a trigger duplicated in both is exactly the drift this file
 * was extracted to stop. It is web's own arrangement too — the loader hangs
 * off `setActiveSession` in the store, not off `SessionDropdown`.
 *
 * `loadHistory` has exactly one `false` caller, `applyCreatedSession` below,
 * and it is a genuine correctness rule rather than an optimisation: a key the
 * client minted a moment ago has no server history, and asking for it would
 * at best waste a round trip and at worst raise `ErrorBanner`'s "history
 * failed" over a session that never had any.
 */
export function selectSession(store: SessionStore, session: Session, loadHistory: boolean = true): void {
  const key: string = chatKeyForSession(session);
  store.setCurrent(key);
  // Switching to a session is how the user acknowledges it — mark it read.
  // `clearUnread` already no-ops for resident sessions (their true count
  // only ever comes from the server via `resident:unread`), so this is
  // safe to call unconditionally.
  store.clearUnread(key);
  if (loadHistory) {
    ConnectionGateway.instance.ensureHistory(key);
  }
}

/**
 * The pinned top entry's tap handler — reachable from ANY connection.
 *
 * Mirrors web's `openResident`, which is not just "select that row": the
 * resident session may live on a connection that isn't the active one, so
 * the tap switches connection AND session (`selectSession` above does both),
 * and then tells the server the session was read. That server call is the
 * only way a resident badge ever clears: `SessionStore.clearUnread` is a
 * deliberate no-op for resident sessions, whose count belongs to the server
 * and comes back over `resident:unread`.
 */
export function openResidentSession(store: SessionStore, resident: Session): void {
  selectSession(store, resident);
  sessionApi().markRead(resident.connectionId, resident.key).catch((err: Error) => {
    // No toast: the user asked to open a chat, not to clear a badge, and
    // nothing here is retryable by hand. The badge simply stays until the
    // next `resident:unread` — same "log it, don't nag" posture web has
    // (`console.error("mark resident read failed:", e)`).
    hilog.error(DOMAIN, TAG, 'markRead failed: connectionId=%{public}s key=%{public}s message=%{public}s',
      resident.connectionId, resident.key, err.message);
  });
}

/** Non-resident sessions only — the resident one has its own pinned entry above the list. */
export function nonResidentSessions(all: Session[]): Session[] {
  return all.filter((candidate: Session): boolean => candidate.isResident !== true);
}

/**
 * The session the "当前会话" row shows, or `undefined` when the active
 * pointer names no listable session (a connection whose list hasn't arrived
 * yet, or one whose active session IS the resident one — web's
 * `currentSession` is looked up in `listSessions` for exactly that reason,
 * so the resident session never renders twice).
 */
export function activeSessionOf(all: Session[], activeKey: string): Session | undefined {
  return nonResidentSessions(all).find((candidate: Session): boolean => candidate.key === activeKey);
}

/**
 * How many rows `visibleSessions` shows before collapsing the rest behind
 * "show more" — mirrors web's `packages/web/src/components/SessionDropdown.tsx`
 * (`RECENT_VISIBLE = 2`). Kept as the same literal value, not derived from
 * anything, so the two clients' collapsed-list depth can't drift apart
 * silently.
 */
export const RECENT_VISIBLE: number = 2;

/**
 * The pure row-list transform behind "最近会话" in both shells.
 *
 * Mirrors web's `SessionDropdown` (`listSessions`/`inactive`/`recentInactive`):
 * the active session gets its own separate "当前会话" row elsewhere, and a
 * resident session gets its own separate pinned entry — `visibleSessions`
 * only computes the everything-else list. `all` is expected to already be
 * `SessionStore.sessionsOf(connectionId)`'s newest-active-first order; this
 * function filters and (unless `showAll`) truncates, it never re-sorts.
 */
export function visibleSessions(all: Session[], activeKey: string, showAll: boolean): Session[] {
  const inactive: Session[] = nonResidentSessions(all).filter((candidate: Session): boolean => {
    return candidate.key !== activeKey;
  });
  if (showAll) {
    return inactive;
  }
  return inactive.slice(0, RECENT_VISIBLE);
}

/**
 * The N in「显示全部（N）」 — how many rows `visibleSessions` is holding back.
 *
 * Clamped at 0, unlike web's raw `inactive.length - RECENT_VISIBLE` (which
 * goes negative and is only ever read behind a `> 0` guard); clamping here
 * means the shells can render the count without repeating that guard twice.
 */
export function hiddenSessionCount(all: Session[], activeKey: string): number {
  const hidden: number = visibleSessions(all, activeKey, true).length - RECENT_VISIBLE;
  return hidden > 0 ? hidden : 0;
}

/** Web's `createSession` key format, verbatim: `session-${Date.now()}`. */
export function newSessionKey(now: number): string {
  return `session-${now}`;
}

/**
 * Everything web's `createSession` does AFTER its `POST /api/sessions`
 * resolves, in web's order (`packages/web/src/components/SessionDropdown.tsx`).
 * Split out from `createAndSelectSession` below so the four store effects are
 * unit-testable without a server; `now` is a parameter for the same reason
 * `newSessionKey`/`formatTime` take one.
 *
 * The order is load-bearing:
 *
 * 1. **Pin the session being LEFT** if nothing is pinned. Web's own comment:
 *    anything still in flight belongs to the session the user is leaving, and
 *    sticky is only written by an outgoing send or a keyed reply — so it can
 *    legitimately be empty (e.g. right after a cold start while a turn from
 *    before it is still unfinished). Without this pin, a keyless reply landing
 *    after the switch follows the ACTIVE pointer straight into the session
 *    created on the next line. This is the sixth of web's six sticky writers
 *    and the last one this client was missing.
 *    `activeSessionKeyRawOf` (not `activeSessionKeyOf`) because web reads the
 *    raw map: a connection the user has never picked a session on must pin
 *    nothing, not `'default'`.
 * 2. **Clear the new key's residue** BEFORE it becomes the active session, so
 *    nothing from another conversation is ever on screen under it — see
 *    `ConnectionGateway.resetSessionResidue`, including why the outbox is
 *    left alone.
 * 3. Seed the record locally rather than waiting for the server's copy: it
 *    arrives with the next `/api/sessions` fetch, and `upsertSession` is
 *    keyed on the same chatKey, so that later copy replaces this one instead
 *    of doubling it. Same fields web seeds.
 * 4. Select it WITHOUT a history fetch — see `selectSession`'s `loadHistory`.
 */
export function applyCreatedSession(
  store: SessionStore,
  connectionId: string,
  key: string,
  now: number,
): void {
  const leavingKey: string = store.activeSessionKeyRawOf(connectionId);
  if (leavingKey.length > 0 && leavingKey !== key && store.stickySessionOf(connectionId).length === 0) {
    store.noteStickySession(connectionId, leavingKey);
  }
  ConnectionGateway.instance.resetSessionResidue(connectionId, key);
  const created: Session = { key: key, connectionId: connectionId, createdAt: now, lastActiveAt: now };
  store.upsertSession(created);
  selectSession(store, created, false);
}

/**
 * `POST /api/sessions`, then show the new session — resolves `true` only if
 * the server actually created it (the shells close the sheet on `true`, the
 * same way web only closes its dropdown after the awaited POST resolves).
 *
 * The local half is `applyCreatedSession` above, which is where the two
 * behaviours Task 8 deferred to Task 9 (residue clearing, pinning the session
 * being left) now live.
 */
export async function createAndSelectSession(store: SessionStore, connectionId: string): Promise<boolean> {
  if (connectionId.length === 0) {
    return false;
  }
  const key: string = newSessionKey(Date.now());
  try {
    await sessionApi().create(connectionId, key);
  } catch (err) {
    reportSessionApiFailure('新建会话', err as Error);
    return false;
  }
  applyCreatedSession(store, connectionId, key, Date.now());
  return true;
}

/**
 * Deletes a session on the server and drops it locally.
 *
 * Local removal is NOT awaited on the server's answer — same optimistic order
 * as web (which fires the DELETE and calls `removeSession` on the next line,
 * never reading the promise). The list stays honest anyway: a refused or
 * failed delete leaves the server's copy in place, and the next
 * `/api/sessions` fetch puts the row back. A failure is still surfaced (web
 * only `console.error`s it) because on a phone there is no console to read.
 *
 * `SessionApi.remove` treats the server's 403 for a resident session as an
 * expected refusal rather than a network fault; no delete control is rendered
 * for a resident session in the first place, so reaching that is a bug, not a
 * user action.
 */
export function deleteSession(store: SessionStore, connectionId: string, sessionKey: string): void {
  sessionApi().remove(connectionId, sessionKey).catch((err: Error) => {
    reportSessionApiFailure('删除会话', err);
  });
  store.removeSession(connectionId, sessionKey);
}

/**
 * The two-tap delete rule, in ONE place: returns the armed key the caller
 * should now hold. First tap on a row arms it (returns that row's key, which
 * flips its control to「确认删除」); a second tap on the SAME row deletes and
 * disarms.
 *
 * It performs the delete rather than only deciding, so neither shell can
 * implement half the rule. The shells own the armed key itself — it is
 * per-panel `@Local` UI state, and each shell must also disarm it on the
 * events this function never sees: switching session, switching connection,
 * and closing the panel.
 */
export function applyDeleteTap(
  store: SessionStore,
  connectionId: string,
  sessionKey: string,
  armedKey: string,
): string {
  if (armedKey !== sessionKey) {
    return sessionKey;
  }
  deleteSession(store, connectionId, sessionKey);
  return '';
}

/**
 * Built per call, like every other `SessionApi`/`RestClient` construction in
 * this codebase (`ConnectionGateway.fetchSessions`, `MessageInput.toggleBridge`)
 * — the credentials are read from `AuthStore` at the moment of the call, so a
 * re-login can't leave a panel holding a dead token.
 */
function sessionApi(): SessionApi {
  const auth: AuthStore = AuthStore.connect();
  return new SessionApi(auth.baseUrl, auth.token);
}

/**
 * One failure posture for all three of this panel's server calls, matching
 * `MessageInput.toggleBridge` exactly: log via `hilog`, tell the user via a
 * toast, and on a 401 clear the token and stop the gateway so they land back
 * on `LoginGate` instead of retrying against a token that can never succeed.
 */
function reportSessionApiFailure(action: string, err: Error): void {
  if (err instanceof UnauthorizedError) {
    hilog.error(DOMAIN, TAG, '%{public}s unauthorized', action);
    promptAction.showToast({ message: `${action}失败：登录已过期` });
    AuthStore.connect().clear();
    ConnectionGateway.instance.stop();
    return;
  }
  hilog.error(DOMAIN, TAG, '%{public}s failed: message=%{public}s', action, err.message);
  promptAction.showToast({ message: `${action}失败，请检查网络` });
}
