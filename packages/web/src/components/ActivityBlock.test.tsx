import { describe, expect, it, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatMessage } from "@cc-pet/shared";
import { ActivityBlock } from "./ActivityBlock.js";

function toolMsg(id: string, content: string): ChatMessage {
  return { id, role: "assistant", content, timestamp: Date.now() };
}

const TOOL_MSGS: ChatMessage[] = [
  toolMsg("t1", "💭\nAnalyzing request..."),
  toolMsg("t2", '🔧 **工具 #1: Read**\n---\n`/path/to/skill.md`'),
  toolMsg("t3", "💭\nPreparing API call..."),
  toolMsg("t4", '🔧 **工具 #2: Bash**\n---\n```bash\ncurl -sG "https://ziiimo.cn/api/..."\n```'),
];

describe("ActivityBlock", () => {
  beforeEach(() => cleanup());

  it("renders in-progress state with spinner on last item", () => {
    render(<ActivityBlock messages={TOOL_MSGS} done={false} />);

    expect(screen.getAllByText(/💭 思考/)).toHaveLength(2);
    expect(screen.getByText(/🔧 Read/)).toBeInTheDocument();
    expect(screen.getByText(/🔧 Bash/)).toBeInTheDocument();
    expect(screen.getByText("工具调用中…")).toBeInTheDocument();
  });

  it("supports click toggle raw detail in progress state", () => {
    const longRaw = "curl -sG https://example.com/api/with/a/very/long/path/and/query?x=1&y=2";
    const toolWithLongDetail = toolMsg("t-long", `🔧 **工具 #9: Bash**\n---\n\`\`\`bash\n${longRaw}\n\`\`\``);
    render(<ActivityBlock messages={[toolWithLongDetail]} done={false} />);

    expect(screen.getByText("▸")).toBeInTheDocument();
    const detailPre = screen.getByText(longRaw);
    expect(detailPre.className).toContain("hidden");

    fireEvent.click(screen.getByText("▸"));
    expect(screen.getByText("▾")).toBeInTheDocument();
    expect(detailPre.className).toContain("block");

    fireEvent.click(detailPre);
    expect(detailPre.className).toContain("block");
  });

  it("renders collapsed done state by default", () => {
    render(<ActivityBlock messages={TOOL_MSGS} done={true} />);

    expect(screen.getByText(/已执行 4 个操作/)).toBeInTheDocument();
    expect(screen.queryByText(/🔧 Read/)).not.toBeInTheDocument();
  });

  it("expands on click to show full details", () => {
    render(<ActivityBlock messages={TOOL_MSGS} done={true} />);

    fireEvent.click(screen.getByText(/已执行 4 个操作/));

    expect(screen.getByText(/🔧 Read/)).toBeInTheDocument();
    expect(screen.getByText(/🔧 Bash/)).toBeInTheDocument();
    expect(screen.getAllByText(/💭 思考/)).toHaveLength(2);
    expect(screen.getByText(/\/path\/to\/skill\.md/)).toBeInTheDocument();
    expect(screen.getByText(/curl -sG/)).toBeInTheDocument();
    expect(screen.getByText(/Analyzing request/)).toBeInTheDocument();
  });

  it("collapses again on second click", () => {
    render(<ActivityBlock messages={TOOL_MSGS} done={true} />);

    fireEvent.click(screen.getByText(/已执行 4 个操作/));
    expect(screen.getByText(/🔧 Read/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/已执行 4 个操作/));
    expect(screen.queryByText(/🔧 Read/)).not.toBeInTheDocument();
  });

  it("supports click toggle for long raw detail", () => {
    const longRaw = "curl -sG https://example.com/api/with/a/very/long/path/and/query?x=1&y=2";
    const toolWithLongDetail = toolMsg("t-long", `🔧 **工具 #9: Bash**\n---\n\`\`\`bash\n${longRaw}\n\`\`\``);
    render(<ActivityBlock messages={[toolWithLongDetail]} done={true} />);

    fireEvent.click(screen.getByText(/已执行 1 个操作/));
    expect(screen.getByText("▸")).toBeInTheDocument();
    const detailPre = screen.getByText(longRaw);
    expect(detailPre.className).toContain("hidden");

    fireEvent.click(screen.getByText("▸"));
    expect(screen.getByText("▾")).toBeInTheDocument();
    expect(detailPre.className).toContain("block");

    fireEvent.click(screen.getByText("▾"));
    expect(detailPre.className).toContain("hidden");
  });

  it("keeps detail expanded when clicking on raw content", () => {
    const longRaw = "curl -sG https://example.com/api/with/a/very/long/path/and/query?x=1&y=2";
    const toolWithLongDetail = toolMsg("t-long", `🔧 **工具 #9: Bash**\n---\n\`\`\`bash\n${longRaw}\n\`\`\``);
    render(<ActivityBlock messages={[toolWithLongDetail]} done={true} />);

    fireEvent.click(screen.getByText(/已执行 1 个操作/));
    fireEvent.click(screen.getByText("▸"));

    const detailPre = screen.getByText(longRaw);
    expect(detailPre.className).toContain("block");

    fireEvent.click(detailPre);
    expect(detailPre.className).toContain("block");
  });

  it("shows single item without count text in progress", () => {
    render(<ActivityBlock messages={[TOOL_MSGS[0]]} done={false} />);
    expect(screen.getByText("工具调用中…")).toBeInTheDocument();
  });
});
