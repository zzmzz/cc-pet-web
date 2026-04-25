import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReplyCollector } from "./reply-collector.js";

describe("ReplyCollector", () => {
  let collector: ReplyCollector;

  beforeEach(() => {
    vi.useFakeTimers();
    collector = new ReplyCollector();
  });

  afterEach(() => {
    collector.dispose();
    vi.useRealTimers();
  });

  it("creates a collector and polls waiting status", () => {
    const msgId = collector.create("conn1", "session1");
    const result = collector.poll(msgId);
    expect(result).toEqual({ status: "waiting" });
  });

  it("returns null for unknown msgId", () => {
    expect(collector.poll("unknown")).toBeNull();
  });

  it("tracks streaming deltas", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onDelta("conn1", "session1", "你好");
    const result = collector.poll(msgId);
    expect(result?.status).toBe("streaming");
  });

  it("completes with full text and generates ttsText", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onDelta("conn1", "session1", "你好世界");
    collector.onDone("conn1", "session1", "你好世界");
    const result = collector.poll(msgId);
    expect(result?.status).toBe("done");
    expect(result?.ttsText).toBe("你好世界");
  });

  it("uses fullText from onDone over accumulated deltas", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onDelta("conn1", "session1", "partial");
    collector.onDone("conn1", "session1", "完整回复文本");
    const result = collector.poll(msgId);
    expect(result?.ttsText).toBe("完整回复文本");
  });

  it("sanitizes ttsText (removes code blocks)", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onDone("conn1", "session1", "结果：\n```js\ncode\n```\n完成");
    const result = collector.poll(msgId);
    expect(result?.ttsText).not.toContain("```");
    expect(result?.ttsText).toContain("代码已省略");
  });

  it("rejects duplicate session with active collector", () => {
    collector.create("conn1", "session1");
    expect(() => collector.create("conn1", "session1")).toThrow();
  });

  it("times out after 120 seconds", () => {
    const msgId = collector.create("conn1", "session1");
    vi.advanceTimersByTime(120_000);
    const result = collector.poll(msgId);
    expect(result?.status).toBe("error");
    expect(result?.ttsText).toContain("超时");
  });

  it("cleans up 60 seconds after done", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onDone("conn1", "session1", "完成");
    vi.advanceTimersByTime(60_000);
    expect(collector.poll(msgId)).toBeNull();
  });

  it("cleans up 60 seconds after error/timeout", () => {
    const msgId = collector.create("conn1", "session1");
    vi.advanceTimersByTime(120_000); // timeout
    vi.advanceTimersByTime(60_000); // cleanup
    expect(collector.poll(msgId)).toBeNull();
  });

  it("reports activeCount", () => {
    expect(collector.activeCount).toBe(0);
    collector.create("conn1", "s1");
    expect(collector.activeCount).toBe(1);
    collector.create("conn1", "s2");
    expect(collector.activeCount).toBe(2);
  });

  it("onReply completes immediately for non-streaming replies", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onReply("conn1", "session1", "直接回复");
    const result = collector.poll(msgId);
    expect(result?.status).toBe("done");
    expect(result?.ttsText).toBe("直接回复");
  });

  it("ignores events for sessions without active collector", () => {
    collector.onDelta("conn1", "no-session", "data");
    collector.onDone("conn1", "no-session", "data");
    collector.onReply("conn1", "no-session", "data");
    // no error thrown
  });
});
