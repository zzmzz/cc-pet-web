import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ChatMessage } from "@cc-pet/shared";
import { MessageList } from "./MessageList.js";
import { useOutboxStore } from "../lib/store/outbox.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { useSessionStore } from "../lib/store/session.js";
import { getPlatform } from "../lib/platform.js";
import { splitUsageFooter } from "../lib/footer.js";
import { getToolCallLabel } from "../lib/tool-call.js";

vi.mock("../lib/platform.js", () => ({ getPlatform: vi.fn() }));

// Counting pass-throughs, not stubs: both keep the real behaviour and only
// record that they ran. `splitUsageFooter` runs once per assistant bubble body
// and `getToolCallLabel` once per step of an ActivityBlock, so between them
// they count how much of the history actually re-rendered.
vi.mock("../lib/footer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/footer.js")>();
  return { ...actual, splitUsageFooter: vi.fn(actual.splitUsageFooter) };
});
vi.mock("../lib/tool-call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tool-call.js")>();
  return { ...actual, getToolCallLabel: vi.fn(actual.getToolCallLabel) };
});

/**
 * Synthesizes a session that exercises all three render paths — plain markdown
 * bubbles, fenced code (Prism), and 🔧/🧾 pairs that collapse into an
 * ActivityBlock — in roughly the proportion the real heavy session has
 * (2708 messages, 96% of them assistant tool traffic).
 */
function buildSession(count: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    const mod = i % 10;
    let role: ChatMessage["role"] = "assistant";
    let content: string;
    if (mod === 0) {
      role = "user";
      content = `帮我看下第 ${i} 个问题`;
    } else if (mod <= 5) {
      content = `🔧 **工具 #${i}: Bash**\n---\n\`\`\`bash\nls -d /home/hy/code/dir-${i} 2>/dev/null | head -50\n\`\`\``;
    } else if (mod <= 8) {
      content = `🧾\n🟢 状态: ok\n🔢 退出码: 0\n\`\`\`text\n${`输出行 ${i}\n`.repeat(12)}\`\`\``;
    } else {
      content = `第 ${i} 段说明文字。**要点**在这里，还有 \`inline code\` 和一个列表：\n\n- 甲\n- 乙\n- 丙\n\n\`\`\`ts\nconst x${i} = ${i};\nexport default x${i};\n\`\`\``;
    }
    msgs.push({ id: `m-${i}`, role, content, timestamp: 1_700_000_000_000 + i * 1000, seq: i + 1 });
  }
  return msgs;
}

const FRAMES = 20;

/** Mounts `n` messages, drives 20 typewriter frames, reports what re-rendered. */
function streamIntoSession(n: number): { bubbleBodies: number; toolSteps: number; msPerFrame: number } {
  const messages = buildSession(n);
  const { rerender, unmount } = render(
    <MessageList messages={messages} streamingContent="" sessionKey="s" />,
  );

  vi.mocked(splitUsageFooter).mockClear();
  vi.mocked(getToolCallLabel).mockClear();

  const start = performance.now();
  act(() => {
    for (let i = 1; i <= FRAMES; i++) {
      rerender(
        <MessageList messages={messages} streamingContent={"回答正在生成".repeat(i)} sessionKey="s" />,
      );
    }
  });
  const msPerFrame = (performance.now() - start) / FRAMES;

  const counts = {
    bubbleBodies: vi.mocked(splitUsageFooter).mock.calls.length,
    toolSteps: vi.mocked(getToolCallLabel).mock.calls.length,
    msPerFrame,
  };
  unmount();
  return counts;
}

describe("MessageList streaming cost vs history length", () => {
  beforeEach(() => {
    cleanup();
    useOutboxStore.setState({ entries: [] });
    if (!window.HTMLElement.prototype.scrollIntoView) {
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
    }
    vi.mocked(getPlatform).mockReturnValue({
      fetchApi: vi.fn().mockRejectedValue(new Error("link preview disabled in perf test")),
      flushOutbox: vi.fn(),
    } as never);
    useConnectionStore.setState({ activeConnectionId: null });
    useSessionStore.setState({ activeSessionKey: {} });
  });

  /**
   * The invariant: a typewriter frame must not re-render the history behind it.
   * Only the streaming bubble itself may be rebuilt, so the work per frame is
   * flat no matter how long the session is.
   *
   * Asserted on render counts rather than elapsed time on purpose — the counts
   * are exact and machine-independent, whereas a millisecond budget mostly
   * measures the CI runner. Before this was fixed, 20 frames over a 2700-message
   * session ran ~27k bubble bodies and ~27k tool steps (447ms/frame on the real
   * session); the timing is still printed below as a sanity signal.
   */
  it("does not re-render history while text streams in", () => {
    const small = streamIntoSession(200);
    const large = streamIntoSession(2700);

    process.stderr.write(
      `\n>>> n=200   气泡 ${small.bubbleBodies} 次 / 工具步 ${small.toolSteps} 次 / ${small.msPerFrame.toFixed(1)}ms 每帧` +
        `\n>>> n=2700  气泡 ${large.bubbleBodies} 次 / 工具步 ${large.toolSteps} 次 / ${large.msPerFrame.toFixed(1)}ms 每帧\n`,
    );

    // The streaming bubble is rebuilt once per frame; nothing else should be.
    expect(large.bubbleBodies).toBeLessThanOrEqual(FRAMES);
    expect(large.toolSteps).toBe(0);

    // And the count must not scale with how much history sits above it.
    expect(large.bubbleBodies).toBe(small.bubbleBodies);
    expect(large.toolSteps).toBe(small.toolSteps);
  }, 600_000);

  /**
   * Following the stream used to call scrollIntoView synchronously on every
   * typewriter frame, forcing a layout each time — cheap on a short session,
   * not on the long ones this is about. Coalescing to one call per animation
   * frame keeps the view glued to the newest text without paying per frame.
   */
  it("coalesces follow-the-stream scrolling into one call per frame", async () => {
    const scrollIntoView = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");
    const messages = buildSession(200);
    const { rerender, container } = render(
      <MessageList messages={messages} streamingContent="" sessionKey="s" />,
    );

    // Park the viewport at the bottom so the sticky-bottom branch is the one
    // under test; otherwise the effect takes the "回到最新" path instead.
    const scroller = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 1000 });
    fireEvent.scroll(scroller);

    scrollIntoView.mockClear();

    act(() => {
      for (let i = 1; i <= FRAMES; i++) {
        rerender(
          <MessageList messages={messages} streamingContent={"回答正在生成".repeat(i)} sessionKey="s" />,
        );
      }
    });

    // Nothing has scrolled yet — the frame hasn't run.
    expect(scrollIntoView).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto" });
    scrollIntoView.mockRestore();
  });
});
