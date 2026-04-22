import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WS_EVENTS, makeChatKey } from "@cc-pet/shared";
import type { PlatformAPI } from "./lib/platform.js";
import App from "./App.js";
import { applyIncomingWsSessionRouting, createWebAdapter } from "./lib/web-adapter.js";
import { useConnectionStore } from "./lib/store/connection.js";
import { useMessageStore } from "./lib/store/message.js";
import { useSessionStore } from "./lib/store/session.js";
import { useUIStore } from "./lib/store/ui.js";
import { useCommandStore } from "./lib/store/commands.js";

class FakeAdapter implements PlatformAPI {
  private handler: ((type: string, payload: any) => void) | null = null;

  connectWs = vi.fn();
  disconnectWs = vi.fn();
  sendWsMessage = vi.fn();

  fetchApi = vi.fn();

  onWsEvent(handler: (type: string, payload: any) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  emit(type: string, payload: any): void {
    const routed = applyIncomingWsSessionRouting(type, payload);
    this.handler?.(type, routed);
  }
}

const adapter = new FakeAdapter();
const fetchMock = vi.fn();
const requestPermissionMock = vi.fn<() => Promise<NotificationPermission>>();

vi.mock("./lib/web-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/web-adapter.js")>();
  return {
    ...actual,
    createWebAdapter: vi.fn(() => adapter),
  };
});

function defaultConnectSnapshot(bridges: { id: string; name: string }[]): void {
  queueMicrotask(() => {
    adapter.emit(WS_EVENTS.BRIDGE_MANIFEST, { bridges });
    for (const b of bridges) {
      adapter.emit(WS_EVENTS.BRIDGE_CONNECTED, { connectionId: b.id, connected: false });
    }
  });
}

function resetStores() {
  useConnectionStore.setState({ connections: [], activeConnectionId: null });
  useMessageStore.setState({ messagesByChat: {}, streamingContent: {} });
  useSessionStore.setState({ sessions: {}, activeSessionKey: {}, unread: {}, taskStateByConnection: {} });
  useUIStore.setState({
    chatOpen: true,
    petState: "idle",
    isMobile: false,
    settingsOpen: false,
  });
  useCommandStore.setState({ agentCommandsByConnection: {} });
}

const INPUT_PLACEHOLDER = "输入消息，Enter 发送，Shift+Enter 换行";

describe("App integration", () => {
  beforeEach(() => {
    requestPermissionMock.mockReset();
    requestPermissionMock.mockResolvedValue("granted");
    class MockNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = requestPermissionMock;
      onclick: ((this: Notification, ev: Event) => any) | null = null;
      onerror: ((this: Notification, ev: Event) => any) | null = null;
      close = vi.fn();
      constructor(_title: string, _options?: NotificationOptions) {}
    }
    vi.stubGlobal("Notification", MockNotification);

    vi.stubGlobal("fetch", fetchMock);
    cleanup();
    resetStores();
    localStorage.clear();
    localStorage.setItem("cc-pet-token", "test-token");
    adapter.connectWs.mockClear();
    adapter.disconnectWs.mockClear();
    adapter.sendWsMessage.mockClear();
    adapter.fetchApi.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true, name: "test", bridgeIds: ["cc-connect"] }),
    });
    adapter.fetchApi.mockImplementation(async () => ({}));
    adapter.connectWs.mockImplementation(() => {
      defaultConnectSnapshot([{ id: "cc-connect", name: "cc-connect" }]);
    });
    if (!window.HTMLElement.prototype.scrollIntoView) {
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
    }
  });

  it("uses same-origin adapter with stored token", async () => {
    localStorage.setItem("cc-pet-token", "legacy-token");
    render(<App />);

    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);
    expect(createWebAdapter).toHaveBeenCalledWith("", "legacy-token");
  });

  it("shows login gate when token missing and enters app after verification", async () => {
    localStorage.removeItem("cc-pet-token");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: true, name: "manual", bridgeIds: ["cc-connect"] }),
    });
    render(<App />);

    await screen.findByText("输入访问 Token");
    const input = screen.getByPlaceholderText("请输入 token");
    await userEvent.type(input, "manual-token");
    await userEvent.click(screen.getByRole("button", { name: "进入" }));

    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);
    expect(createWebAdapter).toHaveBeenCalledWith("", "manual-token");
  });

  it("shows connection status and updates to connected after bridge event", async () => {
    render(<App />);

    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);
    expect(
      useConnectionStore
        .getState()
        .connections.find((c) => c.id === "cc-connect")?.connected,
    ).toBe(false);

    adapter.emit(WS_EVENTS.BRIDGE_CONNECTED, {
      connectionId: "cc-connect",
      connected: true,
    });

    await waitFor(() => {
      expect(
        useConnectionStore
          .getState()
          .connections.find((c) => c.id === "cc-connect")?.connected,
      ).toBe(true);
    });
  });

  it("defers notification permission request on iOS until user interaction", async () => {
    const userAgentSpy = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      );
    try {
      render(<App />);
      await screen.findByPlaceholderText(INPUT_PLACEHOLDER);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(requestPermissionMock).not.toHaveBeenCalled();

      fireEvent.pointerDown(document.body);
      await waitFor(() => {
        expect(requestPermissionMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      userAgentSpy.mockRestore();
    }
  });

  it("shows switchable connection list in desktop sidebar when multiple bridges are configured", async () => {
    const user = userEvent.setup();
    adapter.connectWs.mockImplementation(() => {
      defaultConnectSnapshot([
        { id: "cc-connect", name: "cc-connect" },
        { id: "cs-connect", name: "cs-connect" },
      ]);
    });

    render(<App />);
    await screen.findByText("连接");
    expect(await screen.findByRole("button", { name: /cs-connect/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /cs-connect/i }));
    await waitFor(() => {
      expect(useConnectionStore.getState().activeConnectionId).toBe("cs-connect");
    });
  });

  it("keeps mobile session bar visible with sticky top layout", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 390,
    });
    window.dispatchEvent(new Event("resize"));
    try {
      render(<App />);
      await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

      await waitFor(() => {
        const banner = document.querySelector("header");
        const mobileRoot = banner?.parentElement;
        expect(banner).not.toBeNull();
        expect(mobileRoot).not.toBeNull();
        expect(banner?.className).toContain("sticky");
        expect(banner?.className).toContain("top-0");
        expect(mobileRoot?.className).toContain("h-[100dvh]");
      });
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: originalWidth,
      });
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("routes incoming text to payload session when active session differs (no cross-session mix)", async () => {
    useSessionStore.setState({
      sessions: {
        "cc-connect": [
          { key: "session-a", connectionId: "cc-connect", createdAt: 1, lastActiveAt: 1 },
          { key: "session-b", connectionId: "cc-connect", createdAt: 2, lastActiveAt: 2 },
        ],
      },
      activeSessionKey: { "cc-connect": "session-a" },
    });

    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);
    adapter.emit(WS_EVENTS.BRIDGE_CONNECTED, {
      connectionId: "cc-connect",
      connected: true,
    });

    adapter.emit(WS_EVENTS.BRIDGE_MESSAGE, {
      connectionId: "cc-connect",
      sessionKey: "session-b",
      content: "delivered to B only",
    });

    await waitFor(() => {
      const st = useMessageStore.getState();
      const keyB = makeChatKey("cc-connect", "session-b");
      const keyA = makeChatKey("cc-connect", "session-a");
      expect((st.messagesByChat[keyB] ?? []).some((m) => m.content === "delivered to B only")).toBe(true);
      expect((st.messagesByChat[keyA] ?? []).some((m) => m.content === "delivered to B only")).toBe(false);
    });
  });

  it("updates session task state to awaiting_confirmation on bridge buttons", async () => {
    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    adapter.emit(WS_EVENTS.BRIDGE_BUTTONS, {
      connectionId: "cc-connect",
      sessionKey: "default",
      content: "请选择",
      buttons: [[{ id: "b1", label: "确认" }]],
    });

    await waitFor(() => {
      const phase = useSessionStore.getState().taskStateByConnection["cc-connect"]?.default?.phase;
      expect(phase).toBe("awaiting_confirmation");
    });
  });

  it("keeps working between typing_start and typing_stop", async () => {
    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    adapter.emit(WS_EVENTS.BRIDGE_TYPING_START, {
      connectionId: "cc-connect",
      sessionKey: "default",
    });
    adapter.emit(WS_EVENTS.BRIDGE_MESSAGE, {
      connectionId: "cc-connect",
      sessionKey: "default",
      content: "still typing",
    });

    await waitFor(() => {
      const phase = useSessionStore.getState().taskStateByConnection["cc-connect"]?.default?.phase;
      expect(phase).toBe("working");
      expect(useUIStore.getState().petState).toBe("thinking");
    });

    adapter.emit(WS_EVENTS.BRIDGE_STREAM_DONE, {
      connectionId: "cc-connect",
      sessionKey: "default",
      fullText: "stream done before stop",
    });
    await waitFor(() => {
      const phase = useSessionStore.getState().taskStateByConnection["cc-connect"]?.default?.phase;
      expect(phase).toBe("working");
      expect(useUIStore.getState().petState).toBe("thinking");
    });

    adapter.emit(WS_EVENTS.BRIDGE_TYPING_STOP, {
      connectionId: "cc-connect",
      sessionKey: "default",
    });
    await waitFor(() => {
      const phase = useSessionStore.getState().taskStateByConnection["cc-connect"]?.default?.phase;
      expect(phase).toBe("completed");
    });
  });

  it("ignores stray typing_stop before typing_start", async () => {
    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    adapter.emit(WS_EVENTS.BRIDGE_TYPING_STOP, {
      connectionId: "cc-connect",
      sessionKey: "default",
    });
    adapter.emit(WS_EVENTS.BRIDGE_MESSAGE, {
      connectionId: "cc-connect",
      sessionKey: "default",
      content: "normal message",
    });

    await waitFor(() => {
      const phase = useSessionStore.getState().taskStateByConnection["cc-connect"]?.default?.phase;
      expect(phase).toBe("completed");
    });
  });

  it("routes fallback typing_stop to in-flight session after user switches active session", async () => {
    useSessionStore.setState({
      sessions: {
        "cc-connect": [
          { key: "session-a", connectionId: "cc-connect", createdAt: 1, lastActiveAt: 1 },
          { key: "session-b", connectionId: "cc-connect", createdAt: 2, lastActiveAt: 2 },
        ],
      },
      activeSessionKey: { "cc-connect": "session-a" },
    });

    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    adapter.emit(WS_EVENTS.BRIDGE_TYPING_START, {
      connectionId: "cc-connect",
      sessionKey: "session-a",
    });
    await waitFor(() => {
      const phase = useSessionStore.getState().taskStateByConnection["cc-connect"]?.["session-a"]?.phase;
      expect(phase).toBe("working");
    });

    // User switches to another tab while original session is still in-flight.
    useSessionStore.getState().setActiveSession("cc-connect", "session-b");

    // Upstream stop event arrives without explicit session key (falls back to active before fix).
    adapter.emit(WS_EVENTS.BRIDGE_TYPING_STOP, {
      connectionId: "cc-connect",
    });

    await waitFor(() => {
      const state = useSessionStore.getState().taskStateByConnection["cc-connect"] ?? {};
      expect(state["session-a"]?.phase).toBe("completed");
      expect(state["session-b"]?.phase).not.toBe("completed");
    });
  });

  it("increments unread and shows pet talking when assistant message targets a non-active session", async () => {
    useSessionStore.setState({
      sessions: {
        "cc-connect": [
          { key: "session-a", connectionId: "cc-connect", createdAt: 1, lastActiveAt: 1 },
          { key: "session-b", connectionId: "cc-connect", createdAt: 2, lastActiveAt: 2 },
        ],
      },
      activeSessionKey: { "cc-connect": "session-a" },
    });
    useUIStore.setState({ chatOpen: true });

    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    adapter.emit(WS_EVENTS.BRIDGE_MESSAGE, {
      connectionId: "cc-connect",
      sessionKey: "session-b",
      content: "background reply",
    });

    await waitFor(() => {
      const keyB = makeChatKey("cc-connect", "session-b");
      expect(useSessionStore.getState().unread[keyB]).toBe(1);
      expect(useUIStore.getState().petState).toBe("talking");
    });
  });

  it("does not increment unread for active session when chatOpen is false on web", async () => {
    useSessionStore.setState({
      sessions: {
        "cc-connect": [{ key: "session-a", connectionId: "cc-connect", createdAt: 1, lastActiveAt: 1 }],
      },
      activeSessionKey: { "cc-connect": "session-a" },
    });
    useUIStore.setState({ chatOpen: false });

    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    adapter.emit(WS_EVENTS.BRIDGE_MESSAGE, {
      connectionId: "cc-connect",
      sessionKey: "session-a",
      content: "reply while pet toggled",
    });

    await waitFor(() => {
      const keyA = makeChatKey("cc-connect", "session-a");
      expect(useSessionStore.getState().unread[keyA] ?? 0).toBe(0);
    });
  });

  it("routes incoming text by replyCtx when payload sessionKey is missing", async () => {
    useSessionStore.setState({
      sessions: {
        "cc-connect": [
          { key: "session-a", connectionId: "cc-connect", createdAt: 1, lastActiveAt: 1 },
          { key: "session-b", connectionId: "cc-connect", createdAt: 2, lastActiveAt: 2 },
        ],
      },
      activeSessionKey: { "cc-connect": "session-a" },
    });

    const routed = applyIncomingWsSessionRouting(WS_EVENTS.BRIDGE_MESSAGE, {
      connectionId: "cc-connect",
      replyCtx: "ccpet:session-b:42",
      content: "from reply context",
    }) as { sessionKey?: string };

    expect(routed.sessionKey).toBe("session-b");
  });

  it("falls back to active session when replyCtx is not in known sessions", async () => {
    useSessionStore.setState({
      sessions: {
        "cc-connect": [
          { key: "session-a", connectionId: "cc-connect", createdAt: 1, lastActiveAt: 1 },
          { key: "session-b", connectionId: "cc-connect", createdAt: 2, lastActiveAt: 2 },
        ],
      },
      activeSessionKey: { "cc-connect": "session-a" },
    });

    const routed = applyIncomingWsSessionRouting(WS_EVENTS.BRIDGE_MESSAGE, {
      connectionId: "cc-connect",
      replyCtx: "ccpet:session-x:42",
      content: "fallback to active",
    }) as { sessionKey?: string };

    expect(routed.sessionKey).toBe("session-a");
  });

  it("supports reply_ctx fallback key format from server payloads", async () => {
    useSessionStore.setState({
      sessions: {
        "cc-connect": [
          { key: "session-a", connectionId: "cc-connect", createdAt: 1, lastActiveAt: 1 },
          { key: "session-b", connectionId: "cc-connect", createdAt: 2, lastActiveAt: 2 },
        ],
      },
      activeSessionKey: { "cc-connect": "session-a" },
    });

    const routed = applyIncomingWsSessionRouting(WS_EVENTS.BRIDGE_MESSAGE, {
      connectionId: "cc-connect",
      reply_ctx: "ccpet:session-b:77",
      content: "snake case reply ctx",
    }) as { sessionKey?: string };

    expect(routed.sessionKey).toBe("session-b");
  });

  it("hydrates sessions and chat history from REST after websocket manifest", async () => {
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/sessions?connectionId=")) {
        return {
          sessions: [
            {
              key: "sess-restored",
              connectionId: "cc-connect",
              label: "Saved tab",
              createdAt: 100,
              lastActiveAt: 300,
            },
          ],
        };
      }
      if (path.startsWith("/api/history/")) {
        const chatKey = decodeURIComponent(path.slice("/api/history/".length));
        if (chatKey === makeChatKey("cc-connect", "sess-restored")) {
          return {
            messages: [
              {
                id: "hm1",
                role: "user",
                content: "from server history",
                timestamp: 200,
                connectionId: "cc-connect",
                sessionKey: "sess-restored",
              },
            ],
          };
        }
        return { messages: [] };
      }
      return {};
    });

    render(<App />);

    expect(await screen.findByText("from server history")).toBeInTheDocument();
    expect(useSessionStore.getState().activeSessionKey["cc-connect"]).toBe("sess-restored");
  });

  it("defaults active connection to the one with newest message after hydrate", async () => {
    adapter.connectWs.mockImplementation(() => {
      defaultConnectSnapshot([
        { id: "cc-connect", name: "cc-connect" },
        { id: "cs-connect", name: "cs-connect" },
      ]);
    });
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.includes("connectionId=cc-connect")) {
        return {
          sessions: [{ key: "s1", connectionId: "cc-connect", createdAt: 100, lastActiveAt: 100 }],
        };
      }
      if (path.includes("connectionId=cs-connect")) {
        return {
          sessions: [{ key: "s2", connectionId: "cs-connect", createdAt: 100, lastActiveAt: 100 }],
        };
      }
      if (path.startsWith("/api/history/")) {
        const chatKey = decodeURIComponent(path.slice("/api/history/".length));
        if (chatKey === makeChatKey("cc-connect", "s1")) {
          return {
            messages: [
              {
                id: "cc-old",
                role: "assistant",
                content: "older",
                timestamp: 1000,
                connectionId: "cc-connect",
                sessionKey: "s1",
              },
            ],
          };
        }
        if (chatKey === makeChatKey("cs-connect", "s2")) {
          return {
            messages: [
              {
                id: "cs-new",
                role: "assistant",
                content: "newer",
                timestamp: 2000,
                connectionId: "cs-connect",
                sessionKey: "s2",
              },
            ],
          };
        }
        return { messages: [] };
      }
      return {};
    });

    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    await waitFor(() => {
      expect(useConnectionStore.getState().activeConnectionId).toBe("cs-connect");
    });
  });

  it("defaults active session to newest message in connection, not API lastActiveAt order", async () => {
    adapter.connectWs.mockImplementation(() => {
      defaultConnectSnapshot([{ id: "cc-connect", name: "cc-connect" }]);
    });
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.includes("connectionId=cc-connect")) {
        return {
          sessions: [
            { key: "s-old", connectionId: "cc-connect", createdAt: 1, lastActiveAt: 900 },
            { key: "s-new", connectionId: "cc-connect", createdAt: 2, lastActiveAt: 100 },
          ],
        };
      }
      if (path.startsWith("/api/history/")) {
        const chatKey = decodeURIComponent(path.slice("/api/history/".length));
        if (chatKey === makeChatKey("cc-connect", "s-old")) {
          return {
            messages: [
              {
                id: "a",
                role: "user",
                content: "older",
                timestamp: 1000,
                connectionId: "cc-connect",
                sessionKey: "s-old",
              },
            ],
          };
        }
        if (chatKey === makeChatKey("cc-connect", "s-new")) {
          return {
            messages: [
              {
                id: "b",
                role: "user",
                content: "newer",
                timestamp: 5000,
                connectionId: "cc-connect",
                sessionKey: "s-new",
              },
            ],
          };
        }
        return { messages: [] };
      }
      return {};
    });

    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    await waitFor(() => {
      expect(useSessionStore.getState().activeSessionKey["cc-connect"]).toBe("s-new");
      expect(useConnectionStore.getState().activeConnectionId).toBe("cc-connect");
    });
  });

  it("sends message to websocket and renders incoming bridge reply", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);
    adapter.emit(WS_EVENTS.BRIDGE_CONNECTED, {
      connectionId: "cc-connect",
      connected: true,
    });
    const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
    await user.type(input, "hello from ui");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(adapter.sendWsMessage).toHaveBeenCalledWith({
        type: WS_EVENTS.SEND_MESSAGE,
        connectionId: "cc-connect",
        sessionKey: "default",
        content: "hello from ui",
      });
    });
    expect(screen.getByText("hello from ui")).toBeInTheDocument();

    adapter.emit(WS_EVENTS.BRIDGE_MESSAGE, {
      connectionId: "cc-connect",
      sessionKey: "default",
      content: "pong from bridge",
    });

    expect(await screen.findByText("pong from bridge")).toBeInTheDocument();
  });

  it("shows stop button while session is working and sends /stop", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    adapter.emit(WS_EVENTS.BRIDGE_TYPING_START, {
      connectionId: "cc-connect",
      sessionKey: "default",
    });

    const stopButton = await screen.findByRole("button", { name: "停止" });
    expect(stopButton).toBeInTheDocument();

    await user.click(stopButton);
    expect(adapter.sendWsMessage).toHaveBeenCalledWith({
      type: WS_EVENTS.SEND_MESSAGE,
      connectionId: "cc-connect",
      sessionKey: "default",
      content: "/stop",
    });
  });

  it("still sends message even when bridge is currently disconnected", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
    await user.type(input, "will fail");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(adapter.sendWsMessage).toHaveBeenCalledWith({
      type: WS_EVENTS.SEND_MESSAGE,
      connectionId: "cc-connect",
      sessionKey: "default",
      content: "will fail",
    });
    expect(screen.queryByText("当前连接已断开，消息未发送。请等待重连后重试。")).not.toBeInTheDocument();
  });

  it("does not send when Enter is used to confirm IME composition", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    adapter.emit(WS_EVENTS.BRIDGE_CONNECTED, {
      connectionId: "cc-connect",
      connected: true,
    });

    const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
    await user.type(input, "hello world");

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
    });

    expect(adapter.sendWsMessage).not.toHaveBeenCalled();
    expect(input).toHaveValue("hello world");
  });

  it("shows slash palette with bridge skill commands after skills_updated", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);
    adapter.emit(WS_EVENTS.BRIDGE_CONNECTED, {
      connectionId: "cc-connect",
      connected: true,
    });
    adapter.emit(WS_EVENTS.BRIDGE_SKILLS_UPDATED, {
      connectionId: "cc-connect",
      commands: [{ command: "/custom-skill", description: "From bridge", category: "skill", type: "send" }],
    });

    const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
    await user.type(input, "/");
    expect(await screen.findByTestId("slash-command-menu")).toBeInTheDocument();
    expect(screen.getByText("/custom-skill")).toBeInTheDocument();
    expect(screen.getByText("From bridge")).toBeInTheDocument();
  });

  it("applies local /clear without sending websocket message", async () => {
    const user = userEvent.setup();
    adapter.fetchApi.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.startsWith("/api/history/") && options?.method === "DELETE") {
        return { ok: true };
      }
      return {};
    });

    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);
    adapter.emit(WS_EVENTS.BRIDGE_CONNECTED, {
      connectionId: "cc-connect",
      connected: true,
    });

    const input = screen.getByPlaceholderText(INPUT_PLACEHOLDER);
    await user.type(input, "/clear");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(adapter.fetchApi).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/history\//),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(adapter.sendWsMessage).not.toHaveBeenCalled();
  });

  it("sends selected file via websocket and renders file bubble", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    const file = new File(["hello-file"], "demo.txt", { type: "text/plain" });
    await user.upload(fileInput!, file);

    expect(await screen.findByText(/demo\.txt/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(adapter.sendWsMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: WS_EVENTS.SEND_FILE,
          connectionId: "cc-connect",
          sessionKey: "default",
          files: expect.arrayContaining([
            expect.objectContaining({
              file_name: "demo.txt",
            }),
          ]),
        }),
      );
    });

    expect(screen.getAllByText(/demo\.txt/).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps caption visible when sending attachment with text", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    const file = new File(["hello-file"], "with-caption.txt", { type: "text/plain" });
    await user.upload(fileInput!, file);

    const input = screen.getByPlaceholderText("输入说明（可选），Enter 发送，Shift+Enter 换行");
    await user.type(input, "这是说明文字");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(adapter.sendWsMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: WS_EVENTS.SEND_FILE,
          content: "这是说明文字",
          files: expect.arrayContaining([
            expect.objectContaining({
              file_name: "with-caption.txt",
            }),
          ]),
        }),
      );
    });
    expect(await screen.findByText("这是说明文字")).toBeInTheDocument();
    expect(screen.getByText(/with-caption\.txt/)).toBeInTheDocument();
  });

  it("sends multiple selected files in a single websocket payload", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    const fileA = new File(["a"], "a.txt", { type: "text/plain" });
    const fileB = new File(["b"], "b.txt", { type: "text/plain" });
    await user.upload(fileInput!, [fileA, fileB]);

    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(adapter.sendWsMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: WS_EVENTS.SEND_FILE,
          files: expect.arrayContaining([
            expect.objectContaining({ file_name: "a.txt" }),
            expect.objectContaining({ file_name: "b.txt" }),
          ]),
        }),
      );
    });
  });
});
