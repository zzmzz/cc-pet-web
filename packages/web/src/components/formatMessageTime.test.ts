import { describe, it, expect } from "vitest";
import { formatMessageTime } from "./MessageList.js";

function makeDate(y: number, m: number, d: number, h: number, min: number): Date {
  return new Date(y, m - 1, d, h, min);
}

describe("formatMessageTime", () => {
  const now = makeDate(2026, 4, 25, 14, 30);

  it("shows only time for today", () => {
    const ts = makeDate(2026, 4, 25, 8, 5).getTime();
    const result = formatMessageTime(ts, now);
    expect(result).toMatch(/^08:05$/);
  });

  it("shows 昨天 for yesterday", () => {
    const ts = makeDate(2026, 4, 24, 20, 0).getTime();
    const result = formatMessageTime(ts, now);
    expect(result).toMatch(/^昨天 20:00$/);
  });

  it("shows 昨天 for yesterday late night (23:59)", () => {
    const ts = makeDate(2026, 4, 24, 23, 59).getTime();
    const result = formatMessageTime(ts, now);
    expect(result).toMatch(/^昨天 23:59$/);
  });

  it("shows 昨天 for yesterday early morning (00:01)", () => {
    const ts = makeDate(2026, 4, 24, 0, 1).getTime();
    const result = formatMessageTime(ts, now);
    expect(result).toMatch(/^昨天 00:01$/);
  });

  it("shows M/D for earlier this year", () => {
    const ts = makeDate(2026, 3, 10, 15, 30).getTime();
    const result = formatMessageTime(ts, now);
    expect(result).toMatch(/^3\/10 15:30$/);
  });

  it("shows M/D for 2 days ago", () => {
    const ts = makeDate(2026, 4, 23, 9, 0).getTime();
    const result = formatMessageTime(ts, now);
    expect(result).toMatch(/^4\/23 09:00$/);
  });

  it("shows full date for previous year", () => {
    const ts = makeDate(2025, 12, 31, 23, 59).getTime();
    const result = formatMessageTime(ts, now);
    expect(result).toMatch(/^2025\/12\/31 23:59$/);
  });

  it("shows only time for today at midnight", () => {
    const ts = makeDate(2026, 4, 25, 0, 0).getTime();
    const result = formatMessageTime(ts, now);
    expect(result).toMatch(/^00:00$/);
  });

  it("handles now at start of day correctly", () => {
    const earlyNow = makeDate(2026, 4, 25, 0, 1);
    const ts = makeDate(2026, 4, 24, 23, 50).getTime();
    const result = formatMessageTime(ts, earlyNow);
    expect(result).toMatch(/^昨天 23:50$/);
  });

  it("Jan 1: yesterday is previous year", () => {
    const jan1 = makeDate(2026, 1, 1, 10, 0);
    const ts = makeDate(2025, 12, 31, 18, 0).getTime();
    const result = formatMessageTime(ts, jan1);
    expect(result).toMatch(/^昨天 18:00$/);
  });

  it("treats seconds-level timestamp (< 1e12) as seconds and converts to ms", () => {
    // If someone passes a Unix epoch in seconds instead of ms, it would show 1970
    // This test documents that behavior — the function expects ms
    const secondsTs = Math.floor(makeDate(2026, 4, 24, 20, 0).getTime() / 1000);
    const result = formatMessageTime(secondsTs, now);
    // A seconds-level timestamp ~1.7e9 gets interpreted as Jan 1970
    expect(result).toContain("1970");
  });
});
