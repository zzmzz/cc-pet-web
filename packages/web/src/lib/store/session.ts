import { create } from "zustand";
import type { Session } from "@cc-pet/shared";

interface SessionState {
  sessions: Record<string, Session[]>;
  activeSessionKey: Record<string, string>;
  unread: Record<string, number>;

  setSessions: (connectionId: string, sessions: Session[]) => void;
  setActiveSession: (connectionId: string, key: string) => void;
  incrementUnread: (chatKey: string) => void;
  clearUnread: (chatKey: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
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
    set((s) => ({ unread: { ...s.unread, [chatKey]: 0 } })),
}));
