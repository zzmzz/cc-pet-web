import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { revealTypewriter, flushTypewriter, __resetTypewriter } from "./typewriter.js";

describe("revealTypewriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetTypewriter();
  });
  afterEach(() => {
    __resetTypewriter();
    vi.useRealTimers();
  });

  it("reveals text progressively and commits the full text on done", () => {
    const frames: string[] = [];
    const onDone = vi.fn();
    revealTypewriter("c1", "hello world", { onFrame: (t) => frames.push(t), onDone });

    // Not committed yet, and first frame is a strict prefix (partial reveal).
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(frames.length).toBeGreaterThan(0);
    expect("hello world".startsWith(frames[0])).toBe(true);
    expect(frames[0].length).toBeLessThan("hello world".length);

    vi.advanceTimersByTime(1000);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(frames[frames.length - 1]).toBe("hello world");
  });

  it("every emitted frame is a prefix of the full text and they grow monotonically", () => {
    const frames: string[] = [];
    revealTypewriter("c1", "abcdefghijklmnopqrstuvwxyz", { onFrame: (t) => frames.push(t), onDone: () => {} });
    vi.advanceTimersByTime(1000);
    let prev = 0;
    for (const f of frames) {
      expect("abcdefghijklmnopqrstuvwxyz".startsWith(f)).toBe(true);
      expect(f.length).toBeGreaterThanOrEqual(prev);
      prev = f.length;
    }
    expect(frames[frames.length - 1]).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  it("commits instantly (no frames) when disabled", () => {
    const frames: string[] = [];
    const onDone = vi.fn();
    revealTypewriter("c1", "hi", { onFrame: (t) => frames.push(t), onDone }, { enabled: false });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([]);
  });

  it("commits instantly for empty text", () => {
    const onDone = vi.fn();
    const onFrame = vi.fn();
    revealTypewriter("c1", "", { onFrame, onDone });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("a new reveal for the same key flushes the in-flight one first", () => {
    const done1 = vi.fn();
    const done2 = vi.fn();
    const frames: string[] = [];
    revealTypewriter("c1", "first message", { onFrame: (t) => frames.push(t), onDone: done1 });
    vi.advanceTimersByTime(16); // partway through the first reveal

    revealTypewriter("c1", "second", { onFrame: (t) => frames.push(t), onDone: done2 });
    // First reveal is flushed to completion immediately.
    expect(done1).toHaveBeenCalledTimes(1);
    expect(frames).toContain("first message");

    vi.advanceTimersByTime(1000);
    expect(done2).toHaveBeenCalledTimes(1);
    expect(frames[frames.length - 1]).toBe("second");
  });

  it("flushTypewriter finishes an in-flight reveal with the full text", () => {
    const onDone = vi.fn();
    const frames: string[] = [];
    revealTypewriter("c1", "abcdefghij", { onFrame: (t) => frames.push(t), onDone });
    vi.advanceTimersByTime(16);
    flushTypewriter("c1");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(frames[frames.length - 1]).toBe("abcdefghij");
    // No further frames after flush.
    const count = frames.length;
    vi.advanceTimersByTime(1000);
    expect(frames.length).toBe(count);
  });

  it("total reveal duration stays bounded for long text", () => {
    const onDone = vi.fn();
    const long = "x".repeat(5000);
    revealTypewriter("c1", long, { onFrame: () => {}, onDone });
    vi.advanceTimersByTime(500); // maxTotalMs default is 480ms
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
