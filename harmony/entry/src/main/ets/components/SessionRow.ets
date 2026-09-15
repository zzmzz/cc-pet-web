import { SessionStore } from '../store/SessionStore';
import { BridgeInfo, chatKeyOf, DEFAULT_SESSION_KEY } from '../logic/normalizeEvent';

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
 * `unreadForBridge`/`selectBridge` take a live `SessionStore` instance —
 * `selectBridge` mutates it — so this isn't a pure, store-independent
 * function set.
 *
 * `chatKeyForBridge` is the one genuinely pure function here (`BridgeInfo`
 * in, `string` out, no store) and is covered by `SessionRow.test.ets`.
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
