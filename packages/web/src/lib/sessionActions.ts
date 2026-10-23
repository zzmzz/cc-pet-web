import { makeChatKey, WS_EVENTS } from "@cc-pet/shared";
import type { ChatMessage, Session } from "@cc-pet/shared";
import { getPlatform } from "./platform.js";
import { useMessageStore } from "./store/message.js";
import { useSessionStore } from "./store/session.js";
import { useUIStore } from "./store/ui.js";

/** Relative time for a session list row: 14:05 / 昨天 / 3天前 / 10/2. */
export function formatSessionTime(ts: number): string {
  const now = new Date();
  const target = new Date(ts);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());

  if (targetDay.getTime() >= todayStart.getTime()) {
    return target.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  if (targetDay.getTime() >= yesterdayStart.getTime()) return "昨天";
  const daysDiff = Math.floor((todayStart.getTime() - targetDay.getTime()) / 86_400_000);
  if (daysDiff < 7) return `${daysDiff}天前`;
  return target.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function formatUnread(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** Session title without decorations: its label, else the last segment of its key. */
export function sessionBaseLabel(s: Session): string {
  return s.label?.trim() || s.key.split(":").pop() || s.key;
}

/** Shown next to session title: last message time, not “last opened”. */
export function sessionLastActivity(
  connectionId: string,
  session: Session,
  messagesByChat: Record<string, ChatMessage[]>,
): number {
  const msgs = messagesByChat[makeChatKey(connectionId, session.key)] ?? [];
  if (msgs.length > 0) return Math.max(...msgs.map((m) => m.timestamp));
  // For sessions whose history hasn't been lazy-loaded yet, fall back to
  // the server-maintained lastActiveAt instead of createdAt.
  return session.lastActiveAt ?? session.createdAt;
}

/** Clear a session's unread count locally and on the server. */
export function markSessionRead(connectionId: string, key: string): void {
  useSessionStore.getState().clearSessionUnread(connectionId, key);
  void getPlatform()
    .fetchApi(`/api/sessions/${encodeURIComponent(connectionId)}/${encodeURIComponent(key)}/read`, { method: "POST" })
    .catch((e) => console.error("mark session read failed:", e));
}

/**
 * Create a session on the server, add it to the store and focus it.
 * Returns false (and leaves the store alone) when the request fails.
 */
export async function createSession(connectionId: string, key: string, label?: string): Promise<boolean> {
  try {
    await getPlatform().fetchApi("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ connectionId, key, label }),
    });
  } catch (e) {
    console.error("create session failed:", e);
    return false;
  }
  const sessionStore = useSessionStore.getState();

  // Anything still in flight belongs to the session the user is leaving.
  // Without this, a keyless reply arriving after the switch would follow
  // the active-session pointer straight into the new session (sticky is
  // only set by an outgoing send or a keyed reply, so it can be empty —
  // e.g. right after a reload while a turn from before it is unfinished).
  const leavingKey = sessionStore.activeSessionKey[connectionId];
  if (leavingKey && leavingKey !== key && !sessionStore.stickySessionByConnection[connectionId]) {
    sessionStore.noteStickySession(connectionId, leavingKey);
  }

  // A brand-new key has no server history, so any client-side state under
  // it is residue from another conversation — drop it before we focus it.
  sessionStore.resetSessionResidue(connectionId, key);

  const list = useSessionStore.getState().sessions[connectionId] ?? [];
  const now = Date.now();
  sessionStore.setSessions(connectionId, [
    ...list,
    { key, connectionId, createdAt: now, lastActiveAt: now, ...(label ? { label } : {}) },
  ]);
  sessionStore.setActiveSession(connectionId, key);
  useUIStore.getState().resetComposer();
  return true;
}

/** Send a plain text message as the user, exactly like typing it into the composer. */
export function sendTextMessage(connectionId: string, sessionKey: string, text: string): void {
  const clientMsgId = getPlatform().sendWsMessage({
    type: WS_EVENTS.SEND_MESSAGE,
    connectionId,
    sessionKey,
    content: text,
  }, "auto");

  useMessageStore.getState().addMessage(makeChatKey(connectionId, sessionKey), {
    id: clientMsgId,
    role: "user",
    content: text,
    timestamp: Date.now(),
    connectionId,
    sessionKey,
  });
  useSessionStore.getState().touchSessionAutoTitle(connectionId, sessionKey, text);
  useSessionStore.getState().noteStickySession(connectionId, sessionKey);
}
