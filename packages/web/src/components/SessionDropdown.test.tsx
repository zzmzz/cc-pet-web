import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeChatKey } from "@cc-pet/shared";
import { SessionDropdown, formatSessionPhase } from "./SessionDropdown.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { useMessageStore } from "../lib/store/message.js";
import { useSessionStore } from "../lib/store/session.js";
import { useUIStore } from "../lib/store/ui.js";

const fetchApi = vi.fn().mockResolvedValue({ ok: true });

vi.mock("../lib/platform.js", () => ({
  getPlatform: () => ({ fetchApi }),
}));

function resetStores() {
  localStorage.clear();
  useConnectionStore.setState({ connections: [], activeConnectionId: null });
  useMessageStore.setState({
    messagesByChat: {},
    streamingContent: {},
    previewMessages: {},
    loadedChatKeys: new Set(),
  });
  useSessionStore.setState({
    sessions: {},
    activeSessionKey: {},
    unread: {},
    taskStateByConnection: {},
    lazyLoadChat: null,
    stickySessionByConnection: {},
  });
}

describe("formatSessionPhase", () => {
  it("maps shared TaskPhase and legacy bridge aliases to zh labels", () => {
    expect(formatSessionPhase("idle")).toBe("空闲");
    expect(formatSessionPhase("thinking")).toBe("思考中");
    expect(formatSessionPhase("processing")).toBe("处理中");
    expect(formatSessionPhase("working")).toBe("处理中");
    expect(formatSessionPhase("waiting_confirm")).toBe("待确认");
    expect(formatSessionPhase("awaiting_confirmation")).toBe("待确认");
    expect(formatSessionPhase("completed")).toBe("已完成");
    expect(formatSessionPhase("failed")).toBe("失败");
    expect(formatSessionPhase("possibly_stuck")).toBe("可能卡住");
    expect(formatSessionPhase("stalled")).toBe("可能卡住");
  });
});

describe("SessionDropdown", () => {
  beforeEach(() => {
    cleanup();
    resetStores();
    fetchApi.mockClear();
    fetchApi.mockResolvedValue({ ok: true });
  });

  it("renders CC Pet when there is no active connection", () => {
    render(<SessionDropdown />);
    expect(screen.getByText("CC Pet")).toBeInTheDocument();
  });

  it("renders CC Pet when single connection and no sessions", () => {
    useConnectionStore.setState({
      connections: [{ id: "c1", name: "B1", connected: false }],
      activeConnectionId: "c1",
    });
    render(<SessionDropdown />);
    expect(screen.getByText("CC Pet")).toBeInTheDocument();
  });

  it("shows 当前会话 / 最近会话, unread badges, phase labels, and 显示更多", async () => {
    const user = userEvent.setup();
    useConnectionStore.setState({
      connections: [{ id: "c1", name: "B1", connected: true }],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: {
        c1: [
          { key: "a", connectionId: "c1", label: "Alpha", createdAt: 1, lastActiveAt: 100 },
          { key: "b", connectionId: "c1", createdAt: 2, lastActiveAt: 200 },
          { key: "c", connectionId: "c1", createdAt: 3, lastActiveAt: 300 },
          { key: "d", connectionId: "c1", createdAt: 4, lastActiveAt: 400 },
        ],
      },
      activeSessionKey: { c1: "a" },
      unread: { [makeChatKey("c1", "a")]: 2, [makeChatKey("c1", "d")]: 5 },
      taskStateByConnection: {
        c1: {
          a: { activeRequestId: "r1", phase: "thinking", startedAt: 1, lastActivityAt: 1, firstTokenAt: null, stalledReason: null },
          d: { activeRequestId: "r2", phase: "working", startedAt: 2, lastActivityAt: 2, firstTokenAt: 2, stalledReason: null },
        },
      },
    });

    render(<SessionDropdown />);

    await user.click(screen.getByRole("button", { name: /Alpha/ }));

    expect(screen.getByText("当前会话")).toBeInTheDocument();
    expect(screen.getByText("最近会话")).toBeInTheDocument();
    expect(screen.getAllByText("思考中").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("处理中")).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText(/显示 1 个更旧的会话/)).toBeInTheDocument();

    await user.click(screen.getByText(/显示 1 个更旧的会话/));
    expect(screen.getByRole("button", { name: /b空闲/ })).toBeInTheDocument();
  });

  it("delete requires second click and calls DELETE API", async () => {
    const user = userEvent.setup();
    useConnectionStore.setState({
      connections: [{ id: "c1", name: "B1", connected: true }],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: {
        c1: [
          { key: "a", connectionId: "c1", createdAt: 1, lastActiveAt: 100 },
          { key: "b", connectionId: "c1", createdAt: 2, lastActiveAt: 200 },
        ],
      },
      activeSessionKey: { c1: "a" },
    });

    render(<SessionDropdown testShowDeleteButtons />);
    await user.click(screen.getByRole("button", { name: /a/ }));

    const deleteButtons = screen.getAllByTitle("删除会话");
    await user.click(deleteButtons[0]!);
    expect(screen.getByText("确认?")).toBeInTheDocument();

    await user.click(screen.getByText("确认?"));
    expect(fetchApi).toHaveBeenCalledWith("/api/sessions/c1/a", { method: "DELETE" });
    expect(useSessionStore.getState().sessions.c1?.map((s) => s.key)).toEqual(["b"]);
  });

  it("lists other connections when multiple bridges", async () => {
    const user = userEvent.setup();
    useConnectionStore.setState({
      connections: [
        { id: "c1", name: "First", connected: true },
        { id: "c2", name: "Second", connected: false },
      ],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: {
        c1: [{ key: "x", connectionId: "c1", createdAt: 1, lastActiveAt: 1 }],
      },
      activeSessionKey: { c1: "x" },
    });

    render(<SessionDropdown />);
    await user.click(screen.getByRole("button", { name: /First/ }));

    expect(screen.getByText("连接")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Second/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Second/ }));
    expect(useConnectionStore.getState().activeConnectionId).toBe("c2");
  });

  it("shows unread badge per connection as sum of its session unread counts", async () => {
    const user = userEvent.setup();
    useConnectionStore.setState({
      connections: [
        { id: "c1", name: "First", connected: true },
        { id: "c2", name: "Second", connected: true },
      ],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: {
        c1: [{ key: "a", connectionId: "c1", createdAt: 1, lastActiveAt: 1 }],
        c2: [{ key: "b", connectionId: "c2", createdAt: 2, lastActiveAt: 2 }],
      },
      activeSessionKey: { c1: "a", c2: "b" },
      unread: {
        [makeChatKey("c1", "a")]: 2,
        [makeChatKey("c1", "x")]: 3,
        [makeChatKey("c2", "b")]: 4,
      },
      taskStateByConnection: {},
    });

    render(<SessionDropdown />);
    await user.click(screen.getByRole("button", { name: /First/ }));

    const connectionSection = screen.getByText("连接").parentElement;
    expect(connectionSection).toBeTruthy();
    const connectionButtons = connectionSection?.querySelectorAll("button");
    expect(connectionButtons).toHaveLength(2);
    expect(connectionButtons?.[0]).toHaveTextContent("First");
    expect(connectionButtons?.[0]).toHaveTextContent("5");
    expect(connectionButtons?.[1]).toHaveTextContent("Second");
    expect(connectionButtons?.[1]).toHaveTextContent("4");
  });

  it("sorts connections by latest message time", async () => {
    const user = userEvent.setup();
    useConnectionStore.setState({
      connections: [
        { id: "c1", name: "First", connected: true },
        { id: "c2", name: "Second", connected: false },
      ],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: {
        c1: [{ key: "x", connectionId: "c1", createdAt: 1, lastActiveAt: 1 }],
      },
      activeSessionKey: { c1: "x" },
    });
    useMessageStore.setState({
      messagesByChat: {
        [makeChatKey("c2", "default")]: [
          {
            id: "m2",
            role: "assistant",
            content: "newest",
            timestamp: 2_000,
            connectionId: "c2",
            sessionKey: "default",
          },
        ],
        [makeChatKey("c1", "x")]: [
          {
            id: "m1",
            role: "assistant",
            content: "older",
            timestamp: 1_000,
            connectionId: "c1",
            sessionKey: "x",
          },
        ],
      },
      streamingContent: {},
    });

    render(<SessionDropdown variant="panel" />);

    const ordered = screen
      .getAllByRole("button")
      .map((el) => el.textContent ?? "")
      .filter((text) => text.includes("First") || text.includes("Second"));
    expect(ordered).toEqual(["Second", "First"]);

    await user.click(screen.getByRole("button", { name: /First/ }));
    expect(useConnectionStore.getState().activeConnectionId).toBe("c1");
  });

  it("shows resident session as a standalone top entry, separate from 最近会话, without a delete button", async () => {
    useConnectionStore.setState({
      connections: [{ id: "c1", name: "B1", connected: true }],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: {
        c1: [
          { key: "res", connectionId: "c1", label: "常驻助手", createdAt: 1, lastActiveAt: 100, isResident: true },
          { key: "a", connectionId: "c1", label: "Alpha", createdAt: 2, lastActiveAt: 200 },
          { key: "b", connectionId: "c1", label: "Beta", createdAt: 3, lastActiveAt: 300 },
        ],
      },
      activeSessionKey: { c1: "a" },
      unread: { [makeChatKey("c1", "res")]: 3 },
    });

    render(<SessionDropdown variant="panel" testShowDeleteButtons />);

    // (a) 常驻 label（含 📌）出现在顶部区块
    expect(screen.getByText("常驻")).toBeInTheDocument();
    expect(screen.getByText("📌 常驻助手")).toBeInTheDocument();

    // (b) 常驻不出现在「最近会话」列表：最近会话下只有 Beta，不含常驻的 label
    const recentHeading = screen.getByText("最近会话");
    const recentSection = recentHeading.parentElement;
    expect(recentSection).toHaveTextContent("Beta");
    expect(recentSection).not.toHaveTextContent("常驻助手");

    // (c) 常驻卡片区不含删除按钮——即便 testShowDeleteButtons 强开了删除按钮，
    // 而其余会话（最近会话中的 Beta）应能看到删除按钮，证明强开确实生效。
    const residentHeading = screen.getByText("常驻");
    const residentSection = residentHeading.parentElement;
    expect(residentSection?.querySelector('[title="删除会话"]')).toBeNull();
    expect(residentSection?.querySelector('[title="再次点击确认删除"]')).toBeNull();
    expect(screen.getAllByTitle("删除会话").length).toBeGreaterThan(0);
  });

  it("clicking the resident entry switches connection/session, clears unread, and calls the read API", async () => {
    const user = userEvent.setup();
    useConnectionStore.setState({
      connections: [
        { id: "c1", name: "First", connected: true },
        { id: "c2", name: "Second", connected: true },
      ],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: {
        c1: [{ key: "a", connectionId: "c1", createdAt: 1, lastActiveAt: 1 }],
        c2: [{ key: "res", connectionId: "c2", label: "常驻助手", createdAt: 1, lastActiveAt: 1, isResident: true }],
      },
      activeSessionKey: { c1: "a", c2: "res" },
      unread: { [makeChatKey("c2", "res")]: 3 },
    });

    render(<SessionDropdown variant="panel" />);

    await user.click(screen.getByText("📌 常驻助手"));

    expect(useConnectionStore.getState().activeConnectionId).toBe("c2");
    expect(useSessionStore.getState().activeSessionKey.c2).toBe("res");
    expect(useSessionStore.getState().unread[makeChatKey("c2", "res")]).toBeFalsy();
    expect(fetchApi).toHaveBeenCalledWith("/api/sessions/c2/res/read", { method: "POST" });
  });

  it("当激活的就是常驻会话时，不渲染「当前会话」行也不显示裸 key", async () => {
    useConnectionStore.setState({
      connections: [{ id: "c1", name: "First", connected: true }],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: {
        c1: [
          { key: "res", connectionId: "c1", label: "常驻助手", createdAt: 1, lastActiveAt: 100, isResident: true },
          { key: "beta", connectionId: "c1", label: "Beta", createdAt: 2, lastActiveAt: 2 },
        ],
      },
      activeSessionKey: { c1: "res" },
      unread: {},
      taskStateByConnection: {},
    });

    render(<SessionDropdown variant="panel" />);

    // 常驻仍以顶部独立入口呈现
    expect(screen.getByText("📌 常驻助手")).toBeInTheDocument();
    // 激活项是常驻 → listSessions 无对应项 → 不渲染「当前会话」行
    expect(screen.queryByText("当前会话")).toBeNull();
    // 不出现裸露的 session key 文案
    expect(screen.queryByText("res")).toBeNull();
  });

  it("新建会话：清掉该 chatKey 的客户端残留、把在途消息钉回旧会话、并要求清空输入框", async () => {
    const user = userEvent.setup();
    useConnectionStore.setState({
      connections: [{ id: "c1", name: "B1", connected: true }],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: { c1: [{ key: "old", connectionId: "c1", createdAt: 1, lastActiveAt: 100 }] },
      activeSessionKey: { c1: "old" },
      stickySessionByConnection: {},
    });
    const resetTokenBefore = useUIStore.getState().composerResetToken;

    // Freeze the generated key so the residue can be planted under it first.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const newKey = "session-1000";
    const newChatKey = makeChatKey("c1", newKey);
    useMessageStore.setState({
      messagesByChat: {
        [newChatKey]: [
          {
            id: "leaked",
            role: "assistant",
            content: "上一个会话漏过来的内容",
            timestamp: 1,
            connectionId: "c1",
            sessionKey: newKey,
          },
        ],
      },
      streamingContent: { [newChatKey]: "半截回复" },
    });

    render(<SessionDropdown variant="panel" />);
    await user.click(screen.getByText("新建会话"));

    expect(fetchApi).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ connectionId: "c1", key: newKey }),
    });
    expect(useSessionStore.getState().activeSessionKey.c1).toBe(newKey);
    expect(useMessageStore.getState().messagesByChat[newChatKey]).toBeUndefined();
    expect(useMessageStore.getState().streamingContent[newChatKey]).toBeUndefined();
    // Keyless replies still in flight belong to the session we just left.
    expect(useSessionStore.getState().stickySessionByConnection.c1).toBe("old");
    expect(useUIStore.getState().composerResetToken).toBe(resetTokenBefore + 1);

    nowSpy.mockRestore();
  });

  it("新建会话不覆盖已有的 sticky 会话", async () => {
    const user = userEvent.setup();
    useConnectionStore.setState({
      connections: [{ id: "c1", name: "B1", connected: true }],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: { c1: [{ key: "old", connectionId: "c1", createdAt: 1, lastActiveAt: 100 }] },
      activeSessionKey: { c1: "old" },
      stickySessionByConnection: { c1: "in-flight" },
    });

    render(<SessionDropdown variant="panel" />);
    await user.click(screen.getByText("新建会话"));

    expect(useSessionStore.getState().stickySessionByConnection.c1).toBe("in-flight");
  });

  it("uses shared theme classes for opened dropdown menu surface", async () => {
    const user = userEvent.setup();
    useConnectionStore.setState({
      connections: [{ id: "c1", name: "B1", connected: true }],
      activeConnectionId: "c1",
    });
    useSessionStore.setState({
      sessions: {
        c1: [{ key: "a", connectionId: "c1", createdAt: 1, lastActiveAt: 100 }],
      },
      activeSessionKey: { c1: "a" },
    });

    render(<SessionDropdown />);
    await user.click(screen.getByRole("button", { name: /a/ }));

    const panel = document.querySelector("div.z-50");
    expect(panel).toBeTruthy();
    expect(panel?.className).toContain("bg-surface-secondary");
    expect(panel?.className).toContain("border-border");
  });
});
