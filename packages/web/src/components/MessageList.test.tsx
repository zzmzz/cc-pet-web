import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatMessage } from "@cc-pet/shared";
import { MessageList } from "./MessageList.js";

function buildMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message-${i}`,
    timestamp: i + 1,
  }));
}

describe("MessageList", () => {
  beforeEach(() => {
    cleanup();
    if (!window.HTMLElement.prototype.scrollIntoView) {
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
    }
    vi.clearAllMocks();
  });

  it("shows 回到最新 when new message arrives away from bottom", async () => {
    const scrollIntoView = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");
    const initialMessages = buildMessages(30);
    const { rerender, container } = render(<MessageList messages={initialMessages} />);

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement | null;
    expect(scrollContainer).toBeTruthy();

    Object.defineProperty(scrollContainer!, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scrollContainer!, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(scrollContainer!, "scrollTop", { configurable: true, writable: true, value: 200 });
    fireEvent.scroll(scrollContainer!);

    scrollIntoView.mockClear();

    const assistantMsg: ChatMessage = { id: "m-new", role: "assistant", content: "new reply", timestamp: 999 };
    const nextMessages = [...initialMessages, assistantMsg];
    rerender(<MessageList messages={nextMessages} />);

    const backToLatest = await screen.findByRole("button", { name: "回到最新" });
    expect(backToLatest).toBeInTheDocument();
    expect(backToLatest.className).toContain("text-gray-800");

    fireEvent.click(backToLatest);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("scrolls to latest when session key changes", () => {
    const scrollIntoView = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");
    const messages = buildMessages(5);
    const { rerender } = render(<MessageList messages={messages} sessionKey="session-a" />);

    scrollIntoView.mockClear();
    rerender(<MessageList messages={messages} sessionKey="session-b" />);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto" });
  });

  it("auto scrolls when new message arrives while already at bottom", () => {
    const scrollIntoView = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");
    const initialMessages = buildMessages(20);
    const { rerender, container } = render(<MessageList messages={initialMessages} sessionKey="session-a" />);

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement | null;
    expect(scrollContainer).toBeTruthy();

    Object.defineProperty(scrollContainer!, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scrollContainer!, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(scrollContainer!, "scrollTop", { configurable: true, writable: true, value: 1000 });
    fireEvent.scroll(scrollContainer!);

    scrollIntoView.mockClear();

    const nextMessages = [...initialMessages, buildMessages(21)[20]!];
    rerender(<MessageList messages={nextMessages} sessionKey="session-a" />);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" });
    expect(screen.queryByRole("button", { name: "回到最新" })).not.toBeInTheDocument();
  });

  it("copies fenced code block content with one click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const messages: ChatMessage[] = [
      {
        id: "assistant-code",
        role: "assistant",
        content: "```ts\nconst answer = 42;\n```",
        timestamp: Date.now(),
      },
    ];

    render(<MessageList messages={messages} />);

    const copyButton = screen.getByRole("button", { name: "复制代码" });
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("renders assistant link as preview card", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://example.com/article",
        title: "Example Article",
        description: "Preview description",
        image: "https://example.com/cover.png",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const messages: ChatMessage[] = [
      {
        id: "assistant-link",
        role: "assistant",
        content: "请查看 [示例链接](https://example.com/article)",
        timestamp: Date.now(),
      },
    ];

    render(<MessageList messages={messages} />);

    const title = await screen.findByText("示例链接");
    expect(title).toBeInTheDocument();
    expect(screen.getByAltText("链接站点图标")).toHaveAttribute("src", "https://example.com/favicon.ico");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/link-preview?url=https%3A%2F%2Fexample.com%2Farticle",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uses finalUrl metadata for redirect short links", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://t.cn/A6abc",
        finalUrl: "https://docs.example.com/path/to/page",
        title: "落地页标题",
        description: "落地页描述",
        image: "",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const messages: ChatMessage[] = [
      {
        id: "assistant-short-link",
        role: "assistant",
        content: "短链 [点击查看](https://t.cn/A6abc)",
        timestamp: Date.now(),
      },
    ];

    render(<MessageList messages={messages} />);

    expect(await screen.findByText("落地页标题")).toBeInTheDocument();
    expect(screen.getByText("落地页标题").closest("a")).toHaveAttribute("href", "https://t.cn/A6abc");
    expect(screen.getByText(/docs\.example\.com/)).toBeInTheDocument();
    const thumbs = screen.getAllByAltText("链接站点图标");
    expect(
      thumbs.some((img) => img.getAttribute("src") === "https://docs.example.com/favicon.ico"),
    ).toBe(true);
  });

  it("renders file link as download card", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://files.example.com/report.pdf",
        finalUrl: "https://files.example.com/report.pdf",
        title: "report.pdf",
        description: "",
        image: "",
        isFile: true,
        fileName: "report.pdf",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const messages: ChatMessage[] = [
      {
        id: "assistant-file-link",
        role: "assistant",
        content: "[report.pdf](https://files.example.com/report.pdf)",
        timestamp: Date.now(),
      },
    ];

    render(<MessageList messages={messages} />);

    expect(await screen.findByText("下载文件")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText(/files\.example\.com/)).toBeInTheDocument();
  });

  it("prefers extracted filename over raw short-link text for file cards", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://ziiimo.cn/v/f317",
        finalUrl: "https://data.ziiimo.cn:99/data/2026-03/test-upload.md?X-Amz-foo=bar",
        title: "",
        description: "",
        image: "",
        isFile: true,
        fileName: "test-upload.md",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const messages: ChatMessage[] = [
      {
        id: "assistant-file-short-link",
        role: "assistant",
        content: "https://ziiimo.cn/v/f317",
        timestamp: Date.now(),
      },
    ];

    render(<MessageList messages={messages} />);

    expect(await screen.findByText("test-upload.md")).toBeInTheDocument();
    expect(screen.queryByText("https://ziiimo.cn/v/f317")).not.toBeInTheDocument();
  });

  it("copies original link from preview card", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://t.cn/A6abc",
        finalUrl: "https://docs.example.com/path/to/page",
        title: "落地页标题",
        description: "落地页描述",
        image: "",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const messages: ChatMessage[] = [
      {
        id: "assistant-short-link-copy",
        role: "assistant",
        content: "[点击查看](https://t.cn/A6abc)",
        timestamp: Date.now(),
      },
    ];

    render(<MessageList messages={messages} />);
    const cardLink = (await screen.findByText("落地页标题")).closest("a");
    expect(cardLink).toBeTruthy();
    const copyButton = within(cardLink as HTMLElement).getByRole("button", { name: "复制链接" });
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith("https://t.cn/A6abc");
  });

  it("collapses consecutive tool call messages into an ActivityBlock", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "shorten this link", timestamp: 1 },
      { id: "t1", role: "assistant", content: "💭\nthinking...", timestamp: 2 },
      { id: "t2", role: "assistant", content: '🔧 **工具 #1: Bash**\n---\ncurl ...', timestamp: 3 },
      { id: "a1", role: "assistant", content: "短链已生成：https://ziiimo.cn/u/3849", timestamp: 4 },
    ];

    render(<MessageList messages={messages} />);

    expect(screen.getByText(/已执行 2 个操作/)).toBeInTheDocument();
    expect(screen.getByText(/短链已生成/)).toBeInTheDocument();
    expect(screen.queryByText("💭")).not.toBeInTheDocument();
  });

  it("shows in-progress ActivityBlock when tool calls are at the end", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "do something", timestamp: 1 },
      { id: "t1", role: "assistant", content: '🔧 **工具 #1: Read**\n---\n`file.md`', timestamp: 2 },
    ];

    render(<MessageList messages={messages} />);

    expect(screen.getByText("工具调用中…")).toBeInTheDocument();
  });

  it("expands collapsed ActivityBlock on click", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hello", timestamp: 1 },
      { id: "t1", role: "assistant", content: "💭\nthinking...", timestamp: 2 },
      { id: "t2", role: "assistant", content: '🔧 **工具 #1: Bash**\n---\ncurl ...', timestamp: 3 },
      { id: "a1", role: "assistant", content: "done!", timestamp: 4 },
    ];

    render(<MessageList messages={messages} />);

    const summary = screen.getByText(/已执行 2 个操作/);
    fireEvent.click(summary);

    expect(screen.getByText(/🔧 Bash/)).toBeInTheDocument();
    expect(screen.getByText(/💭 思考/)).toBeInTheDocument();
  });
});
