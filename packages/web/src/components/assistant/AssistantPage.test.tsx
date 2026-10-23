import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistantPage } from "./AssistantPage.js";
import { localDate, nextWeekDates, type AssistantItem } from "../../lib/assistantBoard.js";
import { useUIStore } from "../../lib/store/ui.js";
import { useConnectionStore } from "../../lib/store/connection.js";
import { useSessionStore } from "../../lib/store/session.js";

const platformMock = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  fetchApiRaw: vi.fn(),
}));

vi.mock("../../lib/platform.js", () => ({
  getPlatform: () => ({ fetchApi: platformMock.fetchApi, fetchApiRaw: platformMock.fetchApiRaw }),
}));

// The real chat is covered elsewhere; here we only care that it is shown.
vi.mock("../ChatWindow.js", () => ({ ChatWindow: () => <div data-testid="chat-window" /> }));

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
    return respond(200, {});
  });
}

function statusCalls() {
  return platformMock.fetchApiRaw.mock.calls
    .filter(([path]) => String(path).startsWith("/api/assistant/items/"))
    .map(([path, init]) => [path, JSON.parse(String(init?.body))]);
}

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

beforeEach(() => {
  cleanup();
  setWidth(1280);
  useUIStore.setState({ isMobile: false });
  useConnectionStore.setState({ connections: [], activeConnectionId: null });
  useSessionStore.setState({ sessions: {}, activeSessionKey: {}, unread: {}, taskStateByConnection: {} });
  platformMock.fetchApi.mockReset();
  platformMock.fetchApi.mockResolvedValue({});
  platformMock.fetchApiRaw.mockReset();
  mockBoard();
});

describe("AssistantPage", () => {
  it("renders the board sections with their items", async () => {
    render(<AssistantPage />);

    expect(await screen.findByText("去图书馆还书")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "秋来" })).toBeTruthy();
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
    expect(screen.getByText("整理书架")).toBeTruthy();
    expect(screen.getByText(/事项更新于 \d\d:\d\d/)).toBeTruthy();
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

  it("says the data is not ready on 503", async () => {
    mockBoard(503, { error: "not ready" });
    render(<AssistantPage />);

    expect(await screen.findByText("秋来的数据还没准备好")).toBeTruthy();
  });

  it("says 秋来 is not set up when there is no resident session", async () => {
    useConnectionStore.setState({ connections: [{ id: "c1", name: "Bot", connected: true }], activeConnectionId: "c1" });
    useSessionStore.setState({
      sessions: { c1: [{ key: "s1", connectionId: "c1", createdAt: 1, lastActiveAt: 1 }] },
      activeSessionKey: { c1: "s1" },
    });
    render(<AssistantPage />);

    expect(await screen.findByText("秋来还没配置好")).toBeTruthy();
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
    expect(screen.getByText("秋来还没配置好")).toBeTruthy();
  });
});
