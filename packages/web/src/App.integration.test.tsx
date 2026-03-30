import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WS_EVENTS, makeChatKey } from "@cc-pet/shared";
import type { PlatformAPI } from "./lib/platform.js";
import App from "./App.js";
import { applyIncomingWsSessionRouting, createWebAdapter } from "./lib/web-adapter.js";
import { useConnectionStore } from "./lib/store/connection.js";
import { useMessageStore } from "./lib/store/message.js";
import { useSessionStore } from "./lib/store/session.js";
import { useUIStore } from "./lib/store/ui.js";
import { useConfigStore } from "./lib/store/config.js";
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

vi.mock("./lib/web-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/web-adapter.js")>();
  return {
    ...actual,
    createWebAdapter: vi.fn(() => adapter),
  };
});

function resetStores() {
  useConnectionStore.setState({ connections: [], activeConnectionId: null });
  useMessageStore.setState({ messagesByChat: {}, streamingContent: {} });
  useSessionStore.setState({ sessions: {}, activeSessionKey: {}, unread: {} });
  useUIStore.setState({ chatOpen: false, settingsOpen: false, petState: "idle", isMobile: false });
  useConfigStore.setState({ config: null });
  useCommandStore.setState({ agentCommandsByConnection: {} });
}

const INPUT_PLACEHOLDER = "输入消息，Enter 发送，Shift+Enter 换行";

describe("App integration", () => {
  beforeEach(() => {
    cleanup();
    resetStores();
    localStorage.clear();
    adapter.connectWs.mockClear();
    adapter.disconnectWs.mockClear();
    adapter.sendWsMessage.mockClear();
    adapter.fetchApi.mockClear();
    adapter.fetchApi.mockImplementation(async (path: string, _options?: RequestInit) => {
      if (path === "/api/config") {
        return {
          bridges: [{ id: "cc-connect", name: "cc-connect", host: "127.0.0.1", port: 9810, token: "t", enabled: true }],
          pet: { opacity: 1, size: 120 },
          server: { port: 3000, dataDir: "./data" },
        };
      }
      return {};
    });
    if (!window.HTMLElement.prototype.scrollIntoView) {
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
    }
  });

  it("ignores legacy localStorage server token/url and uses same-origin adapter", async () => {
    localStorage.setItem("cc-pet-server-url", "http://127.0.0.1:3999");
    localStorage.setItem("cc-pet-token", "legacy-token");
    render(<App />);

    await screen.findByText("cc-connect");
    expect(createWebAdapter).toHaveBeenCalledWith("");
  });

  it("shows connection status and updates to connected after bridge event", async () => {
    render(<App />);

    await screen.findByText("cc-connect");
    const name = screen.getByText("cc-connect");
    const statusDot = name.previousElementSibling as HTMLElement;
    expect(statusDot.className).toContain("bg-red-500");

    adapter.emit(WS_EVENTS.BRIDGE_CONNECTED, {
      connectionId: "cc-connect",
      connected: true,
    });

    await waitFor(() => {
      expect(statusDot.className).toContain("bg-green-500");
    });
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
    await screen.findByText("cc-connect");
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
      if (path === "/api/config") {
        return {
          bridges: [{ id: "cc-connect", name: "cc-connect", host: "127.0.0.1", port: 9810, token: "t", enabled: true }],
          pet: { opacity: 1, size: 120 },
          server: { port: 3000, dataDir: "./data" },
        };
      }
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
