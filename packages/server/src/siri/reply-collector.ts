import { sanitizeForTts } from "./tts-sanitizer.js";

type CollectorStatus = "waiting" | "streaming" | "done" | "error";

interface CollectorEntry {
  msgId: string;
  connectionId: string;
  sessionKey: string;
  status: CollectorStatus;
  deltas: string[];
  rawText?: string;
  ttsText?: string;
  rawLength?: number;
  truncated?: boolean;
  timeoutTimer: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface PollResult {
  status: CollectorStatus;
  ttsText?: string;
  rawLength?: number;
  truncated?: boolean;
}

export class ReplyCollector {
  private byMsgId = new Map<string, CollectorEntry>();
  private bySession = new Map<string, CollectorEntry>();

  get activeCount(): number {
    return this.byMsgId.size;
  }

  create(connectionId: string, sessionKey: string): string {
    const sessionId = `${connectionId}::${sessionKey}`;
    if (this.bySession.has(sessionId)) {
      const existing = this.bySession.get(sessionId)!;
      if (existing.status === "waiting" || existing.status === "streaming") {
        throw new Error(`Session ${sessionId} already has an active collector`);
      }
    }

    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const entry: CollectorEntry = {
      msgId,
      connectionId,
      sessionKey,
      status: "waiting",
      deltas: [],
      timeoutTimer: setTimeout(() => this.markError(msgId, "回复超时"), 120_000),
    };

    this.byMsgId.set(msgId, entry);
    this.bySession.set(sessionId, entry);
    return msgId;
  }

  poll(msgId: string): PollResult | null {
    const entry = this.byMsgId.get(msgId);
    if (!entry) return null;
    return {
      status: entry.status,
      ttsText: entry.ttsText,
      rawLength: entry.rawLength,
      truncated: entry.truncated,
    };
  }

  onDelta(connectionId: string, sessionKey: string, delta: string): void {
    const entry = this.bySession.get(`${connectionId}::${sessionKey}`);
    if (!entry || entry.status === "done" || entry.status === "error") return;
    entry.deltas.push(delta);
    entry.status = "streaming";
  }

  onDone(connectionId: string, sessionKey: string, fullText?: string): void {
    const entry = this.bySession.get(`${connectionId}::${sessionKey}`);
    if (!entry || entry.status === "done" || entry.status === "error") return;
    const raw = fullText || entry.deltas.join("");
    this.finalize(entry, raw);
  }

  onReply(connectionId: string, sessionKey: string, content: string): void {
    const entry = this.bySession.get(`${connectionId}::${sessionKey}`);
    if (!entry || entry.status === "done" || entry.status === "error") return;
    this.finalize(entry, content);
  }

  dispose(): void {
    for (const entry of this.byMsgId.values()) {
      clearTimeout(entry.timeoutTimer);
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    }
    this.byMsgId.clear();
    this.bySession.clear();
  }

  private finalize(entry: CollectorEntry, rawText: string): void {
    clearTimeout(entry.timeoutTimer);
    entry.status = "done";
    entry.rawText = rawText;
    entry.rawLength = rawText.length;
    entry.ttsText = sanitizeForTts(rawText);
    entry.truncated = entry.ttsText !== rawText;
    this.scheduleCleanup(entry);
  }

  private markError(msgId: string, message: string): void {
    const entry = this.byMsgId.get(msgId);
    if (!entry || entry.status === "done" || entry.status === "error") return;
    entry.status = "error";
    entry.ttsText = message;
    this.scheduleCleanup(entry);
  }

  private scheduleCleanup(entry: CollectorEntry): void {
    entry.cleanupTimer = setTimeout(() => {
      this.byMsgId.delete(entry.msgId);
      this.bySession.delete(`${entry.connectionId}::${entry.sessionKey}`);
    }, 60_000);
  }
}
