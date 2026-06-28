import { describe, expect, it, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatMessage } from "@cc-pet/shared";
import type { ToolStep } from "../lib/group-messages.js";
import { ActivityBlock } from "./ActivityBlock.js";

function toolMsg(id: string, content: string): ChatMessage {
  return { id, role: "assistant", content, timestamp: Date.now() };
}

function step(call: ChatMessage, result: ChatMessage | null = null): ToolStep {
  return { call, result };
}

const STEPS: ToolStep[] = [
  step(toolMsg("t1", "💭\nAnalyzing request...")),
  step(
    toolMsg("t2", '🔧 **工具 #1: Read**\n---\n`/path/to/skill.md`'),
    toolMsg("t2r", "🧾\n🟢 状态: ok\n🔢 退出码: 0\n```text\nfile contents here\n```"),
  ),
  step(toolMsg("t3", "💭\nPreparing API call...")),
  step(
    toolMsg("t4", '🔧 **工具 #2: Bash**\n---\n```bash\ncurl -sG "https://ziiimo.cn/api/..."\n```'),
    toolMsg("t4r", "🧾\n🔴 状态: failed\n🔢 退出码: 1\n```text\nrequest failed\n```"),
  ),
];

describe("ActivityBlock", () => {
  beforeEach(() => cleanup());

  it("renders in-progress state with spinner and labels", () => {
    render(<ActivityBlock steps={STEPS} done={false} />);

    expect(screen.getAllByText(/💭 思考/)).toHaveLength(2);
    expect(screen.getByText(/🔧 Read/)).toBeInTheDocument();
    expect(screen.getByText(/🔧 Bash/)).toBeInTheDocument();
    expect(screen.getByText("工具调用中…")).toBeInTheDocument();
  });

  it("renders collapsed done state by default with failure count", () => {
    render(<ActivityBlock steps={STEPS} done={true} />);

    expect(screen.getByText(/已执行 4 个操作（1 个失败）/)).toBeInTheDocument();
    expect(screen.queryByText(/🔧 Read/)).not.toBeInTheDocument();
  });

  it("omits failure suffix when all steps succeed", () => {
    const okSteps = [STEPS[1]];
    render(<ActivityBlock steps={okSteps} done={true} />);
    expect(screen.getByText(/已执行 1 个操作$/)).toBeInTheDocument();
  });

  it("expands on click to show call details", () => {
    render(<ActivityBlock steps={STEPS} done={true} />);

    fireEvent.click(screen.getByText(/已执行 4 个操作/));

    expect(screen.getByText(/🔧 Read/)).toBeInTheDocument();
    expect(screen.getByText(/🔧 Bash/)).toBeInTheDocument();
    expect(screen.getAllByText(/💭 思考/)).toHaveLength(2);
    expect(screen.getByText(/\/path\/to\/skill\.md/)).toBeInTheDocument();
    expect(screen.getByText(/curl -sG/)).toBeInTheDocument();
    expect(screen.getByText(/Analyzing request/)).toBeInTheDocument();
  });

  it("collapses again on second click", () => {
    render(<ActivityBlock steps={STEPS} done={true} />);

    fireEvent.click(screen.getByText(/已执行 4 个操作/));
    expect(screen.getByText(/🔧 Read/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/已执行 4 个操作/));
    expect(screen.queryByText(/🔧 Read/)).not.toBeInTheDocument();
  });

  it("shows result body when a step row is expanded", () => {
    render(<ActivityBlock steps={[STEPS[1]]} done={true} />);

    fireEvent.click(screen.getByText(/已执行 1 个操作/));
    const toggle = screen.getByText("▸");
    expect(screen.getByText(/file contents here/).className).toContain("hidden");

    fireEvent.click(toggle);
    expect(screen.getByText("▾")).toBeInTheDocument();
    expect(screen.getByText(/file contents here/).className).toContain("block");
  });

  it("supports click toggle raw detail in progress state", () => {
    const longRaw = "curl -sG https://example.com/api/with/a/very/long/path/and/query?x=1&y=2";
    const s = [step(toolMsg("t-long", `🔧 **工具 #9: Bash**\n---\n\`\`\`bash\n${longRaw}\n\`\`\``))];
    render(<ActivityBlock steps={s} done={false} />);

    expect(screen.getByText("▸")).toBeInTheDocument();
    const detailPre = screen.getByText(longRaw);
    expect(detailPre.className).toContain("hidden");

    fireEvent.click(screen.getByText("▸"));
    expect(screen.getByText("▾")).toBeInTheDocument();
    expect(detailPre.className).toContain("block");
  });

  it("shows single item without count text in progress", () => {
    render(<ActivityBlock steps={[STEPS[0]]} done={false} />);
    expect(screen.getByText("工具调用中…")).toBeInTheDocument();
  });
});
