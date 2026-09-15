export type AskTaskStatus = "running" | "done" | "delegated" | "error";

export interface AskTaskView {
  status: AskTaskStatus;
  ttsText?: string;
}

interface AskTaskEntry extends AskTaskView {
  id: string;
  startedAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/** 结果被取走后再留一会儿，容忍快捷指令重复 poll 同一个 id */
const CLEANUP_AFTER_MS = 60_000;
/** 兜底清理：进程长时间跑下来别让 running 的僵尸条目堆积 */
const MAX_AGE_MS = 10 * 60_000;

/**
 * `/api/siri/ask` 的后台任务表。
 *
 * 为什么需要它：iOS 快捷指令的「获取 URL 内容」超过 25 秒就报错，而实测
 * `claude -p` 跑一轮家居查询要 15～25 秒（方差大，最坏已经踩线）。所以 ask
 * 只同步等一小段，没等到就发个 id 让快捷指令来轮询，每个 HTTP 请求都远离
 * 那个 25 秒上限。
 */
export class AskTaskStore {
  private readonly byId = new Map<string, AskTaskEntry>();

  get size(): number {
    return this.byId.size;
  }

  create(): string {
    this.sweep();
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.byId.set(id, { id, status: "running", startedAt: Date.now() });
    return id;
  }

  finish(id: string, status: Exclude<AskTaskStatus, "running">, ttsText: string): void {
    const entry = this.byId.get(id);
    if (!entry || entry.status !== "running") return;
    entry.status = status;
    entry.ttsText = ttsText;
    entry.cleanupTimer = setTimeout(() => this.byId.delete(id), CLEANUP_AFTER_MS);
    // 别让这个定时器把进程钉住
    entry.cleanupTimer.unref?.();
  }

  get(id: string): AskTaskView | null {
    const entry = this.byId.get(id);
    if (!entry) return null;
    return { status: entry.status, ttsText: entry.ttsText };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.byId) {
      if (now - entry.startedAt > MAX_AGE_MS) {
        clearTimeout(entry.cleanupTimer);
        this.byId.delete(id);
      }
    }
  }

  dispose(): void {
    for (const entry of this.byId.values()) clearTimeout(entry.cleanupTimer);
    this.byId.clear();
  }
}
