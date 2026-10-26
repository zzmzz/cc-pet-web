import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DELIVERABLE_GROUPS_OPEN_KEY, Deliverables } from "./Deliverables.js";
import { ThreadsContext } from "./threads.js";
import type { AssistantDeliverable, AssistantItem, AssistantThread } from "../../lib/assistantBoard.js";

vi.mock("../../lib/platform.js", () => ({ getPlatform: () => ({ fetchApiRaw: vi.fn() }) }));

const TODAY = "2026-10-28";
let seq = 0;
function d(p: Partial<AssistantDeliverable>): AssistantDeliverable {
  seq += 1;
  return {
    id: seq, itemId: null, sessionKey: null, title: `示例成品${seq}`, path: `/out/示例${seq}.md`,
    summary: "", status: "seen", createdAt: `${TODAY}T09:00:00`, ...p,
  };
}

const items: AssistantItem[] = [
  {
    id: 3, kind: "todo", title: "写示例报告", detail: "", date: null, time: null, deadline: false, people: [],
    status: "open", closedReason: null, createdAt: "", updatedAt: "", priority: "normal",
  },
];
const threads: AssistantThread[] = [
  { sessionKey: "task-9", itemId: null, title: "查示例资料", status: "done", progress: "", updatedAt: "" },
];

function show(list: AssistantDeliverable[]) {
  const onStatus = vi.fn(async () => {});
  const utils = render(
    <ThreadsContext.Provider value={threads}>
      <Deliverables deliverables={list} today={TODAY} onStatus={onStatus} items={items} />
    </ThreadsContext.Provider>,
  );
  return { ...utils, onStatus };
}

const groupRows = () => screen.queryAllByTestId("deliverable-group");
const toggleOf = (row: HTMLElement) => within(row).getAllByRole("button")[0];

describe("Deliverables grouping", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("keeps the flat list with five or fewer", () => {
    show([1, 2, 3, 4, 5].map((i) => d({ topic: `主题${i}` })));
    expect(groupRows()).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "打开" })).toHaveLength(5);
  });

  it("groups more than five by topic, collapsed, with count, unseen badge and newest time", () => {
    show([
      d({ topic: "年会筹备", status: "new", createdAt: `${TODAY}T10:30:00` }),
      d({ topic: "年会筹备", status: "new" }),
      d({ topic: "年会筹备" }),
      d({ itemId: 3, createdAt: `${TODAY}T08:00:00` }),
      d({ sessionKey: "task-9", createdAt: "2026-10-27T18:00:00" }),
      d({ createdAt: "2026-10-26T07:00:00" }),
    ]);
    const rows = groupRows();
    expect(rows.map((r) => within(r).getByTestId("deliverable-group-topic").textContent)).toEqual([
      "年会筹备", "写示例报告", "查示例资料", "其他",
    ]);
    expect(rows[0].textContent).toContain("3");
    expect(within(rows[0]).getByTestId("deliverable-group-unseen").textContent).toBe("2 待你看");
    expect(rows[0].textContent).toContain("今天 10:30");
    expect(within(rows[1]).queryByTestId("deliverable-group-unseen")).toBeNull();
    expect(rows[2].textContent).toContain("10-27 18:00");
    expect(screen.queryAllByRole("button", { name: "打开" })).toHaveLength(0);
    expect(toggleOf(rows[0]).getAttribute("aria-expanded")).toBe("false");
  });

  it("caps topics at five and folds the rest into 其他", () => {
    const list = ["甲", "乙", "丙", "丁", "戊", "己", "庚"].map((t, i) =>
      d({ topic: t, createdAt: `${TODAY}T${String(10 + i).padStart(2, "0")}:00:00` }),
    );
    show(list);
    expect(groupRows().map((r) => within(r).getByTestId("deliverable-group-topic").textContent)).toEqual([
      "庚", "己", "戊", "丁", "丙", "其他",
    ]);
    expect(groupRows()[5].textContent).toContain("2");
  });

  it("expands a group to the usual rows and remembers it", async () => {
    const user = userEvent.setup();
    const list = [
      d({ topic: "年会筹备", title: "示例座位表" }),
      d({ topic: "年会筹备", title: "示例流程" }),
      ...[1, 2, 3, 4].map((i) => d({ topic: `别的${i}`, createdAt: `${TODAY}T08:0${i}:00` })),
    ];
    const first = show(list);
    await user.click(toggleOf(groupRows()[0]));
    const row = groupRows()[0];
    expect(toggleOf(row).getAttribute("aria-expanded")).toBe("true");
    expect(within(row).getAllByRole("button", { name: "打开" })).toHaveLength(2);
    expect(row.textContent).toContain("示例座位表");
    await user.click(within(row).getAllByRole("button", { name: "用了" })[0]);
    expect(first.onStatus).toHaveBeenCalledWith(list[0].id, "used");
    expect(JSON.parse(localStorage.getItem(DELIVERABLE_GROUPS_OPEN_KEY) ?? "[]")).toEqual(["年会筹备"]);

    first.unmount();
    show(list);
    expect(toggleOf(groupRows()[0]).getAttribute("aria-expanded")).toBe("true");
    await user.click(toggleOf(groupRows()[0]));
    expect(toggleOf(groupRows()[0]).getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem(DELIVERABLE_GROUPS_OPEN_KEY)).toBeNull();
  });

  it("ignores a broken stored value", () => {
    localStorage.setItem(DELIVERABLE_GROUPS_OPEN_KEY, "{not json");
    show([1, 2, 3, 4, 5, 6].map((i) => d({ topic: `主题${i}` })));
    expect(groupRows()).toHaveLength(6); // five topics and 其他
  });
});
