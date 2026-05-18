import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { useWorkspaceStore } from "./lib/store/workspace.js";

class FakeAdapter implements PlatformAPI {
  private handler: ((type: string, payload: any) => void) | null = null;

  connectWs = vi.fn();
  disconnectWs = vi.fn();
  sendWsMessage = vi.fn();

  fetchApi = vi.fn();
  fetchApiRaw = vi.fn();

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
  useMessageStore.setState({ messagesByChat: {}, streamingContent: {}, loadedChatKeys: new Set() });
  useSessionStore.setState({
    sessions: {},
    activeSessionKey: {},
    unread: {},
    taskStateByConnection: {},
    lazyLoadChat: null,
  });
  useUIStore.setState({
    chatOpen: true,
    petState: "idle",
    isMobile: false,
    settingsOpen: false,
  });
  useCommandStore.setState({ agentCommandsByConnection: {} });
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
}

const INPUT_PLACEHOLDER = "输入消息，Enter 发送，Shift+Enter 换行";

async function openWorkspaceTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("tab", { name: "工作区" }));
}

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
    await screen.findByRole("tab", { name: "连接" });
    expect(await screen.findByRole("button", { name: /cs-connect/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /cs-connect/i }));
    await waitFor(() => {
      expect(useConnectionStore.getState().activeConnectionId).toBe("cs-connect");
    });
  });

  it("loads the active connection workspace and opens a file preview", async () => {
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/sessions?connectionId=")) return { sessions: [] };
      if (path.startsWith("/api/history/")) return { messages: [] };
      if (path === "/api/workspaces/cc-connect") {
        return { connectionId: "cc-connect", configured: true, rootName: "cc-pet-web" };
      }
      if (path === "/api/workspaces/cc-connect/tree") {
        return {
          path: "",
          entries: [{ name: "README.md", path: "README.md", kind: "file", extension: ".md", inaccessible: false }],
        };
      }
      if (path === "/api/workspaces/cc-connect/git/status") {
        return { gitAvailable: true, changes: [] };
      }
      if (path === "/api/workspaces/cc-connect/file?path=README.md") {
        return {
          path: "README.md",
          name: "README.md",
          previewable: true,
          encoding: "utf8",
          content: "# cc-pet-web\n",
          size: 13,
        };
      }
      return {};
    });

    const user = userEvent.setup();
    render(<App />);
    await openWorkspaceTab(user);
    expect(await screen.findByText("cc-pet-web")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /README\.md/ }));

    await waitFor(() => {
      expect(screen.getAllByText("README.md").length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByRole("textbox", { name: "文件内容" })).toHaveValue("# cc-pet-web\n");
    expect(useWorkspaceStore.getState().activeConnectionId).toBe("cc-connect");
  });

  it("loads git changes, marks the file tree, opens diffs, and refreshes status", async () => {
    const user = userEvent.setup();
    let changes = [{ path: "README.md", status: "M" }];
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/sessions?connectionId=")) return { sessions: [] };
      if (path.startsWith("/api/history/")) return { messages: [] };
      if (path === "/api/workspaces/cc-connect") {
        return { connectionId: "cc-connect", configured: true, rootName: "cc-pet-web" };
      }
      if (path === "/api/workspaces/cc-connect/tree") {
        return {
          path: "",
          entries: [{ name: "README.md", path: "README.md", kind: "file", extension: ".md", inaccessible: false }],
        };
      }
      if (path === "/api/workspaces/cc-connect/git/status") {
        return { gitAvailable: true, changes };
      }
      if (path === "/api/workspaces/cc-connect/git/diff?path=README.md") {
        return {
          path: "README.md",
          previewable: true,
          diff: "diff --git a/README.md b/README.md\n-# old\n+# new\n",
        };
      }
      return {};
    });

    render(<App />);
    await openWorkspaceTab(user);

    expect(await screen.findByText("Git 修改")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Git 变更" }));
    await user.click(await screen.findByRole("button", { name: /README\.md/ }));
    expect(await screen.findByText("Diff 查看")).toBeInTheDocument();
    expect(screen.getByText("+# new")).toBeInTheDocument();
    expect(useWorkspaceStore.getState().activeDiff?.path).toBe("README.md");

    changes = [];
    await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("暂无 Git 变更。")).toBeInTheDocument();
    expect(useWorkspaceStore.getState().gitStatusByConnection["cc-connect"][""].changes).toEqual([]);
  });

  it("switches git scope and reloads status when picking a nested repo from the selector", async () => {
    const user = userEvent.setup();
    const requestUrls: string[] = [];
    adapter.fetchApi.mockImplementation(async (path: string) => {
      requestUrls.push(path);
      if (path.startsWith("/api/sessions?connectionId=")) return { sessions: [] };
      if (path.startsWith("/api/history/")) return { messages: [] };
      if (path === "/api/workspaces/cc-connect") {
        return { connectionId: "cc-connect", configured: true, rootName: "cc-pet-web" };
      }
      if (path === "/api/workspaces/cc-connect/tree") {
        return {
          path: "",
          entries: [
            { name: "README.md", path: "README.md", kind: "file", extension: ".md", inaccessible: false },
            { name: "sub", path: "sub", kind: "directory", inaccessible: false },
          ],
        };
      }
      if (path === "/api/workspaces/cc-connect/git/scopes") {
        return {
          scopes: [
            { path: "", repoMode: "root", label: "（工作区根）" },
            { path: "sub/embedded", repoMode: "nested", label: "sub/embedded" },
          ],
        };
      }
      if (path === "/api/workspaces/cc-connect/git/status") {
        return {
          gitAvailable: true,
          changes: [{ path: "README.md", status: "M" }],
          scope: "",
          repoMode: "root",
          repoRoot: "",
        };
      }
      if (path === "/api/workspaces/cc-connect/git/status?scope=sub%2Fembedded") {
        return {
          gitAvailable: true,
          changes: [{ path: "sub/embedded/inner.txt", status: "??" }],
          scope: "sub/embedded",
          repoMode: "nested",
          repoRoot: "sub/embedded",
        };
      }
      return {};
    });

    render(<App />);
    await openWorkspaceTab(user);
    await user.click(await screen.findByRole("button", { name: "Git 变更" }));
    expect(await screen.findByRole("button", { name: /README\.md/ })).toBeInTheDocument();

    const selector = screen.getByRole("combobox", { name: "Git 范围" });
    await user.selectOptions(selector, "sub/embedded");

    expect(await screen.findByRole("button", { name: /sub\/embedded\/inner\.txt/ })).toBeInTheDocument();
    expect(useWorkspaceStore.getState().activeGitScopeByConnection["cc-connect"]).toBe("sub/embedded");
    expect(
      useWorkspaceStore.getState().gitStatusByConnection["cc-connect"]["sub/embedded"].changes,
    ).toEqual([{ path: "sub/embedded/inner.txt", status: "??" }]);
    expect(requestUrls).toContain("/api/workspaces/cc-connect/git/status");
    expect(requestUrls).toContain("/api/workspaces/cc-connect/git/status?scope=sub%2Fembedded");
  });

  it("shows non-previewable and unavailable git diff states without blocking files", async () => {
    const user = userEvent.setup();
    let unavailable = false;
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/sessions?connectionId=")) return { sessions: [] };
      if (path.startsWith("/api/history/")) return { messages: [] };
      if (path === "/api/workspaces/cc-connect") {
        return { connectionId: "cc-connect", configured: true, rootName: "cc-pet-web" };
      }
      if (path === "/api/workspaces/cc-connect/tree") {
        return {
          path: "",
          entries: [{ name: "binary.dat", path: "binary.dat", kind: "file", inaccessible: false }],
        };
      }
      if (path === "/api/workspaces/cc-connect/git/status") {
        return unavailable
          ? { gitAvailable: false, changes: [], message: "Git 状态不可用，文件浏览仍可继续使用。" }
          : { gitAvailable: true, changes: [{ path: "binary.dat", status: "M" }] };
      }
      if (path === "/api/workspaces/cc-connect/git/diff?path=binary.dat") {
        return { path: "binary.dat", previewable: false, reason: "BINARY_DIFF" };
      }
      return {};
    });

    render(<App />);
    await openWorkspaceTab(user);
    await user.click(await screen.findByRole("button", { name: "Git 变更" }));
    await user.click(await screen.findByRole("button", { name: /binary\.dat/ }));
    expect(await screen.findByText("二进制 diff 无法直接预览。")).toBeInTheDocument();

    unavailable = true;
    await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("Git 状态不可用，文件浏览仍可继续使用。")).toBeInTheDocument();
    expect(screen.getByText("binary.dat")).toBeInTheDocument();
  });

  it("creates, renames, deletes, and saves workspace files from the UI", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt");
    const confirmSpy = vi.spyOn(window, "confirm");
    const entries = [
      { name: "README.md", path: "README.md", kind: "file", extension: ".md", inaccessible: false },
    ];
    let readmeContent = "# cc-pet-web\n";
    try {
      promptSpy.mockReturnValueOnce("notes.txt").mockReturnValueOnce("README-renamed.md");
      confirmSpy.mockReturnValue(true);
      adapter.fetchApi.mockImplementation(async (path: string, options?: RequestInit) => {
        if (path.startsWith("/api/sessions?connectionId=")) return { sessions: [] };
        if (path.startsWith("/api/history/")) return { messages: [] };
        if (path === "/api/workspaces/cc-connect") {
          return { connectionId: "cc-connect", configured: true, rootName: "cc-pet-web" };
        }
        if (path === "/api/workspaces/cc-connect/tree") {
          return { path: "", entries };
        }
        if (path === "/api/workspaces/cc-connect/file?path=README.md") {
          return {
            path: "README.md",
            name: "README.md",
            previewable: true,
            encoding: "utf8",
            content: readmeContent,
            size: readmeContent.length,
            etag: "readme-v1",
          };
        }
        if (path === "/api/workspaces/cc-connect/file" && options?.method === "PUT") {
          const body = JSON.parse(String(options.body));
          expect(body.etag).toBe("readme-v1");
          readmeContent = body.content;
          return { ok: true, entry: { name: "README.md", path: "README.md", kind: "file", extension: ".md" } };
        }
        if (path === "/api/workspaces/cc-connect/items" && options?.method === "POST") {
          entries.push({ name: "notes.txt", path: "notes.txt", kind: "file", extension: ".txt", inaccessible: false });
          return { ok: true, entry: { name: "notes.txt", path: "notes.txt", kind: "file", extension: ".txt" } };
        }
        if (path === "/api/workspaces/cc-connect/items" && options?.method === "PATCH") {
          entries[0] = {
            name: "README-renamed.md",
            path: "README-renamed.md",
            kind: "file",
            extension: ".md",
            inaccessible: false,
          };
          return { ok: true, entry: entries[0] };
        }
        if (path === "/api/workspaces/cc-connect/items" && options?.method === "DELETE") {
          const body = JSON.parse(String(options.body));
          const index = entries.findIndex((entry) => entry.path === body.path);
          if (index >= 0) entries.splice(index, 1);
          return { ok: true };
        }
        return {};
      });

      render(<App />);
      await openWorkspaceTab(user);
      expect(await screen.findByText("cc-pet-web")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /README\.md/ }));
      const editor = await screen.findByRole("textbox", { name: "文件内容" });
      await user.clear(editor);
      await user.type(editor, "# Updated");
      await user.click(screen.getByRole("button", { name: "保存" }));
      expect(await screen.findByText("已保存 README.md")).toBeInTheDocument();
      expect(readmeContent).toBe("# Updated");

      await user.click(screen.getByRole("button", { name: "新建文件" }));
      expect(await screen.findByRole("button", { name: /notes\.txt/ })).toBeInTheDocument();

      const readmeRow = screen.getByRole("button", { name: /README\.md/ }).closest("[data-file-entry]") as HTMLElement;
      await user.click(within(readmeRow).getByRole("button", { name: "重命名" }));
      expect(await screen.findByRole("button", { name: /README-renamed\.md/ })).toBeInTheDocument();

      const notesRow = screen.getByRole("button", { name: /notes\.txt/ }).closest("[data-file-entry]") as HTMLElement;
      await user.click(within(notesRow).getByRole("button", { name: "删除" }));
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /notes\.txt/ })).not.toBeInTheDocument();
      });
    } finally {
      promptSpy.mockRestore();
      confirmSpy.mockRestore();
    }
  });

  it("shows stale workspace operation errors so users can refresh before continuing", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    try {
      confirmSpy.mockReturnValue(true);
      adapter.fetchApi.mockImplementation(async (path: string, options?: RequestInit) => {
        if (path.startsWith("/api/sessions?connectionId=")) return { sessions: [] };
        if (path.startsWith("/api/history/")) return { messages: [] };
        if (path === "/api/workspaces/cc-connect") {
          return { connectionId: "cc-connect", configured: true, rootName: "cc-pet-web" };
        }
        if (path === "/api/workspaces/cc-connect/tree") {
          return {
            path: "",
            entries: [{ name: "stale.txt", path: "stale.txt", kind: "file", extension: ".txt", inaccessible: false }],
          };
        }
        if (path === "/api/workspaces/cc-connect/items" && options?.method === "DELETE") {
          return { error: "WORKSPACE_LIST_STALE", message: "列表已过期，可刷新后继续。" };
        }
        return {};
      });

      render(<App />);
      await openWorkspaceTab(user);
      const staleRow = (await screen.findByRole("button", { name: /stale\.txt/ })).closest("[data-file-entry]") as HTMLElement;
      await user.click(within(staleRow).getByRole("button", { name: "删除" }));

      expect(await screen.findByText("列表已过期，可刷新后继续。")).toBeInTheDocument();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("sends the opened file version when saving and shows stale save errors", async () => {
    const user = userEvent.setup();
    adapter.fetchApi.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.startsWith("/api/sessions?connectionId=")) return { sessions: [] };
      if (path.startsWith("/api/history/")) return { messages: [] };
      if (path === "/api/workspaces/cc-connect") {
        return { connectionId: "cc-connect", configured: true, rootName: "cc-pet-web" };
      }
      if (path === "/api/workspaces/cc-connect/tree") {
        return {
          path: "",
          entries: [{ name: "README.md", path: "README.md", kind: "file", extension: ".md", inaccessible: false }],
        };
      }
      if (path === "/api/workspaces/cc-connect/git/status") {
        return { gitAvailable: true, changes: [] };
      }
      if (path === "/api/workspaces/cc-connect/file?path=README.md") {
        return {
          path: "README.md",
          name: "README.md",
          previewable: true,
          encoding: "utf8",
          content: "# cc-pet-web\n",
          size: 13,
          etag: "readme-v1",
        };
      }
      if (path === "/api/workspaces/cc-connect/file" && options?.method === "PUT") {
        expect(JSON.parse(String(options.body))).toMatchObject({
          path: "README.md",
          content: "# Updated",
          etag: "readme-v1",
        });
        return { error: "WORKSPACE_LIST_STALE", message: "文件已在外部修改，列表已过期，可刷新后继续。" };
      }
      return {};
    });

    render(<App />);
    await openWorkspaceTab(user);
    await user.click(await screen.findByRole("button", { name: /README\.md/ }));
    const editor = await screen.findByRole("textbox", { name: "文件内容" });
    await user.clear(editor);
    await user.type(editor, "# Updated");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("文件已在外部修改，列表已过期，可刷新后继续。")).toBeInTheDocument();
  });

  it("refreshes workspace context when the active connection changes", async () => {
    const user = userEvent.setup();
    adapter.connectWs.mockImplementation(() => {
      defaultConnectSnapshot([
        { id: "cc-connect", name: "cc-connect" },
        { id: "cs-connect", name: "cs-connect" },
      ]);
    });
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/sessions?connectionId=")) return { sessions: [] };
      if (path.startsWith("/api/history/")) return { messages: [] };
      if (path === "/api/workspaces/cc-connect") {
        return { connectionId: "cc-connect", configured: true, rootName: "workspace-a" };
      }
      if (path === "/api/workspaces/cc-connect/tree") {
        return { path: "", entries: [{ name: "a.txt", path: "a.txt", kind: "file", extension: ".txt" }] };
      }
      if (path === "/api/workspaces/cs-connect") {
        return { connectionId: "cs-connect", configured: true, rootName: "workspace-b" };
      }
      if (path === "/api/workspaces/cs-connect/tree") {
        return { path: "", entries: [{ name: "b.txt", path: "b.txt", kind: "file", extension: ".txt" }] };
      }
      return {};
    });

    render(<App />);
    await openWorkspaceTab(user);
    expect(await screen.findByText("workspace-a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /a\.txt/ })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "连接" }));
    await user.click(screen.getByRole("button", { name: /cs-connect/i }));
    await openWorkspaceTab(user);

    expect(await screen.findByText("workspace-b")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /b\.txt/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /a\.txt/ })).not.toBeInTheDocument();
  });

  it("hides the workspace panel when the active connection has no configured workspace", async () => {
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/sessions?connectionId=")) return { sessions: [] };
      if (path.startsWith("/api/history/")) return { messages: [] };
      if (path === "/api/workspaces/cc-connect") {
        return { error: "WORKSPACE_NOT_CONFIGURED", message: "Connection does not have a configured workspace" };
      }
      return {};
    });

    render(<App />);
    await openWorkspaceTab(userEvent.setup());

    await waitFor(() => {
      expect(adapter.fetchApi).toHaveBeenCalledWith("/api/workspaces/cc-connect");
    });
    expect(screen.queryByTestId("workspace-panel")).not.toBeInTheDocument();
    expect(screen.queryByText("Connection does not have a configured workspace")).not.toBeInTheDocument();
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
        expect(mobileRoot?.className).toContain("h-full");
        expect(mobileRoot?.className).toContain("overflow-hidden");
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

  it("opens the workspace panel from the mobile header", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 390,
    });
    window.dispatchEvent(new Event("resize"));
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/sessions?connectionId=")) return { sessions: [] };
      if (path.startsWith("/api/history/")) return { messages: [] };
      if (path === "/api/workspaces/cc-connect") {
        return { connectionId: "cc-connect", configured: true, rootName: "cc-pet-web" };
      }
      if (path === "/api/workspaces/cc-connect/tree") {
        return {
          path: "",
          entries: [{ name: "README.md", path: "README.md", kind: "file", extension: ".md", inaccessible: false }],
        };
      }
      if (path === "/api/workspaces/cc-connect/git/status") {
        return { gitAvailable: true, changes: [{ path: "README.md", status: "M" }] };
      }
      return {};
    });
    try {
      render(<App />);
      await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

      await userEvent.click(screen.getByRole("button", { name: "工作区" }));
      const dialog = screen.getByRole("dialog", { name: "工作区面板" });

      expect(await within(dialog).findByText("cc-pet-web")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Git 变更" })).toBeInTheDocument();
      expect(await within(dialog).findByRole("button", { name: /README\.md.*Git 修改/ })).toBeInTheDocument();
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

  it("defaults active connection to the one with newest server lastActiveAt after hydrate", async () => {
    adapter.connectWs.mockImplementation(() => {
      defaultConnectSnapshot([
        { id: "cc-connect", name: "cc-connect" },
        { id: "cs-connect", name: "cs-connect" },
      ]);
    });
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.includes("connectionId=cc-connect")) {
        return {
          sessions: [{ key: "s1", connectionId: "cc-connect", createdAt: 100, lastActiveAt: 1000 }],
        };
      }
      if (path.includes("connectionId=cs-connect")) {
        return {
          sessions: [{ key: "s2", connectionId: "cs-connect", createdAt: 100, lastActiveAt: 2000 }],
        };
      }
      if (path.startsWith("/api/history/")) return { messages: [] };
      return {};
    });

    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    await waitFor(() => {
      expect(useConnectionStore.getState().activeConnectionId).toBe("cs-connect");
    });
  });

  it("defaults active session to the one with the largest server lastActiveAt", async () => {
    adapter.connectWs.mockImplementation(() => {
      defaultConnectSnapshot([{ id: "cc-connect", name: "cc-connect" }]);
    });
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.includes("connectionId=cc-connect")) {
        return {
          sessions: [
            { key: "s-old", connectionId: "cc-connect", createdAt: 1, lastActiveAt: 100 },
            { key: "s-new", connectionId: "cc-connect", createdAt: 2, lastActiveAt: 900 },
          ],
        };
      }
      if (path.startsWith("/api/history/")) return { messages: [] };
      return {};
    });

    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    await waitFor(() => {
      expect(useSessionStore.getState().activeSessionKey["cc-connect"]).toBe("s-new");
      expect(useConnectionStore.getState().activeConnectionId).toBe("cc-connect");
    });
  });

  it("only fetches history for the active session at hydrate, lazy-loads others on switch", async () => {
    adapter.connectWs.mockImplementation(() => {
      defaultConnectSnapshot([{ id: "cc-connect", name: "cc-connect" }]);
    });
    const fetched: string[] = [];
    adapter.fetchApi.mockImplementation(async (path: string) => {
      if (path.includes("connectionId=cc-connect")) {
        return {
          sessions: [
            { key: "s-old", connectionId: "cc-connect", createdAt: 1, lastActiveAt: 100 },
            { key: "s-new", connectionId: "cc-connect", createdAt: 2, lastActiveAt: 900 },
          ],
        };
      }
      if (path.startsWith("/api/history/")) {
        fetched.push(decodeURIComponent(path.slice("/api/history/".length)));
        return { messages: [] };
      }
      return {};
    });

    render(<App />);
    await screen.findByPlaceholderText(INPUT_PLACEHOLDER);

    await waitFor(() => {
      expect(fetched).toEqual([makeChatKey("cc-connect", "s-new")]);
    });

    useSessionStore.getState().setActiveSession("cc-connect", "s-old");
    await waitFor(() => {
      expect(fetched).toContain(makeChatKey("cc-connect", "s-old"));
    });

    // Switching back to an already-loaded chat must not re-fetch.
    const before = fetched.length;
    useSessionStore.getState().setActiveSession("cc-connect", "s-new");
    await new Promise((r) => setTimeout(r, 0));
    expect(fetched.length).toBe(before);
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
