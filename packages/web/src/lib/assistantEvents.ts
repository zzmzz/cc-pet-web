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

/** Events for one connection that arrive within this long are handled as one refresh. */
export const UPDATE_DEBOUNCE_MS = 300;

/**
 * Collects assistant-session-updated events per connection and calls `flush` once
 * per connection, UPDATE_DEBOUNCE_MS after the last event, with every session key
 * seen in that burst (deduplicated, in arrival order).
 */
export function createAssistantUpdateBatcher(
  flush: (connectionId: string, sessionKeys: string[]) => void,
  delayMs = UPDATE_DEBOUNCE_MS,
): { push: (update: AssistantSessionUpdate) => void; cancel: () => void } {
  const pending = new Map<string, { keys: Set<string>; timer: ReturnType<typeof setTimeout> }>();
  return {
    push({ connectionId, sessionKey }) {
      const entry = pending.get(connectionId);
      const keys = entry?.keys ?? new Set<string>();
      if (entry) clearTimeout(entry.timer);
      keys.add(sessionKey);
      const timer = setTimeout(() => {
        pending.delete(connectionId);
        flush(connectionId, [...keys]);
      }, delayMs);
      pending.set(connectionId, { keys, timer });
    },
    cancel() {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}

/**
 * A session created locally just now may be missing from a list the server built
 * before the create landed; keep such sessions for this long instead of dropping them.
 */
const LOCAL_SESSION_GRACE_MS = 60_000;

const PAGE_LIMIT = 200;
/** Stop paging after this many rounds even if the server keeps saying hasMore. */
const MAX_PAGES = 10;

/**
 * Re-read the connection's session list (a new item session may have appeared) and,
 * for each of these chats that is already loaded, page in whatever arrived after its
 * watermark. A chat that was never loaded fetches its full history when it is opened.
 */
export async function refreshAssistantSession(
  api: Pick<PlatformAPI, "fetchApi">,
  connectionId: string,
  sessionKeys: readonly string[],
): Promise<void> {
  try {
    const res = await api.fetchApi<{ sessions?: Session[] }>(
      `/api/sessions?connectionId=${encodeURIComponent(connectionId)}`,
    );
    if (Array.isArray(res.sessions)) {
      const fromServer = new Set(res.sessions.map((s) => s.key));
      const now = Date.now();
      const localOnly = (useSessionStore.getState().sessions[connectionId] ?? []).filter(
        (s) => !fromServer.has(s.key) && now - s.createdAt < LOCAL_SESSION_GRACE_MS,
      );
      const sessions = [...res.sessions, ...localOnly].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      useSessionStore.getState().setSessions(connectionId, sessions);
    }
  } catch (e) {
    console.warn("[cc-pet] assistant session list refresh failed", e);
  }

  for (const sessionKey of sessionKeys) {
    await pullNewMessages(api, connectionId, sessionKey);
  }
}

async function pullNewMessages(
  api: Pick<PlatformAPI, "fetchApi">,
  connectionId: string,
  sessionKey: string,
): Promise<void> {
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
