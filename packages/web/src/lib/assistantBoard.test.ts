import { describe, expect, it } from "vitest";
import {
  deliverableStatusLabel, deliverableTime, discussionPrompt, fileName, groupBoard, isTextDeliverable,
  isChildOf, elapsedLabel, priorityRank, progressRows, threadSourceLabel, threadForItem, weekdayLabel,
  type AssistantItem, type AssistantThread,
} from "./assistantBoard.js";

let seq = 0;
function mk(p: Partial<AssistantItem>): AssistantItem {
  seq += 1;
  return {
    id: seq, kind: "todo", title: `事项${seq}`, detail: "", date: null, time: null,
    deadline: false, people: [], status: "open", closedReason: null,
    createdAt: "2026-10-01 09:00:00", updatedAt: "2026-10-01 09:00:00", priority: "normal", ...p,
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

describe("groupBoard priority", () => {
  it("farther: high, then normal, then low; by date within a level", () => {
    const a = mk({ id: 1, date: "2026-11-20" });
    const b = mk({ id: 2, date: "2026-12-01", priority: "high" });
    const c = mk({ id: 3, date: "2026-11-10", priority: "low" });
    const d = mk({ id: 4, date: "2026-11-15", priority: "high" });
    const e = mk({ id: 5, date: "2026-11-12" });
    expect(groupBoard([a, b, c, d, e], TODAY).farther.map((i) => i.id)).toEqual([4, 2, 5, 1, 3]);
  });

  it("waiting: high first, oldest first within a level", () => {
    const a = mk({ id: 1, kind: "waiting", createdAt: "2026-10-01 09:00:00", priority: "low" });
    const b = mk({ id: 2, kind: "waiting", createdAt: "2026-10-20 09:00:00", priority: "high" });
    const c = mk({ id: 3, kind: "waiting", createdAt: "2026-10-05 09:00:00" });
    const d = mk({ id: 4, kind: "waiting", createdAt: "2026-10-02 09:00:00" });
    expect(groupBoard([a, b, c, d], TODAY).waiting.map((w) => w.item.id)).toEqual([2, 4, 3, 1]);
  });

  it("undated: high first, by id within a level; unknown values count as normal", () => {
    const a = mk({ id: 1, priority: "low" });
    const b = mk({ id: 2 });
    const c = mk({ id: 3, priority: "high" });
    const d = mk({ id: 4, priority: "bogus" as never });
    expect(groupBoard([a, b, c, d], TODAY).undated.map((i) => i.id)).toEqual([3, 2, 4, 1]);
  });

  it("today and the week are not reordered by priority", () => {
    const a = mk({ id: 1, date: TODAY, time: "09:00", priority: "low" });
    const b = mk({ id: 2, date: TODAY, time: "10:00", priority: "high" });
    expect(groupBoard([a, b], TODAY).today.map((i) => i.id)).toEqual([1, 2]);
  });

  it("priorityRank", () => {
    expect([priorityRank(mk({ priority: "high" })), priorityRank(mk({})), priorityRank(mk({ priority: "low" }))]).toEqual([0, 1, 2]);
  });
});

describe("weekdayLabel", () => {
  it("formats month-day and weekday", () => {
    expect(weekdayLabel("2026-10-28")).toBe("10-28 周三");
    expect(weekdayLabel("2026-11-01")).toBe("11-01 周日");
  });
});

describe("discussionPrompt", () => {
  const ENDING = "这件事是从我的微信聊天里整理出来的。先帮我理一下要做什么、要准备什么；能先起草的东西告诉我，我确认了你再动手。";

  it("writes every field that has a value", () => {
    const item = mk({
      title: "交活动方案", date: "2026-10-28", time: "17:00", deadline: true,
      detail: "要附预算表", people: ["王小明", "李华"],
    });
    expect(discussionPrompt(item)).toBe(
      [
        "我们来聊聊这件事：交活动方案",
        "时间：10-28 周三 17:00 截止",
        "细节：要附预算表",
        "相关的人：王小明、李华",
        ENDING,
      ].join("\n"),
    );
  });

  it("leaves out empty fields and says the date is not set", () => {
    const item = mk({ title: "整理书架" });
    expect(discussionPrompt(item)).toBe(["我们来聊聊这件事：整理书架", "时间：没定日期", ENDING].join("\n"));
  });
});

describe("deliverable and thread helpers", () => {
  it("labels deliverable statuses, treating unknown ones as new", () => {
    expect(["new", "seen", "used", "dismissed", "odd"].map(deliverableStatusLabel)).toEqual([
      "待你看", "已看", "已用", "不用了", "待你看",
    ]);
  });

  it("opens md and txt on the page", () => {
    expect(isTextDeliverable("/x/a.md")).toBe(true);
    expect(isTextDeliverable("/x/a.TXT")).toBe(true);
    expect(isTextDeliverable("/x/a.xlsx")).toBe(false);
    expect(isTextDeliverable("/x/md")).toBe(false);
    expect(fileName("/x/y/数据.xlsx")).toBe("数据.xlsx");
  });

  it("formats the time with 今天 for today", () => {
    expect(deliverableTime("2026-10-28T09:05:00", TODAY)).toBe("今天 09:05");
    expect(deliverableTime("2026-10-21T18:30:00", TODAY)).toBe("10-21 18:30");
  });

  it("finds an item's thread, preferring its own session", () => {
    const t = (sessionKey: string, itemId: number | null) => ({
      sessionKey, itemId, title: "", status: "running", progress: "", updatedAt: "",
    });
    const threads = [t("task-1", 3), t("item-3", 3), t("task-2", 5)];
    expect(threadForItem(threads, 3)?.sessionKey).toBe("item-3");
    expect(threadForItem(threads, 5)?.sessionKey).toBe("task-2");
    expect(threadForItem(threads, 9)).toBeUndefined();
  });
});

describe("isChildOf", () => {
  const KEY = "demo:resident:resident";
  it("matches the resident key as stored, with or without the bridge prefix", () => {
    expect(isChildOf(KEY, KEY)).toBe(true);
    expect(isChildOf("resident:resident", KEY)).toBe(true);
    expect(isChildOf("resident", KEY)).toBe(true);
    expect(isChildOf("bridge:demo:resident:resident", KEY)).toBe(true);
  });
  it("rejects other sessions and empty parents", () => {
    expect(isChildOf(null, KEY)).toBe(false);
    expect(isChildOf(undefined, KEY)).toBe(false);
    expect(isChildOf("", KEY)).toBe(false);
    expect(isChildOf("item-3", KEY)).toBe(false);
    expect(isChildOf("demo:item-3:item-3", KEY)).toBe(false);
    expect(isChildOf("ent:resident", KEY)).toBe(false);
    expect(isChildOf("other:resident:other", KEY)).toBe(false);
  });
});

describe("elapsedLabel", () => {
  const now = new Date(2026, 9, 28, 12, 0, 0);
  it("reads like spoken time", () => {
    expect(elapsedLabel("2026-10-28T11:59:40", now)).toBe("刚开始");
    expect(elapsedLabel("2026-10-28T11:48:00", now)).toBe("12 分钟");
    expect(elapsedLabel("2026-10-28T10:00:00", now)).toBe("2 小时");
    expect(elapsedLabel("2026-10-28T09:35:00", now)).toBe("2 小时 25 分钟");
    expect(elapsedLabel("2026-10-26T08:00:00", now)).toBe("2 天");
  });
  it("treats future or unparsable times as just started", () => {
    expect(elapsedLabel("2026-10-28T12:30:00", now)).toBe("刚开始");
    expect(elapsedLabel("not a time", now)).toBe("刚开始");
  });
});

describe("progressRows", () => {
  const KEY = "demo:resident:resident";
  const now = new Date(2026, 9, 28, 12, 0, 0);
  function th(p: Partial<AssistantThread>): AssistantThread {
    return {
      sessionKey: "task-1", itemId: null, title: "活", status: "running", progress: "",
      parent: KEY, createdAt: "2026-10-28T10:00:00", updatedAt: "2026-10-28T11:00:00", ...p,
    };
  }
  it("keeps every unfinished thread, and done ones from the last 24 hours only if resident-dispatched or planner-made", () => {
    const rows = progressRows([
      th({ sessionKey: "task-1" }),
      th({ sessionKey: "task-2", parent: null, createdBy: "assistant" }),
      th({ sessionKey: "task-3", parent: "item-4", status: "stuck" }),
      th({ sessionKey: "task-4", status: "done", updatedAt: "2026-10-27T11:00:00" }),
      th({ sessionKey: "task-5", status: "done", updatedAt: "2026-10-28T09:00:00" }),
      th({ sessionKey: "task-6", status: "done", parent: null, createdBy: "web", updatedAt: "2026-10-28T09:00:00" }),
      th({ sessionKey: "task-7", status: "done", parent: null, createdBy: "planner", updatedAt: "2026-10-28T09:30:00" }),
      th({ sessionKey: "task-8", status: "done", parent: "item-4", createdBy: "assistant", updatedAt: "2026-10-28T09:30:00" }),
      th({ sessionKey: "task-9", status: "weird" }),
      th({ sessionKey: "task-10", status: "toString" }),
    ], KEY, now);
    expect(rows.map((t) => t.sessionKey)).toEqual(["task-3", "task-1", "task-2", "task-7", "task-5"]);
  });
  it("orders stuck, then running newest first, then done newest first", () => {
    const rows = progressRows([
      th({ sessionKey: "task-1", status: "done", updatedAt: "2026-10-28T08:00:00" }),
      th({ sessionKey: "task-2", createdAt: "2026-10-28T09:00:00" }),
      th({ sessionKey: "task-3", status: "done", updatedAt: "2026-10-28T10:00:00" }),
      th({ sessionKey: "task-4", createdAt: "2026-10-28T11:00:00" }),
      th({ sessionKey: "task-5", status: "stuck" }),
    ], KEY, now);
    expect(rows.map((t) => t.sessionKey)).toEqual(["task-5", "task-4", "task-2", "task-3", "task-1"]);
  });
});

describe("threadSourceLabel", () => {
  const KEY = "demo:resident:resident";
  const th = (p: Partial<AssistantThread>): AssistantThread => ({
    sessionKey: "task-1", itemId: null, title: "活", status: "running", progress: "", updatedAt: "2026-10-28T11:00:00", ...p,
  });
  it("tags where each thread came from", () => {
    expect(threadSourceLabel(th({ parent: KEY, createdBy: "assistant" }), KEY)).toBe("主会话派的");
    expect(threadSourceLabel(th({ parent: null, createdBy: "planner" }), KEY)).toBe("自动起草");
    expect(threadSourceLabel(th({ parent: null, createdBy: "web" }), KEY)).toBe("讨论");
    expect(threadSourceLabel(th({ sessionKey: "item-3", parent: null }), KEY)).toBe("讨论");
    expect(threadSourceLabel(th({ parent: "item-3", createdBy: "assistant" }), KEY)).toBe("子会话派的");
  });
});
