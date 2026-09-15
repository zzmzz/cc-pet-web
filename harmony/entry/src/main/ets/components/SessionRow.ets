import { SessionStore } from '../store/SessionStore';
import { BridgeInfo, chatKeyOf } from '../logic/normalizeEvent';

/**
 * Every bridge advertised by `bridge:manifest` exposes exactly one
 * switchable chat at this stage of the protocol — its 'default' session
 * key. `SessionStore.sessions` (richer, server-labelled `Session` records)
 * has no public iteration accessor — only per-key lookups (`labelOf`,
 * `unreadOf`, `isResident`) — so `bridges` is the enumerable list
 * `SessionSidebar`/`SessionSheet` switch between; `labelForBridge` below
 * upgrades to the server-provided label once one exists for a key.
 */
const DEFAULT_SESSION_KEY: string = 'default';

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

export function labelForBridge(session: SessionStore, bridge: BridgeInfo): string {
  const key: string = chatKeyForBridge(bridge);
  const label: string = session.labelOf(key);
  return label === key ? bridge.name : label;
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
