import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

    const nextMessages = [...initialMessages, buildMessages(31)[30]!];
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
});
