import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@cc-pet/shared";
import { MessageList, HISTORY_WINDOW_STEP } from "./MessageList.js";
import { useOutboxStore } from "../lib/store/outbox.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { useSessionStore } from "../lib/store/session.js";
import { getPlatform } from "../lib/platform.js";

vi.mock("../lib/platform.js", () => ({ getPlatform: vi.fn() }));

function buildMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `第 ${i} 条消息`,
    timestamp: 1_700_000_000_000 + i * 1000,
    seq: i + 1,
  }));
}

/** Gives the scroll container measurable geometry; jsdom reports every box as 0. */
function stubGeometry(container: HTMLElement, { scrollTop = 1000, scrollHeight = 5000 } = {}) {
  const scroller = container.querySelector(".overflow-y-auto") as HTMLDivElement;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, writable: true, value: scrollHeight });
  Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: scrollTop });
  return scroller;
}

describe("MessageList history window", () => {
  beforeEach(() => {
    cleanup();
    useOutboxStore.setState({ entries: [] });
    if (!window.HTMLElement.prototype.scrollIntoView) {
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
    }
    vi.mocked(getPlatform).mockReturnValue({
      fetchApi: vi.fn().mockRejectedValue(new Error("no network in test")),
      flushOutbox: vi.fn(),
    } as never);
    useConnectionStore.setState({ activeConnectionId: null });
    useSessionStore.setState({ activeSessionKey: {}, pendingScrollMessageId: null });
  });

  it("renders only the newest window, not the whole history", () => {
    const messages = buildMessages(HISTORY_WINDOW_STEP * 3);
    render(<MessageList messages={messages} sessionKey="s" />);

    // Newest message is in; one older than the window is not.
    expect(screen.getByText(`第 ${messages.length - 1} 条消息`)).toBeInTheDocument();
    expect(screen.queryByText("第 0 条消息")).not.toBeInTheDocument();
  });

  it("shows an affordance for the older messages it is holding back", () => {
    render(<MessageList messages={buildMessages(HISTORY_WINDOW_STEP * 2)} sessionKey="s" />);
    expect(screen.getByRole("button", { name: /加载更早的消息/ })).toBeInTheDocument();
  });

  it("hides that affordance once the whole history is on screen", () => {
    render(<MessageList messages={buildMessages(5)} sessionKey="s" />);
    expect(screen.queryByRole("button", { name: /加载更早的消息/ })).not.toBeInTheDocument();
  });

  it("widens the window when scrolled to the top", async () => {
    const messages = buildMessages(HISTORY_WINDOW_STEP * 3);
    const { container } = render(<MessageList messages={messages} sessionKey="s" />);

    const oneStepBack = messages.length - HISTORY_WINDOW_STEP - 1;
    expect(screen.queryByText(`第 ${oneStepBack} 条消息`)).not.toBeInTheDocument();

    const scroller = stubGeometry(container, { scrollTop: 0 });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(screen.getByText(`第 ${oneStepBack} 条消息`)).toBeInTheDocument();
    });
  });

  /**
   * Prepending older messages pushes the content the reader was looking at
   * downward. Without compensation the view jumps by exactly the height of
   * what was inserted, which reads as the list scrolling itself.
   */
  it("keeps the reader's position when older messages are prepended", () => {
    const messages = buildMessages(HISTORY_WINDOW_STEP * 3);
    const { container } = render(<MessageList messages={messages} sessionKey="s" />);
    const scroller = container.querySelector(".overflow-y-auto") as HTMLDivElement;

    // jsdom lays nothing out, so scrollHeight has to be derived from what is
    // actually rendered — a fixed number would be read before and after the
    // window grows and the compensation would look like a no-op. Tying it to
    // the child count reproduces the one thing that matters: the document gets
    // taller in the same commit the layout effect runs in.
    const ROW_PX = 20;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => scroller.children.length * ROW_PX,
    });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });

    const heightBefore = scroller.scrollHeight;
    fireEvent.scroll(scroller);
    const grown = scroller.scrollHeight - heightBefore;

    expect(grown).toBeGreaterThan(0); // the window really did widen
    expect(scroller.scrollTop).toBe(grown); // and the view was pushed back by exactly that much
  });

  it("widens the window to reach a search result older than it", async () => {
    const messages = buildMessages(HISTORY_WINDOW_STEP * 3);
    const target = messages[10];
    render(<MessageList messages={messages} sessionKey="s" />);

    expect(screen.queryByText(target.content)).not.toBeInTheDocument();

    act(() => {
      useSessionStore.setState({ pendingScrollMessageId: target.id });
    });

    await waitFor(() => {
      expect(screen.getByText(target.content)).toBeInTheDocument();
    });
  });

  /**
   * The first batch of history is an arrival, not a new message: it must land
   * at the bottom instantly. Animating it makes the browser scroll through
   * every message on the way down, which is what a long session looked like.
   */
  it("lands on the newest message instantly when history first arrives", async () => {
    const scrollIntoView = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");
    const { rerender } = render(<MessageList messages={[]} sessionKey="s" />);

    scrollIntoView.mockClear();
    rerender(<MessageList messages={buildMessages(300)} sessionKey="s" />);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto" });
    expect(scrollIntoView).not.toHaveBeenCalledWith({ behavior: "smooth" });
    scrollIntoView.mockRestore();
  });

  it("still animates to a message that arrives after the initial load", async () => {
    const scrollIntoView = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");
    const messages = buildMessages(300);
    const { rerender, container } = render(<MessageList messages={[]} sessionKey="s" />);
    rerender(<MessageList messages={messages} sessionKey="s" />);

    stubGeometry(container, { scrollTop: 4600, scrollHeight: 5000 });
    scrollIntoView.mockClear();

    const later: ChatMessage = {
      id: "m-new", role: "assistant", content: "刚到的回复", timestamp: 1_800_000_000_000,
    };
    rerender(<MessageList messages={[...messages, later]} sessionKey="s" />);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" }));
    scrollIntoView.mockRestore();
  });

  it("re-arms the instant landing when switching to another session", async () => {
    const scrollIntoView = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");
    const { rerender } = render(<MessageList messages={buildMessages(300)} sessionKey="a" />);

    scrollIntoView.mockClear();
    rerender(<MessageList messages={buildMessages(300)} sessionKey="b" />);

    await act(async () => { await new Promise((r) => requestAnimationFrame(r)); });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto" });
    scrollIntoView.mockRestore();
  });

  it("restarts the window at the newest messages after a session switch", () => {
    const messages = buildMessages(HISTORY_WINDOW_STEP * 3);
    const { container, rerender } = render(<MessageList messages={messages} sessionKey="a" />);

    const scroller = stubGeometry(container, { scrollTop: 0 });
    fireEvent.scroll(scroller);

    rerender(<MessageList messages={messages} sessionKey="b" />);
    expect(screen.queryByText("第 0 条消息")).not.toBeInTheDocument();
  });
});
