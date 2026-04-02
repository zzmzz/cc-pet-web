import { makeChatKey, parseChatKey } from "@cc-pet/shared";
import type { ChatMessage, Session } from "@cc-pet/shared";
import type { PlatformAPI } from "./platform.js";
import { useConnectionStore } from "./store/connection.js";
import { useMessageStore } from "./store/message.js";
import { useSessionStore } from "./store/session.js";

function latestMessageTimestamp(messages: ChatMessage[]): number {
  return Math.max(...messages.map((m) => m.timestamp));
}

/** 该连接下任意 chat 中最新消息时间最晚的 sessionKey；无消息则 null。 */
function pickLatestMessagedSessionForConnection(connectionId: string): string | null {
  const messagesByChat = useMessageStore.getState().messagesByChat;
  const prefix = `${connectionId}::`;
  let bestSession: string | null = null;
  let bestTs = -1;
  for (const [chatKey, messages] of Object.entries(messagesByChat)) {
    if (!chatKey.startsWith(prefix) || !Array.isArray(messages) || messages.length === 0) continue;
    const sessionKey = chatKey.slice(prefix.length);
    const ts = latestMessageTimestamp(messages);
    if (ts > bestTs) {
      bestTs = ts;
      bestSession = sessionKey;
    }
  }
  return bestSession;
}

/** 在若干连接中，全局最新消息所在的 connection + session；无消息则 null。 */
function pickLatestMessagedChat(connectionIds: string[]): { connectionId: string; sessionKey: string } | null {
  const idSet = new Set(connectionIds);
  const messagesByChat = useMessageStore.getState().messagesByChat;
  let best: { connectionId: string; sessionKey: string } | null = null;
  let bestTs = -1;
  for (const [chatKey, messages] of Object.entries(messagesByChat)) {
    if (!Array.isArray(messages) || messages.length === 0) continue;
    let parsed: { connectionId: string; sessionKey: string };
    try {
      parsed = parseChatKey(chatKey);
    } catch {
      continue;
    }
    if (!idSet.has(parsed.connectionId)) continue;
    const ts = latestMessageTimestamp(messages);
    if (ts > bestTs) {
      bestTs = ts;
      best = parsed;
    }
  }
  return best;
}

/**
 * Hydrate 写入消息后：每个连接默认选中「该连接下最后有消息的会话」；
 * 当前展示连接选「全局最新消息」所在连接。
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
    const hasPersistedActive = Boolean(
      persistedActive && list.some((session) => session.key === persistedActive),
    );
    if (hasPersistedActive) {
      sessionStore.setActiveSession(cid, persistedActive as string);
      continue;
    }
    const fromMessages = pickLatestMessagedSessionForConnection(cid);
    sessionStore.setActiveSession(cid, fromMessages ?? list[0]?.key ?? "default");
  }
  const activeConnectionId = useConnectionStore.getState().activeConnectionId;
  if (activeConnectionId && connectionIds.includes(activeConnectionId)) {
    useConnectionStore.getState().setActiveConnection(activeConnectionId);
    return;
  }
  const global = pickLatestMessagedChat(connectionIds);
  useConnectionStore.getState().setActiveConnection(global?.connectionId ?? connectionIds[0] ?? null);
}

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
