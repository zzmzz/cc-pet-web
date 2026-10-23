import { makeChatKey, type ChatMessage, type Session } from "@cc-pet/shared";
import type { PlatformAPI } from "./platform.js";
import { useMessageStore } from "./store/message.js";
import { useSessionStore } from "./store/session.js";

export interface AssistantSessionUpdate {
  connectionId: string;
  sessionKey: string;
}

type Listener = (update: AssistantSessionUpdate) => void;
const listeners = new Set<Listener>();

/** App.tsx calls this when the server says the assistant backend wrote into a session. */
export function emitAssistantSessionUpdated(update: AssistantSessionUpdate): void {
  for (const listener of [...listeners]) {
    try {
      listener(update);
    } catch (e) {
      console.warn("[cc-pet] assistant-session-updated listener failed", e);
    }
  }
}

/** The assistant page listens here; returns the unsubscribe function. */
export function onAssistantSessionUpdated(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const PAGE_LIMIT = 200;
/** Stop paging after this many rounds even if the server keeps saying hasMore. */
const MAX_PAGES = 10;

/**
 * Re-read the connection's session list (a new item session may have appeared) and,
 * if this chat is already loaded, page in whatever arrived after its watermark.
 * A chat that was never loaded fetches its full history when it is opened.
 */
export async function refreshAssistantSession(
  api: Pick<PlatformAPI, "fetchApi">,
  connectionId: string,
  sessionKey: string,
): Promise<void> {
  try {
    const res = await api.fetchApi<{ sessions?: Session[] }>(
      `/api/sessions?connectionId=${encodeURIComponent(connectionId)}`,
    );
    if (Array.isArray(res.sessions)) {
      const sessions = [...res.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      useSessionStore.getState().setSessions(connectionId, sessions);
    }
  } catch (e) {
    console.warn("[cc-pet] assistant session list refresh failed", e);
  }

  const chatKey = makeChatKey(connectionId, sessionKey);
  if (!useMessageStore.getState().isChatLoaded(chatKey)) return;
  for (let page = 0; page < MAX_PAGES; page++) {
    const after = useMessageStore.getState().getWatermark(chatKey);
    let res: { messages?: ChatMessage[]; hasMore?: boolean };
    try {
      res = await api.fetchApi(
        `/api/history/${encodeURIComponent(chatKey)}?afterSeq=${after}&limit=${PAGE_LIMIT}`,
      );
    } catch (e) {
      console.warn("[cc-pet] assistant session history refresh failed", e);
      return;
    }
    const messages = res.messages ?? [];
    if (messages.length === 0) return;
    useMessageStore.getState().mergeMessages(chatKey, messages);
    if (useMessageStore.getState().getWatermark(chatKey) <= after || !res.hasMore) return;
  }
}
