import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistantPage, BOARD_WIDE_KEY } from "./AssistantPage.js";
import { localDate, nextWeekDates, type AssistantItem } from "../../lib/assistantBoard.js";
import { useUIStore } from "../../lib/store/ui.js";
import { useConnectionStore } from "../../lib/store/connection.js";
import { useSessionStore } from "../../lib/store/session.js";
import { useMessageStore } from "../../lib/store/message.js";
import { emitAssistantSessionUpdated } from "../../lib/assistantEvents.js";
import { OPEN_SESSION_MESSAGE } from "../../lib/notificationOpen.js";

const platformMock = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  fetchApiRaw: vi.fn(),
  sendWsMessage: vi.fn(),
}));

vi.mock("../../lib/platform.js", () => ({
  getPlatform: () => ({
    fetchApi: platformMock.fetchApi,
    fetchApiRaw: platformMock.fetchApiRaw,
    sendWsMessage: platformMock.sendWsMessage,
  }),
}));

// The real chat is covered elsewhere; here we only care that it is shown.
vi.mock("../ChatWindow.js", () => ({ ChatWindow: () => <div data-testid="chat-window" /> }));
// Pet images are fetched per token; Pet.test.tsx covers that.
vi.mock("../Pet.js", () => ({
  PetMini: () => <div data-testid="pet-mini" />,
  PetFull: () => <div data-testid="pet-full" />,
}));

const today = localDate();
const [tomorrow] = nextWeekDates(today);

function item(over: Partial<AssistantItem> & { id: number; title: string }): AssistantItem {
  return {
    kind: "todo",
    detail: "",
    date: null,
    time: null,
    deadline: false,
    people: [],
    status: "open",
    closedReason: null,
    createdAt: `${today}T08:00:00`,
    updatedAt: `${today}T08:00:00`,
    priority: "normal",
    ...over,
  };
}

const board = {
  items: [
    item({ id: 1, kind: "event", title: "去图书馆还书", date: today, time: "09:00", detail: "带借书卡", people: ["王小明"] }),
    item({ id: 2, title: "交周报", date: tomorrow, time: "10:00" }),
    item({ id: 3, kind: "waiting", title: "回复李老师的邮件", createdAt: "2026-01-01T09:00:00" }),
    item({ id: 4, title: "整理书架" }),
    item({ id: 5, title: "年底体检", date: "2999-12-01" }),
  ],
  closedRecent: [
    item({ id: 9, title: "买牛奶", status: "done", closedReason: "群里说已经买了" }),
  ],
  plannedAt: new Date().toISOString(),
  generatedAt: new Date().toISOString(),
};

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function mockBoard(status = 200, body: unknown = board) {
  platformMock.fetchApiRaw.mockImplementation(async (path: string) => {
    if (path === "/api/assistant/board") return respond(status, body);
    if (path === "/api/sessions") return respond(200, { ok: true });
    return respond(200, {});
  });
}

function statusCalls() {
  return platformMock.fetchApiRaw.mock.calls
    .filter(([path]) => String(path).startsWith("/api/assistant/items/"))
    .map(([path, init]) => [path, JSON.parse(String(init?.body))]);
}

/** The 不急的 part of 没定日期的待办 starts folded; open it. */
async function expandUndated(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /还有 \d+ 件不急的/ }));
}

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  setWidth(1280);
  useUIStore.setState({ isMobile: false });
  useConnectionStore.setState({ connections: [], activeConnectionId: null });
  useSessionStore.setState({ sessions: {}, activeSessionKey: {}, unread: {}, taskStateByConnection: {} });
  platformMock.fetchApi.mockReset();
  platformMock.fetchApi.mockResolvedValue({});
  platformMock.fetchApiRaw.mockReset();
  platformMock.sendWsMessage.mockReset();
  platformMock.sendWsMessage.mockReturnValue("client-1");
  useMessageStore.setState({ messagesByChat: {} });
  mockBoard();
});

describe("AssistantPage", () => {
  it("renders the board sections with their items", async () => {
    const user = userEvent.setup();
    render(<AssistantPage />);

    expect(await screen.findByText("去图书馆还书")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "蟹哥" })).toBeTruthy();
    expect(screen.getByText(/今天 1 件事/)).toBeTruthy();
    expect(screen.getByText("带借书卡 · 王小明")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /接下来一周/ })).toBeTruthy();
    expect(within(screen.getByTestId(`week-${tomorrow}`)).getByText("交周报")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /更远/ })).toBeTruthy();
    expect(screen.getByText("年底体检")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /等你回复/ })).toBeTruthy();
    expect(screen.getByText("回复李老师的邮件")).toBeTruthy();
    expect(screen.getByText(/等了 \d+ 天/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /没定日期的待办/ })).toBeTruthy();
    expect(screen.getByText(/事项更新于 \d\d:\d\d/)).toBeTruthy();

    // Folded until clicked; the header still says how many.
    expect(screen.getByRole("heading", { name: /没定日期的待办/ }).textContent).toContain("1");
    const fold = screen.getByRole("button", { name: /还有 1 件不急的/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    const undatedList = document.getElementById(fold.getAttribute("aria-controls")!)!;
    expect(undatedList.hidden).toBe(true);
    await user.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(undatedList.hidden).toBe(false);
    expect(within(undatedList).getByText("整理书架")).toBeTruthy();
    await user.click(fold);
    expect(undatedList.hidden).toBe(true);
  });

  it("shows high-priority undated todos always, and folds the calm ones", async () => {
    const user = userEvent.setup();
    mockBoard(200, {
      ...board,
      items: [
        item({ id: 4, title: "整理书架" }),
        item({ id: 6, title: "给花浇水", priority: "low" }),
        item({ id: 7, title: "续办借书证", priority: "high" }),
      ],
    });
    render(<AssistantPage />);
    const heading = await screen.findByRole("heading", { name: /没定日期的待办/ });
    expect(heading.textContent).toContain("3");
    const urgentRow = screen.getByText("续办借书证").closest("ul")!;
    expect(urgentRow.hidden).toBe(false);
    const fold = screen.getByRole("button", { name: /还有 2 件不急的/ });
    const calmList = document.getElementById(fold.getAttribute("aria-controls")!)!;
    expect(calmList.hidden).toBe(true);
    expect(within(calmList).getByText("整理书架")).toBeTruthy();
    await user.click(fold);
    expect(calmList.hidden).toBe(false);
    expect(localStorage.getItem("cc-pet-assistant-undated-folded")).toBe("open");
  });

  it("with only calm undated todos, shows just the header and the fold toggle", async () => {
    mockBoard(200, { ...board, items: [item({ id: 4, title: "整理书架" })] });
    render(<AssistantPage />);
    const section = (await screen.findByRole("heading", { name: /没定日期的待办/ })).closest("section")!;
    expect(within(section).getAllByRole("list", { hidden: true }).every((l) => (l as HTMLElement).hidden)).toBe(true);
    expect(within(section).getByRole("button", { name: /还有 1 件不急的/ })).toBeTruthy();
  });

  it("orders the sections: today, waiting, undated, next week, farther, recently closed", async () => {
    render(<AssistantPage />);

    await screen.findByText("去图书馆还书");
    const titles = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => (h.textContent ?? "").replace(/[\d▸▾\s]/g, ""));
    expect(titles).toEqual(["今天", "等你回复", "没定日期的待办", "接下来一周", "更远"]);
    const closed = screen.getByRole("button", { name: /最近 24 小时结案/ });
    const farther = screen.getByRole("heading", { name: /更远/ });
    expect(farther.compareDocumentPosition(closed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("tags urgent items 急 and relaxed ones 不急, and puts urgent ones first", async () => {
    mockBoard(200, {
      ...board,
      items: [
        ...board.items,
        item({ id: 6, title: "随手记一下", priority: "low" }),
        item({ id: 7, title: "交报名表", priority: "high" }),
        item({ id: 8, title: "周末大扫除", date: tomorrow, priority: "high" }),
      ],
    });
    const user = userEvent.setup();
    render(<AssistantPage />);

    await expandUndated(user);
    const urgent = (await screen.findByText("交报名表")).closest("li")!;
    expect(within(urgent).getByText("急")).toBeTruthy();
    const relaxed = screen.getByText("随手记一下").closest("li")!;
    expect(within(relaxed).getByText("不急")).toBeTruthy();
    const plain = screen.getByText("去图书馆还书").closest("li")!;
    expect(within(plain).queryByText("急")).toBeNull();
    expect(within(plain).queryByText("不急")).toBeNull();
    expect(within(screen.getByTestId(`week-${tomorrow}`)).getByText("急")).toBeTruthy();

    const undatedSection = screen.getByRole("heading", { name: /没定日期的待办/ }).closest("section")!;
    const rows = within(undatedSection).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(rows.map((r) => r.slice(0, 4))).toEqual(["交报名表", "整理书架", "随手记一"]);
  });

  it("marks an item done when its checkbox is ticked, then reloads", async () => {
    const user = userEvent.setup();
    render(<AssistantPage />);

    await user.click(await screen.findByRole("checkbox", { name: "做完了：去图书馆还书" }));

    await waitFor(() => expect(statusCalls()).toEqual([["/api/assistant/items/1/status", { status: "done" }]]));
    await waitFor(() =>
      expect(platformMock.fetchApiRaw.mock.calls.filter(([p]) => p === "/api/assistant/board")).toHaveLength(2),
    );
  });

  it("dismisses an item with 不用了", async () => {
    const user = userEvent.setup();
    render(<AssistantPage />);

    await expandUndated(user);
    const row = (await screen.findByText("整理书架")).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "不用了" }));

    await waitFor(() => expect(statusCalls()).toEqual([["/api/assistant/items/4/status", { status: "dismissed" }]]));
  });

  it("reopens a recently closed item with 撤销", async () => {
    const user = userEvent.setup();
    render(<AssistantPage />);

    await user.click(await screen.findByRole("button", { name: /最近 24 小时结案/ }));
    expect(screen.getByText("群里说已经买了")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "撤销" }));

    await waitFor(() => expect(statusCalls()).toEqual([["/api/assistant/items/9/status", { status: "open" }]]));
  });

  it("shows the save-failed banner and frees the checkbox when the POST returns 500 (StrictMode)", async () => {
    platformMock.fetchApiRaw.mockImplementation(async (path: string) =>
      path === "/api/assistant/board" ? respond(200, board) : respond(500, {}),
    );
    const user = userEvent.setup();
    render(
      <StrictMode>
        <AssistantPage />
      </StrictMode>,
    );

    const box = (await screen.findByRole("checkbox", { name: "做完了：去图书馆还书" })) as HTMLInputElement;
    await user.click(box);

    expect(await screen.findByText("没改成，再试一次")).toBeTruthy();
    await waitFor(() => {
      expect(box.checked).toBe(false);
      expect(box.disabled).toBe(false);
    });
  });

  it("shows the save-failed banner and frees the checkbox when the POST throws (StrictMode)", async () => {
    platformMock.fetchApiRaw.mockImplementation(async (path: string) => {
      if (path === "/api/assistant/board") return respond(200, board);
      throw new Error("network down");
    });
    const user = userEvent.setup();
    render(
      <StrictMode>
        <AssistantPage />
      </StrictMode>,
    );

    const box = (await screen.findByRole("checkbox", { name: "做完了：去图书馆还书" })) as HTMLInputElement;
    await user.click(box);

    expect(await screen.findByText("没改成，再试一次")).toBeTruthy();
    await waitFor(() => {
      expect(box.checked).toBe(false);
      expect(box.disabled).toBe(false);
    });
  });

  it("sends only one POST when 撤销 is double-clicked", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    platformMock.fetchApiRaw.mockImplementation(async (path: string) => {
      if (path === "/api/assistant/board") return respond(200, board);
      await gate;
      return respond(200, {});
    });
    const user = userEvent.setup();
    render(<AssistantPage />);

    await user.click(await screen.findByRole("button", { name: /最近 24 小时结案/ }));
    const undo = screen.getByRole("button", { name: "撤销" }) as HTMLButtonElement;
    await user.dblClick(undo);

    expect(statusCalls()).toHaveLength(1);
    expect(undo.disabled).toBe(true);
    release();
    await waitFor(() => expect(undo.disabled).toBe(false));
  });

  it("asks to log in again on 401 when loading the board", async () => {
    mockBoard(401, { error: "unauthorized" });
    render(<AssistantPage />);

    expect(await screen.findByText("登录失效了，请退出后重新登录")).toBeTruthy();
  });

  it("asks to log in again on 403 when saving", async () => {
    platformMock.fetchApiRaw.mockImplementation(async (path: string) =>
      path === "/api/assistant/board" ? respond(200, board) : respond(403, {}),
    );
    const user = userEvent.setup();
    render(<AssistantPage />);

    await user.click(await screen.findByRole("checkbox", { name: "做完了：去图书馆还书" }));

    expect(await screen.findByText("登录失效了，请退出后重新登录")).toBeTruthy();
  });

  it("links the phone tabs to their panels inside a labelled nav", async () => {
    setWidth(390);
    render(<AssistantPage />);

    await screen.findByText("去图书馆还书");
    const nav = screen.getByRole("navigation", { name: "页面" });
    const tab = within(nav).getByRole("tab", { name: "今天" });
    expect(within(nav).getByRole("tablist")).toBeTruthy();
    const panel = document.getElementById(tab.getAttribute("aria-controls")!);
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.textContent).toContain("去图书馆还书");
    const chatTab = within(nav).getByRole("tab", { name: "聊天" });
    expect(document.getElementById(chatTab.getAttribute("aria-controls")!)?.getAttribute("role")).toBe("tabpanel");
  });

  it("hides an empty time column on a phone", async () => {
    render(<AssistantPage />);

    const timed = (await screen.findByText("去图书馆还书")).closest("li")!;
    expect(within(timed).getByTestId("item-when").className).not.toContain("hidden");
    const overdue = item({ id: 6, title: "补交报销单", date: "2000-01-01" });
    cleanup();
    mockBoard(200, { ...board, items: [...board.items, overdue] });
    render(<AssistantPage />);
    const untimed = (await screen.findByText("补交报销单")).closest("li")!;
    expect(within(untimed).getByTestId("item-when").className).toContain("hidden md:block");
  });

  it("puts the chat on the left and the board in a column on the right, with the pet in the board header", async () => {
    render(<AssistantPage />);

    await screen.findByText("去图书馆还书");
    const chat = screen.getByRole("region", { name: "聊天" });
    const boardColumn = screen.getByRole("region", { name: "事项" });
    expect(chat.compareDocumentPosition(boardColumn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(chat).getByText("蟹哥还没配置好")).toBeTruthy();
    expect(within(boardColumn).getByText("去图书馆还书")).toBeTruthy();
    const header = within(boardColumn).getByRole("heading", { name: "蟹哥" }).closest("header")!;
    expect(within(header).getByTestId("pet-full")).toBeTruthy();
    expect(screen.queryByTestId("pet-mini")).toBeNull();
    expect(within(header).getByRole("button", { name: "放大日程" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "退出" })).toBeTruthy();
  });

  it("keeps the full pet in the board header after 放大日程", async () => {
    const user = userEvent.setup();
    render(<AssistantPage />);

    await screen.findByText("去图书馆还书");
    await user.click(screen.getByRole("button", { name: "放大日程" }));
    const header = within(screen.getByRole("region", { name: "事项" })).getByRole("heading", { name: "蟹哥" }).closest("header")!;
    expect(within(header).getByTestId("pet-full")).toBeTruthy();
  });

  it("widens the board with 放大日程, keeps the chat beside it, and remembers the choice", async () => {
    const user = userEvent.setup();
    render(<AssistantPage />);

    await screen.findByText("去图书馆还书");
    const chat = () => screen.getByRole("region", { name: "聊天" });
    const boardColumn = () => screen.getByRole("region", { name: "事项" });
    expect(chat().className).toContain("flex-1");
    expect(boardColumn().className).toContain("w-[480px]");
    // A narrow column lists the week a day per line.
    expect(screen.getByTestId(`week-${tomorrow}`).className).not.toContain("min-w-28");

    await user.click(within(boardColumn()).getByRole("button", { name: "放大日程" }));
    expect(boardColumn().className).toContain("flex-1");
    expect(chat().className).toContain("w-[400px]");
    expect(within(chat()).getByText("蟹哥还没配置好")).toBeTruthy();
    expect(screen.getByTestId(`week-${tomorrow}`).className).toContain("min-w-28");
    expect(localStorage.getItem(BOARD_WIDE_KEY)).toBe("1");

    // Still wide after a reload.
    cleanup();
    render(<AssistantPage />);
    await screen.findByText("去图书馆还书");
    expect(boardColumn().className).toContain("flex-1");
    await user.click(screen.getByRole("button", { name: "还原" }));
    expect(chat().className).toContain("flex-1");
    expect(localStorage.getItem(BOARD_WIDE_KEY)).toBeNull();
  });

  it("has no 放大日程 button on a phone", async () => {
    localStorage.setItem(BOARD_WIDE_KEY, "1");
    setWidth(390);
    render(<AssistantPage />);

    await screen.findByText("去图书馆还书");
    expect(screen.queryByRole("button", { name: /放大日程|还原/ })).toBeNull();
  });

  it("shows only the small pet on a phone", async () => {
    setWidth(390);
    render(<AssistantPage />);

    await screen.findByText("去图书馆还书");
    expect(screen.getByTestId("pet-mini")).toBeTruthy();
    expect(screen.queryByTestId("pet-full")).toBeNull();
  });

  it("says the data is not ready on 503", async () => {
    mockBoard(503, { error: "not ready" });
    render(<AssistantPage />);

    expect(await screen.findByText("蟹哥的数据还没准备好")).toBeTruthy();
  });

  it("says 蟹哥 is not set up when there is no resident session", async () => {
    useConnectionStore.setState({ connections: [{ id: "c1", name: "Bot", connected: true }], activeConnectionId: "c1" });
    useSessionStore.setState({
      sessions: { c1: [{ key: "s1", connectionId: "c1", createdAt: 1, lastActiveAt: 1 }] },
      activeSessionKey: { c1: "s1" },
    });
    render(<AssistantPage />);

    expect(await screen.findByText("蟹哥还没配置好")).toBeTruthy();
    expect(screen.queryByTestId("chat-window")).toBeNull();
  });

  it("pins the chat to the resident session", async () => {
    useConnectionStore.setState({
      connections: [
        { id: "c1", name: "Bot", connected: true },
        { id: "c2", name: "Helper", connected: true },
      ],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: {
        c1: [{ key: "s1", connectionId: "c1", createdAt: 1, lastActiveAt: 1 }],
        c2: [
          { key: "other", connectionId: "c2", createdAt: 1, lastActiveAt: 1 },
          { key: "home", connectionId: "c2", createdAt: 1, lastActiveAt: 1, isResident: true },
        ],
      },
      activeSessionKey: { c1: "s1", c2: "other" },
      unread: { "c2::home": 3 },
    });
    render(<AssistantPage />);

    expect(await screen.findByTestId("chat-window")).toBeTruthy();
    await waitFor(() => expect(useConnectionStore.getState().activeConnectionId).toBe("c2"));
    expect(useSessionStore.getState().activeSessionKey.c2).toBe("home");
    expect(useSessionStore.getState().unread["c2::home"] ?? 0).toBe(0);
    expect(platformMock.fetchApi).toHaveBeenCalledWith("/api/sessions/c2/home/read", { method: "POST" });
  });

  it("switches views with the bottom tabs on a phone", async () => {
    setWidth(390);
    const user = userEvent.setup();
    render(<AssistantPage />);

    expect(await screen.findByText("去图书馆还书")).toBeTruthy();
    expect(screen.queryByText("年底体检")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "日程" }));
    expect(screen.getByText("年底体检")).toBeTruthy();
    expect(screen.queryByText("去图书馆还书")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "聊天" }));
    expect(screen.queryByText("年底体检")).toBeNull();
    expect(screen.getByText("蟹哥还没配置好")).toBeTruthy();
  });
});

describe("AssistantPage chat sessions", () => {
  function seedSessions() {
    useConnectionStore.setState({
      connections: [
        { id: "c1", name: "Bot", connected: true },
        { id: "c2", name: "Helper", connected: true },
      ],
      activeConnectionId: "c2",
    });
    useSessionStore.setState({
      sessions: {
        c1: [
          { key: "s-old", connectionId: "c1", createdAt: 1, lastActiveAt: 100, label: "旧话题" },
          { key: "home", connectionId: "c1", createdAt: 1, lastActiveAt: 50, isResident: true },
          { key: "item-4", connectionId: "c1", createdAt: 1, lastActiveAt: 200, label: "事项：整理书架" },
          { key: "s-new", connectionId: "c1", createdAt: 1, lastActiveAt: 300, label: "周报怎么写" },
        ],
        c2: [{ key: "elsewhere", connectionId: "c2", createdAt: 1, lastActiveAt: 999, label: "别的连接" }],
      },
      activeSessionKey: { c1: "s-old", c2: "elsewhere" },
      unread: { "c1::s-new": 2 },
    });
  }

  function listRows() {
    const list = screen.getByRole("list", { name: "会话" });
    return within(list)
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
  }

  it("lists the main session, then 新话题, then the other sessions on the same connection, newest first", async () => {
    seedSessions();
    const user = userEvent.setup();
    render(<AssistantPage />);

    await user.click(await screen.findByRole("button", { name: /全部会话/ }));
    const rows = listRows();
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain("个人助理-主会话");
    expect(rows[1]).toContain("新话题");
    expect(rows[2]).toContain("周报怎么写");
    expect(within(screen.getByRole("list", { name: "会话" })).getByLabelText("2 条未读")).toBeTruthy();
    expect(rows[3]).toContain("事项");
    expect(rows[3]).toContain("整理书架");
    expect(rows[3]).not.toContain("事项：");
    expect(rows[4]).toContain("旧话题");
    expect(screen.queryByText("别的连接")).toBeNull();
    expect(screen.queryByText("Bot")).toBeNull();
  });

  it("opens a picked session and does not pull it back to the main session", async () => {
    seedSessions();
    const user = userEvent.setup();
    render(<AssistantPage />);

    await waitFor(() => expect(useSessionStore.getState().activeSessionKey.c1).toBe("home"));
    expect(useConnectionStore.getState().activeConnectionId).toBe("c1");

    await user.click(screen.getByRole("button", { name: /全部会话/ }));
    await user.click(screen.getByRole("button", { name: /周报怎么写/ }));

    expect(useSessionStore.getState().activeSessionKey.c1).toBe("s-new");
    expect(useSessionStore.getState().unread["c1::s-new"] ?? 0).toBe(0);
    expect(platformMock.fetchApi).toHaveBeenCalledWith("/api/sessions/c1/s-new/read", { method: "POST" });
    expect(screen.queryByRole("list", { name: "会话" })).toBeNull();

    // A session list refresh used to re-pin the chat; it must stay where the user put it.
    act(() => {
      useSessionStore.getState().setSessions("c1", [...useSessionStore.getState().sessions.c1]);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(useSessionStore.getState().activeSessionKey.c1).toBe("s-new");
  });

  it("starts a new topic on the resident's connection and switches to it", async () => {
    seedSessions();
    const user = userEvent.setup();
    render(<AssistantPage />);

    await user.click(await screen.findByRole("button", { name: /全部会话/ }));
    await user.click(screen.getByRole("button", { name: /新话题/ }));

    await waitFor(() => {
      const post = platformMock.fetchApiRaw.mock.calls.find(([p]) => p === "/api/sessions");
      expect(post).toBeTruthy();
    });
    const [, init] = platformMock.fetchApiRaw.mock.calls.find(([p]) => p === "/api/sessions")!;
    const body = JSON.parse(String(init.body));
    expect(body.connectionId).toBe("c1");
    expect(body.key).toMatch(/^session-\d+$/);
    await waitFor(() => expect(useSessionStore.getState().activeSessionKey.c1).toBe(body.key));
    expect(useSessionStore.getState().sessions.c1.some((s) => s.key === body.key)).toBe(true);
  });

  it("shows the list first on a phone, opens a chat, and goes back", async () => {
    seedSessions();
    setWidth(390);
    const user = userEvent.setup();
    render(<AssistantPage />);

    await user.click(await screen.findByRole("tab", { name: "聊天" }));
    expect(screen.getByRole("list", { name: "会话" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /返回/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /旧话题/ }));
    expect(useSessionStore.getState().activeSessionKey.c1).toBe("s-old");
    expect(screen.queryByRole("list", { name: "会话" })).toBeNull();
    expect(screen.getByTestId("chat-window")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /返回/ }));
    expect(screen.getByRole("list", { name: "会话" })).toBeTruthy();
  });
});

describe("AssistantPage item discussion", () => {
  function seedResident() {
    useConnectionStore.setState({ connections: [{ id: "c1", name: "Bot", connected: true }], activeConnectionId: "c1" });
    useSessionStore.setState({
      sessions: { c1: [{ key: "home", connectionId: "c1", createdAt: 1, lastActiveAt: 1, isResident: true }] },
      activeSessionKey: { c1: "home" },
    });
  }

  const sessionPosts = () => platformMock.fetchApiRaw.mock.calls.filter(([p]) => p === "/api/sessions");

  /** /api/sessions waits until `release` is called, then answers with `answer`. */
  function gateSessionPost(answer: () => ReturnType<typeof respond> = () => respond(200, { ok: true })) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    platformMock.fetchApiRaw.mockImplementation(async (path: string) => {
      if (path === "/api/assistant/board") return respond(200, board);
      if (path === "/api/sessions") {
        await gate;
        return answer();
      }
      return respond(200, {});
    });
    return () => release();
  }

  it("creates the item session once and sends one opening message when 讨论 is clicked twice", async () => {
    seedResident();
    const release = gateSessionPost();
    const user = userEvent.setup();
    render(<AssistantPage />);

    const row = (await screen.findByText("去图书馆还书")).closest("li")!;
    const button = within(row).getByRole("button", { name: "讨论" });
    await user.click(button);
    await user.click(button);
    expect(sessionPosts()).toHaveLength(1);
    expect(platformMock.sendWsMessage).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(useSessionStore.getState().activeSessionKey.c1).toBe("item-1"));
    expect(sessionPosts()).toHaveLength(1);
    expect(platformMock.sendWsMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the server answers 500", () => respond(500, { error: "boom" })],
    ["the server does not confirm", () => respond(200, {})],
  ])("does not send the opening message when %s", async (_label, answer) => {
    seedResident();
    gateSessionPost(answer)();
    const user = userEvent.setup();
    render(<AssistantPage />);

    const row = (await screen.findByText("去图书馆还书")).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "讨论" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "没建成，稍后再试");
    expect(platformMock.sendWsMessage).not.toHaveBeenCalled();
    expect(useSessionStore.getState().activeSessionKey.c1).toBe("home");
    expect(useSessionStore.getState().sessions.c1.some((s) => s.key === "item-1")).toBe(false);
  });

  it("creates one new topic when 新话题 is clicked twice on a phone", async () => {
    seedResident();
    setWidth(390);
    const release = gateSessionPost();
    const user = userEvent.setup();
    render(<AssistantPage />);

    await user.click(await screen.findByRole("tab", { name: "聊天" }));
    const button = screen.getByRole("button", { name: /新话题/ });
    await user.click(button);
    await user.click(button);
    expect(sessionPosts()).toHaveLength(1);

    release();
    await waitFor(() => expect(useSessionStore.getState().activeSessionKey.c1).toMatch(/^session-\d+$/));
    expect(sessionPosts()).toHaveLength(1);
  });

  it("says so when a new topic could not be created", async () => {
    seedResident();
    gateSessionPost(() => respond(500, {}))();
    const user = userEvent.setup();
    render(<AssistantPage />);

    await user.click(await screen.findByRole("button", { name: /全部会话/ }));
    await user.click(screen.getByRole("button", { name: /新话题/ }));

    expect(await screen.findByText("没建成，稍后再试")).toBeTruthy();
    expect(useSessionStore.getState().activeSessionKey.c1).toBe("home");
  });

  it("opens a new item session and sends the opening message once", async () => {
    seedResident();
    const user = userEvent.setup();
    render(<AssistantPage />);

    const row = (await screen.findByText("去图书馆还书")).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "讨论" }));

    await waitFor(() => expect(useSessionStore.getState().activeSessionKey.c1).toBe("item-1"));
    expect(sessionPosts()).toHaveLength(1);
    expect(JSON.parse(String(sessionPosts()[0][1].body))).toEqual({
      connectionId: "c1",
      key: "item-1",
      label: "事项：去图书馆还书",
    });
    expect(platformMock.sendWsMessage).toHaveBeenCalledTimes(1);
    const [msg] = platformMock.sendWsMessage.mock.calls[0];
    expect(msg).toMatchObject({ connectionId: "c1", sessionKey: "item-1" });
    expect(msg.content).toContain("我们来聊聊这件事：去图书馆还书");
    expect(msg.content).toContain("09:00");
    expect(msg.content).toContain("细节：带借书卡");
    expect(msg.content).toContain("相关的人：王小明");
    // Shows in the chat like a typed message, and the item label survives.
    expect(useMessageStore.getState().messagesByChat["c1::item-1"]?.[0]).toMatchObject({ role: "user", content: msg.content });
    expect(useSessionStore.getState().sessions.c1.find((s) => s.key === "item-1")?.label).toBe("事项：去图书馆还书");

    // Second time: just switch back to it.
    useSessionStore.getState().setActiveSession("c1", "home");
    await user.click(within(row).getByRole("button", { name: "讨论" }));
    expect(useSessionStore.getState().activeSessionKey.c1).toBe("item-1");
    expect(sessionPosts()).toHaveLength(1);
    expect(platformMock.sendWsMessage).toHaveBeenCalledTimes(1);
  });

  it("leaves empty fields out of the opening message", async () => {
    seedResident();
    const user = userEvent.setup();
    render(<AssistantPage />);

    await expandUndated(user);
    const row = (await screen.findByText("整理书架")).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "讨论" }));

    await waitFor(() => expect(platformMock.sendWsMessage).toHaveBeenCalledTimes(1));
    const content = platformMock.sendWsMessage.mock.calls[0][0].content as string;
    expect(content).toContain("时间：没定日期");
    expect(content).not.toContain("细节：");
    expect(content).not.toContain("相关的人：");
  });

  it("can start from a day in the week strip", async () => {
    seedResident();
    const user = userEvent.setup();
    render(<AssistantPage />);

    const day = await screen.findByTestId(`week-${tomorrow}`);
    await user.click(within(day).getByRole("button", { name: "讨论：交周报" }));

    await waitFor(() => expect(useSessionStore.getState().activeSessionKey.c1).toBe("item-2"));
  });

  it("jumps to the chat tab on a phone", async () => {
    seedResident();
    setWidth(390);
    const user = userEvent.setup();
    render(<AssistantPage />);

    const row = (await screen.findByText("去图书馆还书")).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "讨论" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "聊天" }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("button", { name: /返回/ })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "会话" })).toBeNull();
  });
});

describe("AssistantPage deliverables and threads", () => {
  const deliverables = [
    { id: 1, itemId: 4, sessionKey: "item-4", title: "示例周报草稿", path: "/hywork/产出/示例/周报.md", summary: "按上周记录整理的初稿", status: "new", createdAt: `${today}T09:05:00` },
    { id: 2, itemId: null, sessionKey: null, title: "示例数据表", path: "/hywork/产出/示例/数据.xlsx", summary: "", status: "seen", createdAt: `${today}T08:00:00` },
    { id: 3, itemId: null, sessionKey: null, title: "用过的清单", path: "/hywork/产出/示例/清单.txt", summary: "", status: "used", createdAt: "2026-01-02T08:00:00" },
    { id: 4, itemId: null, sessionKey: null, title: "没用上的稿子", path: "/hywork/产出/示例/稿子.docx", summary: "", status: "dismissed", createdAt: "2026-01-01T08:00:00" },
  ];
  const threads = [
    { sessionKey: "item-4", itemId: 4, title: "整理书架", status: "running", progress: "查完一半", updatedAt: `${today}T09:00:00` },
    { sessionKey: "item-1", itemId: 1, title: "去图书馆还书", status: "done", progress: "", updatedAt: `${today}T09:00:00` },
    { sessionKey: "s-new", itemId: null, title: "周报怎么写", status: "stuck", progress: "", updatedAt: `${today}T09:00:00` },
  ];
  const fullBoard = { ...board, deliverables, threads };

  let fileResponse: () => unknown;
  function mockAll(body: unknown = fullBoard) {
    platformMock.fetchApiRaw.mockImplementation(async (path: string) => {
      if (path === "/api/assistant/board") return respond(200, body);
      if (path.endsWith("/file")) return fileResponse();
      return respond(200, {});
    });
  }
  const deliverablePosts = () =>
    platformMock.fetchApiRaw.mock.calls
      .filter(([p]) => String(p).startsWith("/api/assistant/deliverables/") && String(p).endsWith("/status"))
      .map(([p, init]) => [p, JSON.parse(String(init?.body))]);
  const boardLoads = () => platformMock.fetchApiRaw.mock.calls.filter(([p]) => p === "/api/assistant/board").length;

  function seed() {
    useConnectionStore.setState({ connections: [{ id: "c1", name: "Bot", connected: true }], activeConnectionId: "c1" });
    useSessionStore.setState({
      sessions: {
        c1: [
          { key: "home", connectionId: "c1", createdAt: 1, lastActiveAt: 50, isResident: true },
          { key: "item-4", connectionId: "c1", createdAt: 1, lastActiveAt: 200, label: "事项：整理书架" },
          { key: "s-new", connectionId: "c1", createdAt: 1, lastActiveAt: 300, label: "周报怎么写" },
          { key: "s-plain", connectionId: "c1", createdAt: 1, lastActiveAt: 100, label: "闲聊" },
        ],
      },
      activeSessionKey: { c1: "home" },
    });
  }

  beforeEach(() => {
    fileResponse = () => respond(404, {});
    mockAll();
  });

  it("lists what 蟹哥 made under 今天, with a status tag on each", async () => {
    render(<AssistantPage />);
    const section = (await screen.findByRole("heading", { name: /蟹哥做好的/ })).closest("section")!;
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
    const at = (name: string) => headings.findIndex((h) => h.includes(name));
    expect(at("蟹哥做好的")).toBe(at("今天") + 1);

    const rows = within(section).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain("示例周报草稿");
    expect(rows[0].textContent).toContain("按上周记录整理的初稿");
    expect(rows[0].textContent).toContain("09:05");
    expect(within(rows[0]).getByText("待你看")).toBeTruthy();
    expect(within(rows[1]).getByText("已看")).toBeTruthy();
    expect(within(rows[2]).getByText("已用")).toBeTruthy();
    expect(within(rows[3]).getByText("不用了", { selector: "[data-testid='deliverable-status']" })).toBeTruthy();
    for (const row of rows) {
      expect(within(row).getByRole("button", { name: "打开" })).toBeTruthy();
      expect(within(row).getByRole("button", { name: "用了" })).toBeTruthy();
      expect(within(row).getByRole("button", { name: "不用了" })).toBeTruthy();
    }
  });

  it("leaves the section out when there is nothing", async () => {
    mockAll({ ...board, deliverables: [], threads: [] });
    render(<AssistantPage />);
    expect(await screen.findByText("去图书馆还书")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /蟹哥做好的/ })).toBeNull();
  });

  it("works with a board that has no deliverables field at all", async () => {
    mockAll(board);
    render(<AssistantPage />);
    expect(await screen.findByText("去图书馆还书")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /蟹哥做好的/ })).toBeNull();
  });

  it("shows a text file on the page with a copy button, and marks it seen the first time", async () => {
    fileResponse = () => ({ ok: true, status: 200, text: async () => "# 示例周报\n第一段" });
    const writeText = vi.fn(async () => {});
    // After setup: userEvent installs its own clipboard stub.
    const user = userEvent.setup();
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<AssistantPage />);
    const section = (await screen.findByRole("heading", { name: /蟹哥做好的/ })).closest("section")!;
    const row = within(section).getAllByRole("listitem")[0];

    await user.click(within(row).getByRole("button", { name: "打开" }));
    const dialog = await screen.findByRole("dialog", { name: "示例周报草稿" });
    expect(dialog.textContent).toContain("# 示例周报");
    expect(dialog.textContent).toContain("第一段");
    expect(platformMock.fetchApiRaw).toHaveBeenCalledWith("/api/assistant/deliverables/1/file");
    await waitFor(() => expect(deliverablePosts()).toEqual([["/api/assistant/deliverables/1/status", { status: "seen" }]]));

    await user.click(within(dialog).getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith("# 示例周报\n第一段");
    expect(await within(dialog).findByRole("button", { name: "已复制" })).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("downloads other files and does not re-mark one already seen", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    fileResponse = () => ({ ok: true, status: 200, blob: async () => blob });
    const createObjectURL = vi.fn(() => "blob:test-1");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicks: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this);
    });
    try {
      const user = userEvent.setup();
      render(<AssistantPage />);
      const section = (await screen.findByRole("heading", { name: /蟹哥做好的/ })).closest("section")!;
      await user.click(within(within(section).getAllByRole("listitem")[1]).getByRole("button", { name: "打开" }));
      await waitFor(() => expect(clicks).toHaveLength(1));
      expect(createObjectURL).toHaveBeenCalledWith(blob);
      expect(clicks[0].download).toBe("数据.xlsx");
      expect(clicks[0].href).toBe("blob:test-1");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(deliverablePosts()).toEqual([]);
    } finally {
      click.mockRestore();
    }
  });

  it("says so when a file cannot be opened", async () => {
    fileResponse = () => respond(404, {});
    const user = userEvent.setup();
    render(<AssistantPage />);
    const section = (await screen.findByRole("heading", { name: /蟹哥做好的/ })).closest("section")!;
    await user.click(within(within(section).getAllByRole("listitem")[1]).getByRole("button", { name: "打开" }));
    expect(await within(section).findByText("没打开，稍后再试")).toBeTruthy();
  });

  it("marks a deliverable used or not needed, then reloads", async () => {
    const user = userEvent.setup();
    render(<AssistantPage />);
    const section = (await screen.findByRole("heading", { name: /蟹哥做好的/ })).closest("section")!;
    const loads = boardLoads();
    await user.click(within(within(section).getAllByRole("listitem")[0]).getByRole("button", { name: "用了" }));
    await user.click(within(within(section).getAllByRole("listitem")[1]).getByRole("button", { name: "不用了" }));
    await waitFor(() =>
      expect(deliverablePosts()).toEqual([
        ["/api/assistant/deliverables/1/status", { status: "used" }],
        ["/api/assistant/deliverables/2/status", { status: "dismissed" }],
      ]),
    );
    await waitFor(() => expect(boardLoads()).toBeGreaterThanOrEqual(loads + 2));
  });

  it("removes a deliverable right away on 不用了, keeps it on 用了", async () => {
    const user = userEvent.setup();
    // Like the server: the board no longer lists it once dismissed.
    const gone = new Set<number>();
    platformMock.fetchApiRaw.mockImplementation(async (path: string, init?: { body?: string }) => {
      const m = /deliverables\/(\d+)\/status/.exec(path);
      if (m) {
        if (JSON.parse(String(init?.body)).status === "dismissed") gone.add(Number(m[1]));
        return respond(200, {});
      }
      if (path === "/api/assistant/board") {
        return respond(200, { ...fullBoard, deliverables: deliverables.filter((d) => !gone.has(d.id)) });
      }
      return respond(200, {});
    });
    render(<AssistantPage />);
    const section = (await screen.findByRole("heading", { name: /蟹哥做好的/ })).closest("section")!;
    await user.click(within(within(section).getAllByRole("listitem")[1]).getByRole("button", { name: "不用了" }));
    await waitFor(() => expect(within(section).queryByText("示例数据表")).toBeNull());
    await user.click(within(within(section).getAllByRole("listitem")[0]).getByRole("button", { name: "用了" }));
    await waitFor(() => expect(deliverablePosts()).toHaveLength(2));
    expect(within(section).getByText("示例周报草稿")).toBeTruthy();
  });

  it("truncates the summary on one line with a title, and toggles the full text on click", async () => {
    const user = userEvent.setup();
    render(<AssistantPage />);
    await screen.findByRole("heading", { name: /蟹哥做好的/ });
    const summary = screen.getAllByTestId("deliverable-summary")[0];
    expect(summary.className).toContain("truncate");
    expect(summary.getAttribute("title")).toContain("按上周记录整理的初稿");
    await user.click(summary);
    expect(summary.className).not.toContain("truncate");
    await user.click(summary);
    expect(summary.className).toContain("truncate");
  });

  it("shows each thread's status in the session list and on its item", async () => {
    seed();
    const user = userEvent.setup();
    render(<AssistantPage />);

    // Item rows: 去图书馆还书 is done, 整理书架 (folded under 没定日期) is in progress.
    const todayRow = (await screen.findByText("去图书馆还书")).closest("li")!;
    expect(within(todayRow).getByTestId("thread-status").textContent).toContain("做好了");
    await expandUndated(user);
    const shelfRow = screen.getByText("整理书架", { selector: "div" }).closest("li")!;
    const shelf = within(shelfRow).getByTestId("thread-status");
    expect(shelf.textContent).toContain("在做");
    expect(shelf.textContent).toContain("查完一半");
    expect(within(screen.getByText("交周报").closest("li")!).queryByTestId("thread-status")).toBeNull();

    await user.click(screen.getByRole("button", { name: /全部会话/ }));
    const list = screen.getByRole("list", { name: "会话" });
    const rowFor = (name: RegExp) => within(list).getByRole("button", { name });
    expect(within(rowFor(/整理书架/)).getByTestId("thread-status").textContent).toContain("在做");
    expect(within(rowFor(/整理书架/)).getByTestId("thread-status").textContent).toContain("查完一半");
    expect(within(rowFor(/周报怎么写/)).getByTestId("thread-status").textContent).toContain("卡住了");
    expect(within(rowFor(/闲聊/)).queryByTestId("thread-status")).toBeNull();
  });

  it("refreshes the board, the session list and the open chat on assistant-session-updated", async () => {
    seed();
    render(<AssistantPage />);
    await screen.findByRole("heading", { name: /蟹哥做好的/ });
    const loads = boardLoads();
    platformMock.fetchApi.mockClear();

    act(() => emitAssistantSessionUpdated({ connectionId: "c1", sessionKey: "item-4" }));

    await waitFor(() => expect(boardLoads()).toBe(loads + 1));
    await waitFor(() => expect(platformMock.fetchApi).toHaveBeenCalledWith("/api/sessions?connectionId=c1"));
  });

  it("handles a burst of assistant-session-updated events as one refresh", async () => {
    seed();
    render(<AssistantPage />);
    await screen.findByRole("heading", { name: /蟹哥做好的/ });
    const loads = boardLoads();
    platformMock.fetchApi.mockClear();

    act(() => {
      emitAssistantSessionUpdated({ connectionId: "c1", sessionKey: "item-4" });
      emitAssistantSessionUpdated({ connectionId: "c1", sessionKey: "item-5" });
      emitAssistantSessionUpdated({ connectionId: "c1", sessionKey: "item-4" });
    });

    await waitFor(() => expect(platformMock.fetchApi).toHaveBeenCalledWith("/api/sessions?connectionId=c1"));
    await new Promise((r) => setTimeout(r, 400));
    expect(boardLoads()).toBe(loads + 1);
    const listCalls = platformMock.fetchApi.mock.calls.filter(([p]) => p === "/api/sessions?connectionId=c1");
    expect(listCalls).toHaveLength(1);
  });
});

describe("AssistantPage progress strip", () => {
  const pad = (n: number) => String(n).padStart(2, "0");
  /** Local time `minutes` ago, in the backend's zone-less format. */
  function ago(minutes: number): string {
    const d = new Date(Date.now() - minutes * 60_000);
    return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function thread(over: Record<string, unknown> & { sessionKey: string; title: string }) {
    return {
      itemId: null, status: "running", progress: "", parent: "home", createdBy: "assistant",
      createdAt: ago(12), updatedAt: ago(1), ...over,
    };
  }
  const threads = [
    thread({ sessionKey: "task-1", title: "示例报价单", progress: "资料找齐了" }),
    thread({ sessionKey: "task-2", title: "示例会议纪要", status: "done", createdAt: ago(90), updatedAt: ago(30) }),
    thread({ sessionKey: "task-3", title: "示例通知稿", status: "stuck", createdAt: ago(150) }),
    thread({ sessionKey: "task-4", title: "别人派的活", parent: "item-2" }),
    thread({ sessionKey: "task-5", title: "后台自己派的", parent: null, createdBy: "planner", status: "done", createdAt: ago(200), updatedAt: ago(100) }),
    thread({ sessionKey: "task-6", title: "前天做完的", status: "done", updatedAt: ago(60 * 30) }),
    thread({ sessionKey: "task-9", title: "聊完的讨论", parent: null, createdBy: "web", status: "done", updatedAt: ago(10) }),
    thread({ sessionKey: "task-10", title: "在聊的讨论", parent: null, createdBy: "web", createdAt: ago(300) }),
  ];
  const deliverables = [
    { id: 7, itemId: null, sessionKey: "task-2", title: "示例会议纪要", path: "/out/纪要.md", summary: "", status: "new", createdAt: ago(30) },
  ];
  let body: unknown;
  let fileResponse: () => unknown;

  function seed() {
    useConnectionStore.setState({ connections: [{ id: "c1", name: "Bot", connected: true }], activeConnectionId: "c1" });
    useSessionStore.setState({
      sessions: {
        c1: [
          { key: "home", connectionId: "c1", createdAt: 1, lastActiveAt: 50, isResident: true },
          { key: "task-1", connectionId: "c1", createdAt: 1, lastActiveAt: 40, label: "示例报价单" },
        ],
      },
      activeSessionKey: { c1: "home" },
    });
  }

  beforeEach(() => {
    body = { ...board, deliverables, threads };
    fileResponse = () => ({ ok: true, status: 200, text: async () => "# 示例纪要" });
    platformMock.fetchApiRaw.mockImplementation(async (path: string) => {
      if (path === "/api/assistant/board") return respond(200, body);
      if (path.endsWith("/file")) return fileResponse();
      return respond(200, {});
    });
    seed();
  });

  const strip = () => screen.findByRole("region", { name: "派出去的活" });
  const rowTexts = (el: HTMLElement) => within(el).getAllByRole("listitem").map((li) => li.textContent ?? "");

  it("lists unfinished threads of any origin plus recent done ones, each with a source tag, above the chat", async () => {
    render(<AssistantPage />);
    const el = await strip();
    // 4 unfinished + 2 done: compact shows the unfinished ones first
    const rows = rowTexts(el);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("卡住了");
    expect(rows[0]).toContain("示例通知稿");
    expect(rows[0]).toContain("主会话派的");
    expect(rows[0]).toContain("2 小时 30 分钟");
    expect(rows[3]).toContain("在聊的讨论");
    expect(rows[3]).toContain("讨论");
    expect(rows.find((r) => r.includes("示例报价单"))).toContain("资料找齐了");
    expect(rows.find((r) => r.includes("示例报价单"))).toContain("12 分钟");
    expect(rows.find((r) => r.includes("别人派的活"))).toContain("子会话派的");
    expect(rows.join()).not.toContain("前天做完的");
    expect(rows.join()).not.toContain("聊完的讨论");
    await userEvent.setup().click(within(el).getByRole("button", { name: "还有 2 个已完成" }));
    const all = rowTexts(el);
    expect(all).toHaveLength(6);
    expect(all[4]).toContain("示例会议纪要");
    expect(all[4]).toContain("用了 1 小时");
    expect(all[5]).toContain("后台自己派的");
    expect(all[5]).toContain("自动起草");
    expect(all.join()).not.toContain("聊完的讨论");
    // Above the chat, inside the chat column.
    const chat = screen.getByTestId("chat-window");
    expect(el.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("region", { name: "聊天" }).contains(el)).toBe(true);
  });

  it("switches to a sub-session on click, and the strip goes away there", async () => {
    const user = userEvent.setup();
    render(<AssistantPage />);
    await user.click(within(await strip()).getByRole("button", { name: /示例报价单/ }));
    expect(useSessionStore.getState().activeSessionKey.c1).toBe("task-1");
    expect(screen.queryByRole("region", { name: "派出去的活" })).toBeNull();
  });

  it("opens the finished file from its row", async () => {
    const user = userEvent.setup();
    render(<AssistantPage />);
    const el = await strip();
    await user.click(within(el).getByRole("button", { name: /还有 2 个已完成/ }));
    const done = within(el).getAllByRole("listitem")[4];
    expect(within(el).getAllByRole("button", { name: "打开成品" })).toHaveLength(1);
    await user.click(within(done).getByRole("button", { name: "打开成品" }));
    expect((await screen.findByRole("dialog", { name: "示例会议纪要" })).textContent).toContain("# 示例纪要");
    expect(platformMock.fetchApiRaw).toHaveBeenCalledWith("/api/assistant/deliverables/7/file");
    expect(useSessionStore.getState().activeSessionKey.c1).toBe("home");
  });

  it("is not shown when there is nothing to list", async () => {
    body = { ...board, threads: [threads[5], threads[2 + 3]] };
    render(<AssistantPage />);
    expect(await screen.findByText("去图书馆还书")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "派出去的活" })).toBeNull();
  });

  it("folds, and remembers that across a reload", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AssistantPage />);
    const toggle = within(await strip()).getByRole("button", { name: /派出去的活/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("3 个在做，1 个卡住了，2 个做好了");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(await strip()).queryAllByRole("listitem")).toHaveLength(0);
    unmount();

    render(<AssistantPage />);
    const again = within(await strip()).getByRole("button", { name: /派出去的活/ });
    expect(again.getAttribute("aria-expanded")).toBe("false");
    await user.click(again);
    expect(within(await strip()).getAllByRole("listitem")).toHaveLength(4);
  });

  it("with more than 3 rows shows the unfinished ones first and folds the finished", async () => {
    body = {
      ...board,
      threads: [
        ...threads,
        thread({ sessionKey: "task-7", title: "示例名单", status: "done", updatedAt: ago(5) }),
        thread({ sessionKey: "task-8", title: "示例日程表" }),
      ],
    };
    const user = userEvent.setup();
    render(<AssistantPage />);
    const el = await strip();
    expect(rowTexts(el).map((t) => t.includes("做好了"))).toEqual([false, false, false, false, false]);
    await user.click(within(el).getByRole("button", { name: "还有 3 个已完成" }));
    expect(rowTexts(el)).toHaveLength(8);
    expect(within(el).queryByRole("button", { name: /还有/ })).toBeNull();
  });

  it("sits above the main chat on a phone too", async () => {
    setWidth(390);
    const user = userEvent.setup();
    render(<AssistantPage />);
    await user.click(await screen.findByRole("tab", { name: "聊天" }));
    await user.click(await screen.findByRole("button", { name: /个人助理-主会话/ }));
    const el = await strip();
    expect(rowTexts(el)).toHaveLength(4);
    const chat = screen.getByTestId("chat-window");
    expect(el.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("AssistantPage opened from a notification", () => {
  function seed() {
    useConnectionStore.setState({ connections: [{ id: "c1", name: "Bot", connected: true }], activeConnectionId: "c1" });
    useSessionStore.setState({
      sessions: {
        c1: [
          { key: "home", connectionId: "c1", createdAt: 1, lastActiveAt: 50, isResident: true },
          { key: "task-1", connectionId: "c1", createdAt: 1, lastActiveAt: 40, label: "示例报价单" },
        ],
      },
      activeSessionKey: { c1: "home" },
    });
  }
  let sw: EventTarget;
  beforeEach(() => {
    sw = new EventTarget();
    Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: sw });
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
  });
  const post = (data: unknown) => act(() => {
    sw.dispatchEvent(Object.assign(new Event("message"), { data }));
  });

  it("opens the session named in the URL once the resident shows up, and cleans the URL", async () => {
    window.history.replaceState(null, "", "/?openConnection=c1&openSession=task-1");
    render(<AssistantPage />);
    expect(await screen.findByText("去图书馆还书")).toBeTruthy();
    expect(window.location.search).toBe("");
    act(() => seed());
    await waitFor(() => expect(useSessionStore.getState().activeSessionKey.c1).toBe("task-1"));
  });

  it("switches to the session a click on a notification asks for, on a phone too", async () => {
    setWidth(390);
    seed();
    render(<AssistantPage />);
    expect(await screen.findByText("去图书馆还书")).toBeTruthy();
    post({ type: OPEN_SESSION_MESSAGE, connectionId: "c1", sessionKey: "task-1" });
    await waitFor(() => expect(useSessionStore.getState().activeSessionKey.c1).toBe("task-1"));
    expect(screen.getByRole("tab", { name: "聊天" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("去图书馆还书")).toBeNull();
  });

  it("ignores requests for another connection or of another type", async () => {
    seed();
    render(<AssistantPage />);
    expect(await screen.findByText("去图书馆还书")).toBeTruthy();
    post({ type: OPEN_SESSION_MESSAGE, connectionId: "c9", sessionKey: "task-1" });
    post({ type: "something-else", connectionId: "c1", sessionKey: "task-1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(useSessionStore.getState().activeSessionKey.c1).toBe("home");
  });
});
