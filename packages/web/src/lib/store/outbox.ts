import { create } from "zustand";

export type RetryPolicy = "auto" | "manual" | "never";
export type OutboxStatus = "pending" | "sent" | "failed";

export interface OutboxEntry {
  clientMsgId: string;
  payload: Record<string, unknown>;
  policy: RetryPolicy;
  status: OutboxStatus;
  createdAt: number;
  /**
   * 最近一次真正写入 socket 的时刻，ack 超时预算的起点。
   * 与 createdAt 分开：createdAt 记录用户的发送意图有多旧（manual 档位的时效窗口），
   * 复用同一个字段会让每次重传都把时效窗口顺延，manual 消息永不过期。
   */
  transmittedAt?: number;
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
  /**
   * Restart the ack budget for entries just written to the socket.
   *
   * createdAt is set at enqueue time, but the entry may sit in the queue for
   * minutes while the socket is down. Without this the 15 s ack window would be
   * spent offline and the entry would expire on the first tick after reconnect,
   * before the server had any chance to ack.
   */
  markTransmitted: (clientMsgIds: string[], now?: number) => void;
  expireStale: (now?: number) => void;
  reviveAuto: (now?: number) => void;
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
      // 用户显式重发即重新表达意图，时效窗口与 ack 预算都从头开始
      e.clientMsgId === clientMsgId && !e.payloadDropped
        ? { ...e, status: "pending" as OutboxStatus, createdAt: Date.now(), transmittedAt: undefined }
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

  markTransmitted: (clientMsgIds, now = Date.now()) => {
    if (clientMsgIds.length === 0) return;
    const ids = new Set(clientMsgIds);
    const entries = get().entries.map((e) =>
      // 只重置仍在等待 ack 的条目：已 failed 的条目不能被复活
      ids.has(e.clientMsgId) && e.status === "pending" ? { ...e, transmittedAt: now } : e
    );
    set({ entries });
    persist(entries);
  },

  expireStale: (now = Date.now()) => {
    const entries = get().entries.map((e) =>
      // transmittedAt 未设置说明还没写进 socket：它在等连接，不是在等 ack，不能判超时。
      // 离线期间入队的条目由此免于在重连前就被判失败（manual 档位另有时效窗口兜底）。
      e.status === "pending" && e.transmittedAt !== undefined && now - e.transmittedAt > ACK_TIMEOUT_MS
        ? { ...e, status: "failed" as OutboxStatus }
        : e
    );
    set({ entries });
    persist(entries);
  },

  reviveAuto: (now = Date.now()) => {
    const entries = get().entries.map((e) =>
      // 清掉 transmittedAt，否则复活后会被上一次的 ack 预算立刻重新判失败
      e.policy === "auto" && e.status === "failed" && !e.payloadDropped
        ? { ...e, status: "pending" as OutboxStatus, createdAt: now, transmittedAt: undefined }
        : e
    );
    set({ entries });
    persist(entries);
  },
}));

export function useOutboxEntry(clientMsgId: string): OutboxEntry | undefined {
  return useOutboxStore((s) => s.entries.find((e) => e.clientMsgId === clientMsgId));
}
