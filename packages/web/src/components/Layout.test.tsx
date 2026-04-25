import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Layout } from "./Layout.js";
import { useUIStore } from "../lib/store/ui.js";
import { useSearchStore } from "../lib/store/search.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { useSessionStore } from "../lib/store/session.js";
import { useMessageStore } from "../lib/store/message.js";

vi.mock("../lib/platform.js", () => ({
  getPlatform: () => ({ fetchApi: vi.fn().mockResolvedValue({}) }),
}));

function resetStores() {
  useUIStore.setState({ chatOpen: true, petState: "idle", isMobile: false, settingsOpen: false });
  useSearchStore.setState({ query: "", results: [], total: 0, loading: false, isOpen: false });
  useConnectionStore.setState({ connections: [], activeConnectionId: null });
  useMessageStore.setState({ messagesByChat: {}, streamingContent: {} });
  useSessionStore.setState({ sessions: {}, activeSessionKey: {}, unread: {}, taskStateByConnection: {} });
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
