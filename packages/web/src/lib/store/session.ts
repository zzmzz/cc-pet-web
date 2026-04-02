import { create } from "zustand";
import { makeChatKey } from "@cc-pet/shared";
import type { Session, SessionTaskState, TaskPhase } from "@cc-pet/shared";
import { useMessageStore } from "./message.js";
import { useUIStore } from "./ui.js";

const ACTIVE_SESSION_STORAGE_KEY = "cc-pet-active-session-map";
const TASK_STATE_STORAGE_KEY = "cc-pet-task-state";

/** Max age (ms) for a persisted task state entry to be considered valid after reload. */
export const TASK_STATE_STALE_MS = 5 * 60 * 1000;

function readPersistedActiveSessionMap(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) {
        result[k] = v;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function persistActiveSessionMap(activeSessionKey: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(activeSessionKey));
  } catch {
    // Ignore storage errors; state still works in memory.
  }
}

function isValidTaskState(v: unknown): v is SessionTaskState {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.phase === "string" && typeof obj.lastActivityAt === "number";
}

function readPersistedTaskState(): Record<string, Record<string, SessionTaskState>> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(TASK_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const now = Date.now();
    const result: Record<string, Record<string, SessionTaskState>> = {};
    for (const [connId, sessions] of Object.entries(parsed as Record<string, unknown>)) {
      if (!sessions || typeof sessions !== "object") continue;
      const validSessions: Record<string, SessionTaskState> = {};
      for (const [sessKey, task] of Object.entries(sessions as Record<string, unknown>)) {
        if (!isValidTaskState(task)) continue;
        if (task.phase === "idle" || task.phase === "completed" || task.phase === "failed") continue;
        if (task.lastActivityAt != null && now - task.lastActivityAt > TASK_STATE_STALE_MS) continue;
        validSessions[sessKey] = task;
      }
      if (Object.keys(validSessions).length > 0) {
        result[connId] = validSessions;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function persistTaskState(taskState: Record<string, Record<string, SessionTaskState>>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(TASK_STATE_STORAGE_KEY, JSON.stringify(taskState));
  } catch {
    // Ignore storage errors; state still works in memory.
  }
}

function hasAnyUnread(unread: Record<string, number>): boolean {
  return Object.values(unread).some((n) => (n ?? 0) > 0);
}

function hasProcessingSessions(
  taskStateByConnection: Record<string, Record<string, SessionTaskState>>,
): boolean {
  return Object.values(taskStateByConnection).some((sessions) =>
    Object.values(sessions).some((task) => task.phase === "working" || task.phase === "processing"),
  );
}

function maybeAdjustPetWhenUnreadCleared(
  unread: Record<string, number>,
  taskStateByConnection: Record<string, Record<string, SessionTaskState>>,
): void {
  if (hasAnyUnread(unread)) return;
  if (hasProcessingSessions(taskStateByConnection)) {
    useUIStore.getState().setPetState("thinking");
    return;
  }
  if (useUIStore.getState().petState === "talking") {
    useUIStore.getState().setPetState("idle");
  }
}

/** Auto session title from first user message: max length before ellipsis. */
export const AUTO_SESSION_TITLE_MAX_LEN = 15;

const DEFAULT_SESSION_TASK_STATE: SessionTaskState = {
  activeRequestId: null,
  phase: "idle",
  startedAt: null,
  lastActivityAt: null,
  firstTokenAt: null,
  stalledReason: null,
};

interface SessionState {
  sessions: Record<string, Session[]>;
  activeSessionKey: Record<string, string>;
  unread: Record<string, number>;
  /** Per-connection session task state for dropdown labels and task lifecycle. */
  taskStateByConnection: Record<string, Record<string, SessionTaskState>>;

  setSessions: (connectionId: string, sessions: Session[]) => void;
  setActiveSession: (connectionId: string, key: string) => void;
  setSessionTaskState: (connectionId: string, sessionKey: string, taskState: SessionTaskState) => void;
  patchSessionTaskState: (
    connectionId: string,
    sessionKey: string,
    partial: Partial<SessionTaskState>,
  ) => void;
  clearSessionTaskState: (connectionId: string, sessionKey: string) => void;
  /** Backward-compatible setter for phase-only callers. */
  setSessionTaskPhase: (connectionId: string, sessionKey: string, phase: TaskPhase) => void;
  touchSessionLastActive: (connectionId: string, sessionKey: string) => void;
  incrementUnread: (chatKey: string) => void;
  clearUnread: (chatKey: string) => void;
  clearSessionUnread: (connectionId: string, sessionKey: string) => void;
  /** True if any chatKey has unread count > 0. */
  hasAnyUnread: () => boolean;
  /** True if any session is in processing/working phase. */
  hasProcessingSessions: () => boolean;
  removeSession: (connectionId: string, sessionKey: string) => void;
  /** First non-empty user message (trimmed, first N chars) becomes label when title still default. */
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
  activeSessionKey: readPersistedActiveSessionMap(),
  unread: {},
  taskStateByConnection: readPersistedTaskState(),

  setSessions: (connectionId, sessions) =>
    set((s) => ({ sessions: { ...s.sessions, [connectionId]: sessions } })),
  setActiveSession: (connectionId, key) =>
    set((s) => {
      const next = { ...s.activeSessionKey, [connectionId]: key };
      persistActiveSessionMap(next);
      return { activeSessionKey: next };
    }),
  setSessionTaskState: (connectionId, sessionKey, taskState) =>
    set((s) => {
      const prevConn = s.taskStateByConnection[connectionId] ?? {};
      const next = {
        ...s.taskStateByConnection,
        [connectionId]: { ...prevConn, [sessionKey]: taskState },
      };
      persistTaskState(next);
      return { taskStateByConnection: next };
    }),
  patchSessionTaskState: (connectionId, sessionKey, partial) =>
    set((s) => {
      const prevConn = s.taskStateByConnection[connectionId] ?? {};
      const prevTask = prevConn[sessionKey] ?? DEFAULT_SESSION_TASK_STATE;
      const next = {
        ...s.taskStateByConnection,
        [connectionId]: { ...prevConn, [sessionKey]: { ...prevTask, ...partial } },
      };
      persistTaskState(next);
      return { taskStateByConnection: next };
    }),
  clearSessionTaskState: (connectionId, sessionKey) =>
    set((s) => {
      const prevConn = s.taskStateByConnection[connectionId];
      if (!prevConn || !prevConn[sessionKey]) return s;
      const { [sessionKey]: _removedTask, ...restTasks } = prevConn;
      const nextByConnection = { ...s.taskStateByConnection };
      if (Object.keys(restTasks).length === 0) {
        delete nextByConnection[connectionId];
      } else {
        nextByConnection[connectionId] = restTasks;
      }
      persistTaskState(nextByConnection);
      return { taskStateByConnection: nextByConnection };
    }),
  setSessionTaskPhase: (connectionId, sessionKey, phase) =>
    set((s) => {
      const prevConn = s.taskStateByConnection[connectionId] ?? {};
      const prevTask = prevConn[sessionKey] ?? DEFAULT_SESSION_TASK_STATE;
      const next = {
        ...s.taskStateByConnection,
        [connectionId]: {
          ...prevConn,
          [sessionKey]: {
            ...prevTask,
            phase,
            lastActivityAt: Date.now(),
            activeRequestId:
              phase === "completed" || phase === "failed" || phase === "idle" ? null : prevTask.activeRequestId,
          },
        },
      };
      persistTaskState(next);
      return { taskStateByConnection: next };
    }),
  touchSessionLastActive: (connectionId, sessionKey) =>
    set((s) => {
      const list = s.sessions[connectionId] ?? [];
      const idx = list.findIndex((x) => x.key === sessionKey);
      if (idx === -1) return s;
      const now = Date.now();
      const next = [...list];
      next[idx] = { ...next[idx], lastActiveAt: now };
      return { sessions: { ...s.sessions, [connectionId]: next } };
    }),
  incrementUnread: (chatKey) => {
    set((s) => ({ unread: { ...s.unread, [chatKey]: (s.unread[chatKey] ?? 0) + 1 } }));
    const processing = get().hasProcessingSessions();
    useUIStore.getState().setPetState(processing ? "thinking" : "talking");
  },
  clearUnread: (chatKey) =>
    set((s) => {
      const nextUnread = { ...s.unread, [chatKey]: 0 };
      maybeAdjustPetWhenUnreadCleared(nextUnread, s.taskStateByConnection);
      return { unread: nextUnread };
    }),
  clearSessionUnread: (connectionId, sessionKey) => {
    get().clearUnread(makeChatKey(connectionId, sessionKey));
  },
  hasAnyUnread: () => hasAnyUnread(get().unread),
  hasProcessingSessions: () => hasProcessingSessions(get().taskStateByConnection),
  removeSession: (connectionId, sessionKey) =>
    set((s) => {
      const chatKey = makeChatKey(connectionId, sessionKey);
      useMessageStore.getState().purgeChat(chatKey);

      const list = s.sessions[connectionId] ?? [];
      const nextList = list.filter((x) => x.key !== sessionKey);
      const { [chatKey]: _removed, ...restUnread } = s.unread;
      const prevTasks = s.taskStateByConnection[connectionId] ?? {};
      const { [sessionKey]: _removedTask, ...restTasks } = prevTasks;
      const nextTaskState = { ...s.taskStateByConnection };
      if (Object.keys(restTasks).length === 0) {
        delete nextTaskState[connectionId];
      } else {
        nextTaskState[connectionId] = restTasks;
      }
      persistTaskState(nextTaskState);
      maybeAdjustPetWhenUnreadCleared(restUnread, nextTaskState);

      const nextActive = { ...s.activeSessionKey };
      if (nextActive[connectionId] === sessionKey) {
        if (nextList[0]?.key) {
          nextActive[connectionId] = nextList[0].key;
        } else {
          delete nextActive[connectionId];
        }
      }
      persistActiveSessionMap(nextActive);

      return {
        sessions: { ...s.sessions, [connectionId]: nextList },
        activeSessionKey: nextActive,
        unread: restUnread,
        taskStateByConnection: nextTaskState,
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

      const title =
        trimmed.length > AUTO_SESSION_TITLE_MAX_LEN
          ? `${trimmed.slice(0, AUTO_SESSION_TITLE_MAX_LEN)}…`
          : trimmed;
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
