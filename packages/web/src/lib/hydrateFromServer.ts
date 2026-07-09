import { makeChatKey } from "@cc-pet/shared";
import type { ChatMessage, Session } from "@cc-pet/shared";
import type { PlatformAPI } from "./platform.js";
import { useConnectionStore } from "./store/connection.js";
import { useMessageStore } from "./store/message.js";
import { useSessionStore } from "./store/session.js";
import { useUIStore } from "./store/ui.js";

/**
 * Choose the default active session for a connection, given the persisted
 * active key (from localStorage) and the server's session list.
 *
 * Preference order:
 *  1. Persisted activeSessionKey, if it still exists in the server list.
 *  2. Session with the largest lastActiveAt.
 *  3. First entry in the list (already sorted by lastActiveAt desc).
 *  4. "default" as final fallback.
 */
function pickActiveSessionKey(
  sessions: Session[],
  persistedActive: string | undefined,
): string {
  if (persistedActive && sessions.some((s) => s.key === persistedActive)) {
    return persistedActive;
  }
  if (sessions.length > 0) {
    return sessions[0].key;
  }
  return "default";
}

/**
 * Pick the connection whose most-recent session is globally newest, used when
 * the previously active connection is no longer present.
 */
function pickGlobalActiveConnection(
  connectionIds: string[],
  sessionsByConnection: Record<string, Session[]>,
): string | null {
  let best: { id: string; ts: number } | null = null;
  for (const cid of connectionIds) {
    const list = sessionsByConnection[cid] ?? [];
    if (list.length === 0) continue;
    const ts = list[0].lastActiveAt;
    if (!best || ts > best.ts) best = { id: cid, ts };
  }
  return best?.id ?? connectionIds[0] ?? null;
}

/**
 * After hydrate, if restored task state shows active processing sessions,
 * ensure petState reflects that (thinking). Otherwise leave it as-is.
 */
function reconcilePetStateWithTaskState(): void {
  if (useSessionStore.getState().hasProcessingSessions()) {
    useUIStore.getState().setPetState("thinking");
  }
}

/**
 * Apply default focus after hydrate. Uses server-provided session.lastActiveAt
 * rather than loaded message timestamps, since most sessions are not loaded yet.
 */
export function applyDefaultFocusAfterHydrate(connectionIds: string[]): void {
  if (connectionIds.length === 0) {
    useConnectionStore.getState().setActiveConnection(null);
    return;
  }
  const sessionStore = useSessionStore.getState();
  for (const cid of connectionIds) {
    const list = sessionStore.sessions[cid] ?? [];
    const persistedActive = sessionStore.activeSessionKey[cid];
    sessionStore.setActiveSession(cid, pickActiveSessionKey(list, persistedActive));
  }
  const activeConnectionId = useConnectionStore.getState().activeConnectionId;
  if (activeConnectionId && connectionIds.includes(activeConnectionId)) {
    useConnectionStore.getState().setActiveConnection(activeConnectionId);
  } else {
    const sessionsByConnection = useSessionStore.getState().sessions;
    useConnectionStore
      .getState()
      .setActiveConnection(pickGlobalActiveConnection(connectionIds, sessionsByConnection));
  }
  reconcilePetStateWithTaskState();
}

/**
 * Fetch and write history for a chatKey, marking it loaded. Concurrent calls for
 * the same chatKey share a single in-flight Promise.
 */
async function fetchAndStoreHistory(
  adapter: PlatformAPI,
  chatKey: string,
): Promise<void> {
  const messageStore = useMessageStore.getState();
  if (messageStore.isChatLoaded(chatKey)) return;
  const histRes = await adapter.fetchApi<{ messages?: ChatMessage[] }>(
    `/api/history/${encodeURIComponent(chatKey)}`,
  );
  const messages = histRes.messages ?? [];
  useMessageStore.getState().setMessages(chatKey, messages);
  useMessageStore.getState().markChatLoaded(chatKey);
  // chatKey format: `${connectionId}::${sessionKey}`
  const sep = chatKey.indexOf("::");
  if (sep > 0) {
    const connectionId = chatKey.slice(0, sep);
    const sessionKey = chatKey.slice(sep + 2);
    useSessionStore
      .getState()
      .syncAutoTitleFromHistoryMessages(connectionId, sessionKey, messages);
  }
}

/**
 * Hydrate sessions list and the currently-active session's history per connection.
 * Other sessions' history is loaded lazily when the user activates them.
 *
 * Registers a lazy-loader on the session store so setActiveSession triggers
 * on-demand fetches automatically.
 */
export async function hydrateSessionsAndHistory(
  adapter: PlatformAPI,
  connectionIds: string[],
): Promise<void> {
  const inFlight = new Map<string, Promise<void>>();
  const lazyLoad = (chatKey: string): Promise<void> => {
    if (useMessageStore.getState().isChatLoaded(chatKey)) return Promise.resolve();
    const existing = inFlight.get(chatKey);
    if (existing) return existing;
    const p = fetchAndStoreHistory(adapter, chatKey).finally(() => {
      inFlight.delete(chatKey);
    });
    inFlight.set(chatKey, p);
    return p;
  };
  useSessionStore.getState().setLazyLoader(lazyLoad);

  for (const connectionId of connectionIds) {
    try {
      const listRes = await adapter.fetchApi<{ sessions?: Session[] }>(
        `/api/sessions?connectionId=${encodeURIComponent(connectionId)}`,
      );
      const apiSessions = listRes.sessions ?? [];

      // Orphan-default fallback: if server has no sessions but a `default`
      // chatKey already has messages (e.g. pre-seeded by tests), synthesize a
      // default session entry so the UI has something to focus.
      const defaultChatKey = makeChatKey(connectionId, "default");
      const preSeededDefault = useMessageStore.getState().messagesByChat[defaultChatKey];
      const hasOrphanDefault =
        apiSessions.length === 0 &&
        Array.isArray(preSeededDefault) &&
        preSeededDefault.length > 0;

      if (apiSessions.length === 0 && !hasOrphanDefault) {
        continue;
      }

      const sessions: Session[] = [...apiSessions];
      if (hasOrphanDefault) {
        const ts = preSeededDefault.map((m) => m.timestamp);
        sessions.push({
          key: "default",
          connectionId,
          createdAt: Math.min(...ts),
          lastActiveAt: Math.max(...ts),
        });
        // Pre-seeded messages count as already loaded.
        useMessageStore.getState().markChatLoaded(defaultChatKey);
      }

      sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      useSessionStore.getState().setSessions(connectionId, sessions);
      for (const sess of sessions) {
        if (sess.isResident && (sess.unreadCount ?? 0) > 0) {
          useSessionStore.getState().setUnread(makeChatKey(connectionId, sess.key), sess.unreadCount ?? 0);
        }
      }

      const persistedActive = useSessionStore.getState().activeSessionKey[connectionId];
      const activeKey = pickActiveSessionKey(sessions, persistedActive);
      const activeChatKey = makeChatKey(connectionId, activeKey);
      await lazyLoad(activeChatKey);
    } catch (e) {
      console.error("hydrate sessions/history failed:", connectionId, e);
    }
  }
}
