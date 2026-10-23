import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistantPage, BOARD_WIDE_KEY } from "./AssistantPage.js";
import { localDate, nextWeekDates, type AssistantItem } from "../../lib/assistantBoard.js";
import { useUIStore } from "../../lib/store/ui.js";
import { useConnectionStore } from "../../lib/store/connection.js";
import { useSessionStore } from "../../lib/store/session.js";
import { useMessageStore } from "../../lib/store/message.js";

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

/** 没定日期的待办 starts folded; open it. */
async function expandUndated(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /没定日期的待办/ }));
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
    const fold = screen.getByRole("button", { name: /没定日期的待办/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toContain("1");
    expect(screen.queryByText("整理书架")).toBeNull();
    await user.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("整理书架")).toBeTruthy();
    await user.click(fold);
    expect(screen.queryByText("整理书架")).toBeNull();
  });

  it("orders the sections: today, next week, waiting, farther, undated, recently closed", async () => {
    render(<AssistantPage />);

    await screen.findByText("去图书馆还书");
    const titles = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => (h.textContent ?? "").replace(/[\d▸▾\s]/g, ""));
    expect(titles).toEqual(["今天", "接下来一周", "等你回复", "更远", "没定日期的待办"]);
    const closed = screen.getByRole("button", { name: /最近 24 小时结案/ });
    const undated = screen.getByRole("heading", { name: /没定日期的待办/ });
    expect(undated.compareDocumentPosition(closed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(within(header).getByTestId("pet-mini")).toBeTruthy();
    expect(screen.queryByTestId("pet-full")).toBeNull();
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

  it("lists 总台, then 新话题, then the other sessions on the same connection, newest first", async () => {
    seedSessions();
    const user = userEvent.setup();
    render(<AssistantPage />);

    await user.click(await screen.findByRole("button", { name: /全部会话/ }));
    const rows = listRows();
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain("蟹哥 · 总台");
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

  it("opens a picked session and does not pull it back to 总台", async () => {
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
