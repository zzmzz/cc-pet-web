import { describe, it, expect } from "vitest";
import { ProactiveDetector } from "../src/resident/proactive-detector.js";

describe("ProactiveDetector", () => {
  it("is proactive when there was no recent user send", () => {
    const d = new ProactiveDetector({ windowMs: 1000, now: () => 10_000 });
    expect(d.isProactive("cc", "resident")).toBe(true);
  });

  it("is not proactive within the window after a user send", () => {
    let t = 0;
    const d = new ProactiveDetector({ windowMs: 1000, now: () => t });
    t = 5000;
    d.markUserSend("cc", "resident");
    t = 5500; // within 1000ms
    expect(d.isProactive("cc", "resident")).toBe(false);
    t = 6600; // beyond window
    expect(d.isProactive("cc", "resident")).toBe(true);
  });

  it("tracks sessions independently", () => {
    let t = 0;
    const d = new ProactiveDetector({ windowMs: 1000, now: () => t });
    t = 100;
    d.markUserSend("cc", "a");
    t = 200;
    expect(d.isProactive("cc", "a")).toBe(false);
    expect(d.isProactive("cc", "b")).toBe(true);
  });
});
