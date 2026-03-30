import { create } from "zustand";
import { makeChatKey } from "@cc-pet/shared";
import type { Session } from "@cc-pet/shared";
import { useMessageStore } from "./message.js";
import { useUIStore } from "./ui.js";

function hasAnyUnread(unread: Record<string, number>): boolean {
  return Object.values(unread).some((n) => (n ?? 0) > 0);
}

function maybeIdlePetWhenNoUnread(unread: Record<string, number>): void {
  if (hasAnyUnread(unread)) return;
  if (useUIStore.getState().petState === "talking") {
    useUIStore.getState().setPetState("idle");
  }
}

interface SessionState {
  sessions: Record<string, Session[]>;
  activeSessionKey: Record<string, string>;
  unread: Record<string, number>;

  setSessions: (connectionId: string, sessions: Session[]) => void;
  setActiveSession: (connectionId: string, key: string) => void;
  incrementUnread: (chatKey: string) => void;
  clearUnread: (chatKey: string) => void;
  clearSessionUnread: (connectionId: string, sessionKey: string) => void;
  removeSession: (connectionId: string, sessionKey: string) => void;
  /** First non-empty user line becomes label when session still shows default title. */
  touchSessionAutoTitle: (connectionId: string, sessionKey: string, userText: string) => void;
  /** Pick first user text from history and apply touchSessionAutoTitle. */
  syncAutoTitleFromHistoryMessages: (
    connectionId: string,
    sessionKey: string,
    messages: Array<{ role: string; content?: string }>,
  ) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: {},
  activeSessionKey: {},
  unread: {},

  setSessions: (connectionId, sessions) =>
    set((s) => ({ sessions: { ...s.sessions, [connectionId]: sessions } })),
  setActiveSession: (connectionId, key) =>
    set((s) => ({ activeSessionKey: { ...s.activeSessionKey, [connectionId]: key } })),
  incrementUnread: (chatKey) =>
    set((s) => ({ unread: { ...s.unread, [chatKey]: (s.unread[chatKey] ?? 0) + 1 } })),
  clearUnread: (chatKey) =>
    set((s) => {
      const nextUnread = { ...s.unread, [chatKey]: 0 };
      maybeIdlePetWhenNoUnread(nextUnread);
      return { unread: nextUnread };
    }),
  clearSessionUnread: (connectionId, sessionKey) => {
    get().clearUnread(makeChatKey(connectionId, sessionKey));
  },
  removeSession: (connectionId, sessionKey) =>
    set((s) => {
      const chatKey = makeChatKey(connectionId, sessionKey);
      useMessageStore.getState().purgeChat(chatKey);

      const list = s.sessions[connectionId] ?? [];
      const nextList = list.filter((x) => x.key !== sessionKey);
      const { [chatKey]: _removed, ...restUnread } = s.unread;
      maybeIdlePetWhenNoUnread(restUnread);

      const nextActive = { ...s.activeSessionKey };
      if (nextActive[connectionId] === sessionKey) {
        if (nextList[0]?.key) {
          nextActive[connectionId] = nextList[0].key;
        } else {
          delete nextActive[connectionId];
        }
      }

      return {
        sessions: { ...s.sessions, [connectionId]: nextList },
        activeSessionKey: nextActive,
        unread: restUnread,
      };
    }),
  touchSessionAutoTitle: (connectionId, sessionKey, userText) =>
    set((s) => {
      const trimmed = userText.trim();
      if (!trimmed) return s;

      const list = s.sessions[connectionId] ?? [];
      const idx = list.findIndex((x) => x.key === sessionKey);
      if (idx === -1) return s;

      const sess = list[idx];
      const current = sess.label?.trim();
      if (current && current !== sess.key) return s;

      const title = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
      const next = [...list];
      next[idx] = { ...sess, label: title };
      return { sessions: { ...s.sessions, [connectionId]: next } };
    }),
  syncAutoTitleFromHistoryMessages: (connectionId, sessionKey, messages) => {
    const first = messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0,
    );
    if (first?.content) {
      get().touchSessionAutoTitle(connectionId, sessionKey, first.content);
    }
  },
}));
