import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Layout } from "./Layout.js";
import { useUIStore } from "../lib/store/ui.js";
import { useSearchStore } from "../lib/store/search.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { useSessionStore } from "../lib/store/session.js";
import { useMessageStore } from "../lib/store/message.js";
import { useWorkspaceStore } from "../lib/store/workspace.js";

const platformMock = vi.hoisted(() => ({
  fetchApi: vi.fn(),
}));

vi.mock("../lib/platform.js", () => ({
  getPlatform: () => ({ fetchApi: platformMock.fetchApi }),
}));

function resetStores() {
  useUIStore.setState({ chatOpen: true, petState: "idle", isMobile: false, settingsOpen: false });
  useSearchStore.setState({ query: "", results: [], total: 0, loading: false, isOpen: false });
  useConnectionStore.setState({ connections: [], activeConnectionId: null });
  useMessageStore.setState({ messagesByChat: {}, streamingContent: {} });
  useSessionStore.setState({ sessions: {}, activeSessionKey: {}, unread: {}, taskStateByConnection: {} });
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  platformMock.fetchApi.mockReset();
  platformMock.fetchApi.mockResolvedValue({});
}

function setMobile(width = 390) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

function setDesktop(width = 1024) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

function seedConnection() {
  useConnectionStore.setState({
    connections: [{ id: "c1", name: "Bot", connected: true }],
    activeConnectionId: "c1",
  });
  useSessionStore.setState({
    sessions: { c1: [{ key: "s1", connectionId: "c1", createdAt: 1, lastActiveAt: 1 }] },
    activeSessionKey: { c1: "s1" },
  });
}

describe("Layout", () => {
  const originalWidth = window.innerWidth;

  beforeEach(() => {
    cleanup();
    resetStores();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalWidth });
  });

  describe("mobile layout", () => {
    it("uses h-full layout with overflow hidden", () => {
      setMobile();
      render(<Layout><div>content</div></Layout>);

      const header = document.querySelector("header")!;
      const root = header.parentElement!;
      expect(root.className).toContain("h-full");
      expect(root.className).toContain("overflow-hidden");
      expect(root.className).toContain("flex-col");
    });

    it("renders header with search and settings buttons", () => {
      setMobile();
      render(<Layout><div>content</div></Layout>);

      const header = document.querySelector("header")!;
      const buttons = header.querySelectorAll("button");
      const svgButtons = Array.from(buttons).filter((b) => b.querySelector("svg"));
      expect(svgButtons.length).toBe(2);
    });

    it("opens a reusable workspace panel from the mobile header", async () => {
      const user = userEvent.setup();
      setMobile();
      seedConnection();
      platformMock.fetchApi.mockImplementation(async (path: string) => {
        if (path === "/api/workspaces/c1") {
          return { connectionId: "c1", configured: true, rootName: "demo-workspace" };
        }
        if (path === "/api/workspaces/c1/tree") {
          return {
            path: "",
            entries: [{ name: "README.md", path: "README.md", kind: "file", extension: ".md", inaccessible: false }],
          };
        }
        if (path === "/api/workspaces/c1/git/status") {
          return { gitAvailable: true, changes: [{ path: "README.md", status: "M" }] };
        }
        return {};
      });
      render(<Layout><div>content</div></Layout>);

      await user.click(screen.getByRole("button", { name: "工作区" }));
      const dialog = screen.getByRole("dialog", { name: "工作区面板" });

      expect(await within(dialog).findByText("demo-workspace")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Git 变更" })).toBeInTheDocument();
      expect(await within(dialog).findByRole("button", { name: /README\.md.*Git 修改/ })).toBeInTheDocument();
    });

    it("toggles search panel when search button is clicked", async () => {
      const user = userEvent.setup();
      setMobile();
      render(<Layout><div>content</div></Layout>);

      expect(document.querySelector("[data-testid='search-panel'], .search-panel")).toBeNull();

      const header = document.querySelector("header")!;
      const buttons = Array.from(header.querySelectorAll("button")).filter((b) => b.querySelector("svg"));
      const searchBtn = buttons[0]!;
      await user.click(searchBtn);

      expect(useSearchStore.getState().isOpen).toBe(true);
    });

    it("opens settings when settings button is clicked", async () => {
      const user = userEvent.setup();
      setMobile();
      render(<Layout><div>content</div></Layout>);

      const header = document.querySelector("header")!;
      const buttons = Array.from(header.querySelectorAll("button")).filter((b) => b.querySelector("svg"));
      const settingsBtn = buttons[1]!;
      await user.click(settingsBtn);

      expect(useUIStore.getState().settingsOpen).toBe(true);
    });

    it("renders children in the main area", () => {
      setMobile();
      render(<Layout><div data-testid="child">hello</div></Layout>);

      const main = document.querySelector("main")!;
      expect(within(main).getByTestId("child")).toBeInTheDocument();
    });

    it("main area uses flex-1 and overflow-hidden for proper scroll containment", () => {
      setMobile();
      render(<Layout><div>content</div></Layout>);

      const main = document.querySelector("main")!;
      expect(main.className).toContain("flex-1");
      expect(main.className).toContain("overflow-hidden");
      expect(main.className).toContain("min-h-0");
    });

    it("header has safe-area padding for notch devices", () => {
      setMobile();
      render(<Layout><div>content</div></Layout>);

      const header = document.querySelector("header")!;
      expect(header.className).toContain("safe-area-inset-top");
    });

    it("header has z-index and shadow for visual separation", () => {
      setMobile();
      render(<Layout><div>content</div></Layout>);

      const header = document.querySelector("header")!;
      expect(header.className).toContain("z-20");
      expect(header.className).toContain("shadow-sm");
    });
  });

  describe("desktop layout", () => {
    it("uses h-full flex layout", () => {
      setDesktop();
      render(<Layout><div>content</div></Layout>);

      const containers = document.querySelectorAll("div.flex.h-full");
      expect(containers.length).toBeGreaterThanOrEqual(1);
    });

    it("renders sidebar with search panel and session dropdown", () => {
      setDesktop();
      render(<Layout><div>content</div></Layout>);

      const aside = document.querySelector("aside")!;
      expect(aside).toBeTruthy();
      expect(aside.className).toContain("w-72");
    });

    it("shows text settings button instead of icon", () => {
      setDesktop();
      render(<Layout><div>content</div></Layout>);

      expect(screen.getByText("设置")).toBeInTheDocument();
    });

    it("does not show search/settings icon buttons in header", () => {
      setDesktop();
      render(<Layout><div>content</div></Layout>);

      const header = document.querySelector("header")!;
      const svgButtons = Array.from(header.querySelectorAll("button")).filter((b) => b.querySelector("svg"));
      expect(svgButtons.length).toBe(0);
    });

    it("renders PetFull in bottom-left fixed position", () => {
      setDesktop();
      render(<Layout><div>content</div></Layout>);

      const petContainer = document.querySelector("div.fixed.left-4.bottom-4");
      expect(petContainer).toBeTruthy();
    });

    it("shows the workspace panel for the active connection", async () => {
      setDesktop();
      seedConnection();
      platformMock.fetchApi.mockImplementation(async (path: string) => {
        if (path === "/api/workspaces/c1") {
          return { connectionId: "c1", configured: true, rootName: "demo-workspace" };
        }
        if (path === "/api/workspaces/c1/tree") {
          return {
            path: "",
            entries: [
              { name: "src", path: "src", kind: "directory", inaccessible: false },
              { name: "README.md", path: "README.md", kind: "file", extension: ".md", inaccessible: false },
            ],
          };
        }
        if (path === "/api/workspaces/c1/git/status") {
          return { gitAvailable: true, changes: [] };
        }
        return {};
      });

      render(<Layout><div>content</div></Layout>);

      expect(await screen.findByText("工作区")).toBeInTheDocument();
      expect(await screen.findByText("demo-workspace")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /README\.md/ })).toBeInTheDocument();
    });

    it("shows git change badges and opens a diff from the git tab", async () => {
      const user = userEvent.setup();
      setDesktop();
      seedConnection();
      platformMock.fetchApi.mockImplementation(async (path: string) => {
        if (path === "/api/workspaces/c1") {
          return { connectionId: "c1", configured: true, rootName: "demo-workspace" };
        }
        if (path === "/api/workspaces/c1/tree") {
          return {
            path: "",
            entries: [
              { name: "README.md", path: "README.md", kind: "file", extension: ".md", inaccessible: false },
            ],
          };
        }
        if (path === "/api/workspaces/c1/git/status") {
          return { gitAvailable: true, changes: [{ path: "README.md", status: "M" }] };
        }
        if (path === "/api/workspaces/c1/git/diff?path=README.md") {
          return {
            path: "README.md",
            previewable: true,
            diff: "diff --git a/README.md b/README.md\n-old\n+new\n",
          };
        }
        return {};
      });

      render(<Layout><div>content</div></Layout>);

      expect(await screen.findByText("Git 修改")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Git 变更" }));
      await user.click(await screen.findByRole("button", { name: /README\.md/ }));

      expect(await screen.findByText("Diff 查看")).toBeInTheDocument();
      expect(screen.getByText("+new")).toBeInTheDocument();
    });

    it("marks parent directories when nested files have git changes", async () => {
      setDesktop();
      seedConnection();
      platformMock.fetchApi.mockImplementation(async (path: string) => {
        if (path === "/api/workspaces/c1") {
          return { connectionId: "c1", configured: true, rootName: "demo-workspace" };
        }
        if (path === "/api/workspaces/c1/tree") {
          return { path: "", entries: [{ name: "src", path: "src", kind: "directory", inaccessible: false }] };
        }
        if (path === "/api/workspaces/c1/git/status") {
          return { gitAvailable: true, changes: [{ path: "src/index.ts", status: "M" }] };
        }
        return {};
      });

      render(<Layout><div>content</div></Layout>);

      expect(await screen.findByRole("button", { name: /src.*Git 修改/ })).toBeInTheDocument();
    });

    it("renders git empty and unavailable states", async () => {
      const user = userEvent.setup();
      setDesktop();
      seedConnection();
      let unavailable = false;
      platformMock.fetchApi.mockImplementation(async (path: string) => {
        if (path === "/api/workspaces/c1") {
          return { connectionId: "c1", configured: true, rootName: "demo-workspace" };
        }
        if (path === "/api/workspaces/c1/tree") {
          return { path: "", entries: [] };
        }
        if (path === "/api/workspaces/c1/git/status") {
          return unavailable
            ? { gitAvailable: false, changes: [], message: "Git 状态不可用，文件浏览仍可继续使用。" }
            : { gitAvailable: true, changes: [] };
        }
        return {};
      });

      render(<Layout><div>content</div></Layout>);
      await user.click(await screen.findByRole("button", { name: "Git 变更" }));
      expect(await screen.findByText("暂无 Git 变更。")).toBeInTheDocument();

      unavailable = true;
      await user.click(screen.getByRole("button", { name: "刷新 Git 状态" }));
      expect(await screen.findByText("Git 状态不可用，文件浏览仍可继续使用。")).toBeInTheDocument();
    });

    it("expands and collapses directory children without losing file context", async () => {
      const user = userEvent.setup();
      setDesktop();
      seedConnection();
      platformMock.fetchApi.mockImplementation(async (path: string) => {
        if (path === "/api/workspaces/c1") {
          return { connectionId: "c1", configured: true, rootName: "demo-workspace" };
        }
        if (path === "/api/workspaces/c1/tree") {
          return { path: "", entries: [{ name: "src", path: "src", kind: "directory", inaccessible: false }] };
        }
        if (path === "/api/workspaces/c1/tree?path=src") {
          return {
            path: "src",
            entries: [{ name: "index.ts", path: "src/index.ts", kind: "file", extension: ".ts", inaccessible: false }],
          };
        }
        if (path === "/api/workspaces/c1/file?path=src%2Findex.ts") {
          return {
            path: "src/index.ts",
            name: "index.ts",
            previewable: true,
            encoding: "utf8",
            content: "export const ok = true;\n",
            size: 24,
          };
        }
        return {};
      });

      render(<Layout><div>content</div></Layout>);
      const srcButton = await screen.findByRole("button", { name: /src/ });

      await user.click(srcButton);
      const fileButton = await screen.findByRole("button", { name: /index\.ts/ });
      await user.click(fileButton);
      expect(await screen.findByText("src/index.ts")).toBeInTheDocument();

      await user.click(srcButton);
      expect(screen.queryByRole("button", { name: /index\.ts/ })).not.toBeInTheDocument();
      expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    });

    it("renders empty, inaccessible, and large-file preview states", async () => {
      const user = userEvent.setup();
      setDesktop();
      seedConnection();
      platformMock.fetchApi.mockImplementation(async (path: string) => {
        if (path === "/api/workspaces/c1") {
          return { connectionId: "c1", configured: true, rootName: "demo-workspace" };
        }
        if (path === "/api/workspaces/c1/tree") {
          return {
            path: "",
            entries: [
              { name: "empty", path: "empty", kind: "directory", inaccessible: false },
              { name: "secret", path: "secret", kind: "directory", inaccessible: true },
              { name: "large.txt", path: "large.txt", kind: "file", extension: ".txt", inaccessible: false },
            ],
          };
        }
        if (path === "/api/workspaces/c1/tree?path=empty") {
          return { path: "empty", entries: [] };
        }
        if (path === "/api/workspaces/c1/file?path=large.txt") {
          return { path: "large.txt", name: "large.txt", previewable: false, reason: "FILE_TOO_LARGE", size: 70000 };
        }
        return {};
      });

      render(<Layout><div>content</div></Layout>);

      await user.click(await screen.findByRole("button", { name: /empty/ }));
      expect(await screen.findByText("目录为空")).toBeInTheDocument();
      expect(screen.getByText("不可访问")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /large\.txt/ }));
      expect(await screen.findByText("文件过大，无法直接预览。")).toBeInTheDocument();
    });

    it("blocks invalid create names and creates valid files with refreshed tree feedback", async () => {
      const user = userEvent.setup();
      const promptSpy = vi.spyOn(window, "prompt");
      try {
        setDesktop();
        seedConnection();
        promptSpy.mockReturnValueOnce("  ").mockReturnValueOnce("notes.txt");
        platformMock.fetchApi.mockImplementation(async (path: string, options?: RequestInit) => {
          if (path === "/api/workspaces/c1") {
            return { connectionId: "c1", configured: true, rootName: "demo-workspace" };
          }
          if (path === "/api/workspaces/c1/tree") {
            return {
              path: "",
              entries: [{ name: "notes.txt", path: "notes.txt", kind: "file", extension: ".txt", inaccessible: false }],
            };
          }
          if (path === "/api/workspaces/c1/items" && options?.method === "POST") {
            return { ok: true, entry: { name: "notes.txt", path: "notes.txt", kind: "file", extension: ".txt" } };
          }
          return {};
        });

        render(<Layout><div>content</div></Layout>);
        const createFileButton = await screen.findByRole("button", { name: "新建文件" });

        await user.click(createFileButton);
        expect(await screen.findByText("名称不能为空。")).toBeInTheDocument();
        expect(platformMock.fetchApi).not.toHaveBeenCalledWith(
          "/api/workspaces/c1/items",
          expect.objectContaining({ method: "POST" }),
        );

        await user.click(createFileButton);
        expect(await screen.findByRole("button", { name: /notes\.txt/ })).toBeInTheDocument();
        expect(screen.getByText("已创建 notes.txt")).toBeInTheDocument();
      } finally {
        promptSpy.mockRestore();
      }
    });

    it("requires explicit recursive confirmation before deleting directories", async () => {
      const user = userEvent.setup();
      const confirmSpy = vi.spyOn(window, "confirm");
      try {
        setDesktop();
        seedConnection();
        confirmSpy.mockReturnValueOnce(true).mockReturnValueOnce(true);
        platformMock.fetchApi.mockImplementation(async (path: string, options?: RequestInit) => {
          if (path === "/api/workspaces/c1") {
            return { connectionId: "c1", configured: true, rootName: "demo-workspace" };
          }
          if (path === "/api/workspaces/c1/tree") {
            return { path: "", entries: [{ name: "src", path: "src", kind: "directory", inaccessible: false }] };
          }
          if (path === "/api/workspaces/c1/items" && options?.method === "DELETE") {
            return { ok: true };
          }
          return {};
        });

        render(<Layout><div>content</div></Layout>);
        const srcRow = await screen.findByRole("button", { name: /src/ });
        const rowContainer = srcRow.closest("[data-file-entry]") as HTMLElement;
        await user.click(within(rowContainer).getByRole("button", { name: "删除" }));

        expect(confirmSpy).toHaveBeenNthCalledWith(1, "确认删除 src？");
        expect(confirmSpy).toHaveBeenNthCalledWith(2, "src 是目录，确认递归删除其全部内容？");
        expect(platformMock.fetchApi).toHaveBeenCalledWith(
          "/api/workspaces/c1/items",
          expect.objectContaining({
            method: "DELETE",
            body: JSON.stringify({ path: "src", recursive: true }),
          }),
        );
      } finally {
        confirmSpy.mockRestore();
      }
    });
  });

  describe("responsive switching", () => {
    it("switches from desktop to mobile layout on resize", async () => {
      setDesktop();
      const { container } = render(<Layout><div>content</div></Layout>);

      expect(document.querySelector("aside")).toBeTruthy();

      setMobile();
      await vi.waitFor(() => {
        expect(useUIStore.getState().isMobile).toBe(true);
      });

      expect(document.querySelector("aside")).toBeNull();
      const header = document.querySelector("header")!;
      expect(header.parentElement!.className).toContain("h-full");
    });

    it("switches from mobile to desktop layout on resize", async () => {
      setMobile();
      render(<Layout><div>content</div></Layout>);

      const header = document.querySelector("header")!;
      expect(header.parentElement!.className).toContain("h-full");

      setDesktop();
      await vi.waitFor(() => {
        expect(useUIStore.getState().isMobile).toBe(false);
      });

      expect(document.querySelector("aside")).toBeTruthy();
    });
  });

  describe("session dropdown mobile touch targets", () => {
    it("mobile dropdown uses wider container (w-72) than desktop panel", async () => {
      const user = userEvent.setup();
      setMobile();
      seedConnection();
      render(<Layout><div>content</div></Layout>);

      const dropdownBtn = screen.getByRole("button", { name: /Bot|s1/ });
      await user.click(dropdownBtn);

      const dropdown = document.querySelector("div.z-50");
      expect(dropdown).toBeTruthy();
      expect(dropdown!.className).toContain("w-72");
    });

    it("mobile dropdown items have larger touch-friendly padding", async () => {
      const user = userEvent.setup();
      setMobile();
      seedConnection();
      render(<Layout><div>content</div></Layout>);

      const dropdownBtn = screen.getByRole("button", { name: /Bot|s1/ });
      await user.click(dropdownBtn);

      const currentSession = document.querySelector(".bg-accent\\/10");
      expect(currentSession).toBeTruthy();
      expect(currentSession!.className).toContain("py-2.5");
      expect(currentSession!.className).toContain("px-3");
    });

    it("mobile dropdown uses larger font size (text-sm) vs desktop (text-[13px])", async () => {
      const user = userEvent.setup();
      setMobile();
      seedConnection();
      render(<Layout><div>content</div></Layout>);

      const dropdownBtn = screen.getByRole("button", { name: /Bot|s1/ });
      await user.click(dropdownBtn);

      const sessionLabel = document.querySelector(".bg-accent\\/10 .text-sm");
      expect(sessionLabel).toBeTruthy();
    });
  });
});
