import { makeChatKey } from "@cc-pet/shared";
import type { ChatMessage, Session } from "@cc-pet/shared";
import type { PlatformAPI } from "./platform.js";
import { useMessageStore } from "./store/message.js";
import { useSessionStore } from "./store/session.js";

/**
 * After bridge manifest (connection ids), pull sessions + per-chat history from the server.
 * If the API returns no sessions and no messages under `default`, skips writes so tests (or other code)
 * that pre-seed stores before mount are not cleared.
 */
export async function hydrateSessionsAndHistory(adapter: PlatformAPI, connectionIds: string[]): Promise<void> {
  for (const connectionId of connectionIds) {
    try {
      const listRes = await adapter.fetchApi<{ sessions?: Session[] }>(
        `/api/sessions?connectionId=${encodeURIComponent(connectionId)}`,
      );
      const apiSessions = listRes.sessions ?? [];

      const defaultChatKey = makeChatKey(connectionId, "default");
      const defaultHistRes = await adapter.fetchApi<{ messages?: ChatMessage[] }>(
        `/api/history/${encodeURIComponent(defaultChatKey)}`,
      );
      const defaultMessages = defaultHistRes.messages ?? [];

      const hasOrphanDefault =
        defaultMessages.length > 0 && !apiSessions.some((s) => s.key === "default");

      if (apiSessions.length === 0 && !hasOrphanDefault) {
        continue;
      }

      const sessions: Session[] = [...apiSessions];
      if (hasOrphanDefault) {
        const ts = defaultMessages.map((m) => m.timestamp);
        sessions.push({
          key: "default",
          connectionId,
          createdAt: Math.min(...ts),
          lastActiveAt: Math.max(...ts),
        });
      }

      sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

      const historyCache: Record<string, ChatMessage[]> = { [defaultChatKey]: defaultMessages };

      for (const sess of sessions) {
        const ck = makeChatKey(connectionId, sess.key);
        if (historyCache[ck] === undefined) {
          const histRes = await adapter.fetchApi<{ messages?: ChatMessage[] }>(
            `/api/history/${encodeURIComponent(ck)}`,
          );
          historyCache[ck] = histRes.messages ?? [];
        }
      }

      useSessionStore.getState().setSessions(connectionId, sessions);
      useSessionStore.getState().setActiveSession(connectionId, sessions[0]!.key);

      for (const sess of sessions) {
        const ck = makeChatKey(connectionId, sess.key);
        const msgs = historyCache[ck] ?? [];
        useMessageStore.getState().setMessages(ck, msgs);
        useSessionStore.getState().syncAutoTitleFromHistoryMessages(connectionId, sess.key, msgs);
      }
    } catch (e) {
      console.error("hydrate sessions/history failed:", connectionId, e);
    }
  }
}
