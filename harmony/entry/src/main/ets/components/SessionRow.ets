import { SessionStore } from '../store/SessionStore';
import { BridgeInfo, chatKeyOf, DEFAULT_SESSION_KEY } from '../logic/normalizeEvent';
import { Session } from '../model/Protocol';

/**
 * Every bridge advertised by `bridge:manifest` exposes exactly one
 * switchable chat at this stage of the protocol — its `DEFAULT_SESSION_KEY`
 * session. `SessionStore.sessions` (richer, server-labelled `Session`
 * records) has no public iteration accessor — only per-key lookups
 * (`labelOf`, `unreadOf`, `isResident`) — so `bridges` is the enumerable
 * list `SessionSidebar`/`SessionSheet` switch between.
 *
 * `DEFAULT_SESSION_KEY` is imported, not declared: `pages/Index.ets` used to
 * declare its own copy of the same constant alongside its own copy of the
 * label rule below, so it now lives once, next to `chatKeyOf`/
 * `splitChatKey` in `logic/normalizeEvent.ets`.
 */

/**
 * Shared row logic for `SessionSidebar` (persistent MEDIUM/EXPANDED column)
 * and `SessionSheet` (COMPACT bottom sheet) — both shells render the exact
 * same `SessionStore` data and must keep agreeing on what a row means (its
 * key, label, current/unread state, and what "select" does). Lives here
 * rather than under `logic/` because `labelForBridge`/`isCurrentBridge`/
 * `unreadForBridge`/`selectBridge` (and their `*ForSession` counterparts
 * below) take a live `SessionStore` instance — the `select*` pair mutates
 * it — so this isn't a pure, store-independent function set.
 *
 * `chatKeyForBridge` and `visibleSessions` are the genuinely pure functions
 * here (plain data in, plain data out, no store) and are covered by
 * `SessionRow.test.ets`.
 *
 * A row used to mean "one bridge" (one switchable chat per connection, its
 * `DEFAULT_SESSION_KEY` session) — the `*ForBridge` functions below. Task 7
 * adds a `*ForSession` set alongside them: a row is now one `Session`
 * (`SessionStore.sessionsOf(connectionId)`), so the same bridge can surface
 * several rows, one per open session. The `*ForBridge` functions are kept,
 * not replaced: Task 8 still needs them for the panel's "switch connection"
 * section, which stays per-bridge — a session-list concept has no bearing
 * there.
 */

export function chatKeyForBridge(bridge: BridgeInfo): string {
  return chatKeyOf(bridge.id, DEFAULT_SESSION_KEY);
}

/**
 * Thin forward to `SessionStore.labelOf`, which now owns the bridge-name
 * fallback this function used to apply on its own (see that method's doc).
 * Kept as a named function rather than inlined at the two call sites so the
 * shells keep asking one question — "what is this row called?" — of one
 * place.
 */
export function labelForBridge(session: SessionStore, bridge: BridgeInfo): string {
  return session.labelOf(chatKeyForBridge(bridge));
}

export function isCurrentBridge(session: SessionStore, bridge: BridgeInfo): boolean {
  return chatKeyForBridge(bridge) === session.currentChatKey;
}

export function unreadForBridge(session: SessionStore, bridge: BridgeInfo): number {
  return session.unreadOf(chatKeyForBridge(bridge));
}

/**
 * Applies the store-side effect of a row tap: switch the active session,
 * and mark it read. Callers add their own shell-specific follow-up at the
 * call site (`SessionSheet.select` additionally closes the sheet) — that
 * difference stays out of this shared helper on purpose.
 */
export function selectBridge(session: SessionStore, bridge: BridgeInfo): void {
  const key: string = chatKeyForBridge(bridge);
  session.setCurrent(key);
  // Switching to a session is how the user acknowledges it — mark it read.
  // `clearUnread` already no-ops for resident sessions (their true count
  // only ever comes from the server via `resident:unread`), so this is
  // safe to call unconditionally.
  session.clearUnread(key);
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
 * Thin forward to `SessionStore.labelOf`, which owns the full four-level
 * fallback (server label → bridge name → bare session key → raw chatKey —
 * see that method's doc for what a lock screen rendered before it did).
 * `labelForBridge`'s doc explains why this stays a named forward rather
 * than getting inlined at call sites.
 */
export function labelForSession(store: SessionStore, session: Session): string {
  return store.labelOf(chatKeyForSession(session));
}

export function isCurrentSession(store: SessionStore, session: Session): boolean {
  return chatKeyForSession(session) === store.currentChatKey;
}

export function unreadForSession(store: SessionStore, session: Session): number {
  return store.unreadOf(chatKeyForSession(session));
}

/** Session counterpart of `selectBridge` — same store effects, keyed by session instead of bridge. */
export function selectSession(store: SessionStore, session: Session): void {
  const key: string = chatKeyForSession(session);
  store.setCurrent(key);
  // Same "acknowledged by switching to it" rule as `selectBridge`; see its
  // comment for why `clearUnread` is safe to call unconditionally here too.
  store.clearUnread(key);
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
  const inactive: Session[] = all.filter((candidate: Session): boolean => {
    return candidate.key !== activeKey && candidate.isResident !== true;
  });
  if (showAll) {
    return inactive;
  }
  return inactive.slice(0, RECENT_VISIBLE);
}
