import { describe, expect, it } from "vitest";
import { normalizeBoard } from "./useAssistantBoard.js";

describe("normalizeBoard", () => {
  it("turns missing or malformed lists into empty ones", () => {
    const b = normalizeBoard({});
    expect(b.items).toEqual([]);
    expect(b.closedRecent).toEqual([]);
    expect(b.deliverables).toEqual([]);
    expect(b.threads).toEqual([]);
    expect(b.plannedAt).toBeNull();
    expect(normalizeBoard(null).items).toEqual([]);
    expect(normalizeBoard({ items: "x" }).items).toEqual([]);
  });

  it("keeps well-formed data", () => {
    const item = { id: 1, title: "示例事项" };
    const b = normalizeBoard({ items: [item], closedRecent: [], plannedAt: "2026-01-01T09:00:00", generatedAt: "g" });
    expect(b.items).toEqual([item]);
    expect(b.plannedAt).toBe("2026-01-01T09:00:00");
  });
});
