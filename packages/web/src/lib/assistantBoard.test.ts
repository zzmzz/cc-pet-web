import { describe, expect, it } from "vitest";
import { groupBoard, weekdayLabel, type AssistantItem } from "./assistantBoard.js";

let seq = 0;
function mk(p: Partial<AssistantItem>): AssistantItem {
  seq += 1;
  return {
    id: seq, kind: "todo", title: `事项${seq}`, detail: "", date: null, time: null,
    deadline: false, people: [], status: "open", closedReason: null,
    createdAt: "2026-10-01 09:00:00", updatedAt: "2026-10-01 09:00:00", ...p,
  };
}
const TODAY = "2026-10-28";

describe("groupBoard", () => {
  it("today: sorted by time, no time last, then id; waiting excluded", () => {
    const a = mk({ id: 5, date: TODAY, time: null });
    const b = mk({ id: 2, date: TODAY, time: "15:00", kind: "event" });
    const c = mk({ id: 9, date: TODAY, time: "09:30" });
    const d = mk({ id: 1, date: TODAY, kind: "waiting" });
    const e = mk({ id: 3, date: TODAY, time: null });
    expect(groupBoard([a, b, c, d, e], TODAY).today.map((i) => i.id)).toEqual([9, 2, 3, 5]);
  });

  it("overdue: only todos, oldest first, with days (across months)", () => {
    const a = mk({ id: 1, date: "2026-10-26" });
    const b = mk({ id: 2, date: "2026-09-30" });
    const ev = mk({ id: 3, kind: "event", date: "2026-10-20" });
    const r = groupBoard([a, b, ev], TODAY);
    expect(r.overdue.map((o) => [o.item.id, o.days])).toEqual([[2, 28], [1, 2]]);
    expect(r.today).toEqual([]);
    expect(r.week).toEqual([]);
    expect(r.farther).toEqual([]);
    expect(r.undated).toEqual([]);
  });

  it("week: next 7 days only, days with items, crossing month end", () => {
    const today = "2026-10-29";
    const a = mk({ id: 1, date: "2026-11-01", time: "10:00" });
    const b = mk({ id: 2, date: "2026-10-30" });
    const c = mk({ id: 3, date: "2026-11-05" });
    const d = mk({ id: 4, date: "2026-11-06" });
    const e = mk({ id: 5, date: "2026-11-01", time: "08:00", kind: "event" });
    const r = groupBoard([a, b, c, d, e], today);
    expect(r.week.map((w) => [w.date, w.items.map((i) => i.id)])).toEqual([
      ["2026-10-30", [2]],
      ["2026-11-01", [5, 1]],
      ["2026-11-05", [3]],
    ]);
    expect(r.farther.map((i) => i.id)).toEqual([4]);
  });

  it("farther: by date then time", () => {
    const a = mk({ id: 1, date: "2026-12-01", time: "10:00" });
    const b = mk({ id: 2, date: "2026-11-20" });
    const c = mk({ id: 3, date: "2026-12-01", time: "09:00" });
    expect(groupBoard([a, b, c], TODAY).farther.map((i) => i.id)).toEqual([2, 3, 1]);
  });

  it("waiting: regardless of date, by createdAt, days since creation", () => {
    const a = mk({ id: 1, kind: "waiting", date: "2026-10-28", createdAt: "2026-10-27 23:00:00" });
    const b = mk({ id: 2, kind: "waiting", date: "2026-12-01", createdAt: "2026-10-20 08:00:00" });
    const c = mk({ id: 3, kind: "waiting", createdAt: "2026-10-30 08:00:00" });
    const r = groupBoard([a, b, c], TODAY);
    expect(r.waiting.map((w) => [w.item.id, w.days])).toEqual([[2, 8], [1, 1], [3, 0]]);
    expect(r.today).toEqual([]);
    expect(r.farther).toEqual([]);
  });

  it("undated: todos without date by id; undated events and waiting excluded", () => {
    const a = mk({ id: 7 });
    const b = mk({ id: 4 });
    const ev = mk({ id: 5, kind: "event" });
    expect(groupBoard([a, b, ev], TODAY).undated.map((i) => i.id)).toEqual([4, 7]);
  });

  it("past events appear nowhere", () => {
    const ev = mk({ kind: "event", date: "2026-10-27" });
    const r = groupBoard([ev], TODAY);
    expect(Object.values(r).every((v) => (v as unknown[]).length === 0)).toBe(true);
  });
});

describe("weekdayLabel", () => {
  it("formats month-day and weekday", () => {
    expect(weekdayLabel("2026-10-28")).toBe("10-28 周三");
    expect(weekdayLabel("2026-11-01")).toBe("11-01 周日");
  });
});
