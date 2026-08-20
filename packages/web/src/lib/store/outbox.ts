import { create } from "zustand";

export type RetryPolicy = "auto" | "manual" | "never";
export type OutboxStatus = "pending" | "sent" | "failed";

export interface OutboxEntry {
  clientMsgId: string;
  payload: Record<string, unknown>;
  policy: RetryPolicy;
  status: OutboxStatus;
  createdAt: number;
  /** 载荷因过大未被持久化，重载后无法续发，只用于告知用户 */
  payloadDropped?: boolean;
}

export const MANUAL_WINDOW_MS = 120_000;
export const ACK_TIMEOUT_MS = 15_000;
export const PERSIST_MAX_BYTES = 262_144;
export const OUTBOX_STORAGE_KEY = "cc-pet-outbox";

interface OutboxState {
  entries: OutboxEntry[];
  enqueue: (payload: Record<string, unknown>, policy: RetryPolicy) => string;
  markSent: (clientMsgId: string) => void;
  resend: (clientMsgId: string) => void;
  takeSendable: (now?: number) => OutboxEntry[];
  expireStale: (now?: number) => void;
}

function loadPersisted(): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e: OutboxEntry) =>
      // 载荷已丢弃的条目无法续发，保持 failed 让 UI 告知用户重新选择文件
      e.payloadDropped ? e : { ...e, status: "pending" as OutboxStatus }
    );
  } catch {
    return [];
  }
}

function persist(entries: OutboxEntry[]): void {
  const persistable = entries.map((e) =>
    JSON.stringify(e.payload).length > PERSIST_MAX_BYTES
      ? { ...e, payload: {}, status: "failed" as OutboxStatus, payloadDropped: true }
      : e
  );
  try {
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(persistable));
  } catch {
    // 配额不足时放弃持久化，内存队列仍然可用
  }
}

export const useOutboxStore = create<OutboxState>((set, get) => ({
  entries: loadPersisted(),

  enqueue: (payload, policy) => {
    if (policy === "never") return "";
    const clientMsgId = crypto.randomUUID();
    const entry: OutboxEntry = {
      clientMsgId, payload, policy,
      status: "pending", createdAt: Date.now(),
    };
    const entries = [...get().entries, entry];
    set({ entries });
    persist(entries);
    return clientMsgId;
  },

  markSent: (clientMsgId) => {
    // 已确认的消息由服务端历史接管，移除条目避免占用配额
    const entries = get().entries.filter((e) => e.clientMsgId !== clientMsgId);
    set({ entries });
    persist(entries);
  },

  resend: (clientMsgId) => {
    const entries = get().entries.map((e) =>
      // 载荷已丢弃的条目无法续发，重试对它无意义
      e.clientMsgId === clientMsgId && !e.payloadDropped
        ? { ...e, status: "pending" as OutboxStatus, createdAt: Date.now() }
        : e
    );
    set({ entries });
    persist(entries);
  },

  takeSendable: (now = Date.now()) => {
    const entries = get().entries.map((e) => {
      if (e.policy === "manual" && e.status === "pending" && now - e.createdAt > MANUAL_WINDOW_MS) {
        return { ...e, status: "failed" as OutboxStatus };
      }
      return e;
    });
    set({ entries });
    persist(entries);
    return entries.filter((e) => e.status === "pending");
  },

  expireStale: (now = Date.now()) => {
    const entries = get().entries.map((e) =>
      e.status === "pending" && now - e.createdAt > ACK_TIMEOUT_MS
        ? { ...e, status: "failed" as OutboxStatus }
        : e
    );
    set({ entries });
    persist(entries);
  },
}));
