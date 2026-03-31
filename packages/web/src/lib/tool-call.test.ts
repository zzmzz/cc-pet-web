import { describe, expect, it } from "vitest";
import { isToolCallContent, getToolCallLabel, getToolCallDetail, getToolCallFullDetail } from "./tool-call.js";

describe("isToolCallContent", () => {
  it("detects wrench emoji tool call", () => {
    expect(isToolCallContent('🔧 **工具 #1: Bash**\n---\ncurl ...')).toBe(true);
  });

  it("detects thought bubble thinking message", () => {
    expect(isToolCallContent('💭\nThe user wants...')).toBe(true);
  });

  it("detects with leading whitespace", () => {
    expect(isToolCallContent('  🔧 **工具 #2: Read**')).toBe(true);
    expect(isToolCallContent(' 💭 \nthinking...')).toBe(true);
  });

  it("rejects normal assistant messages", () => {
    expect(isToolCallContent('短链已生成：https://ziiimo.cn/u/3849')).toBe(false);
    expect(isToolCallContent('你好！有什么需要帮忙的吗？')).toBe(false);
    expect(isToolCallContent('')).toBe(false);
  });

  it("rejects messages that mention tools in the middle", () => {
    expect(isToolCallContent('我使用了 🔧 工具')).toBe(false);
  });
});

describe("getToolCallLabel", () => {
  it("extracts tool name from wrench message", () => {
    expect(getToolCallLabel('🔧 **工具 #1: Bash**\n---\ncurl ...')).toBe("🔧 Bash");
  });

  it("extracts tool name with higher number", () => {
    expect(getToolCallLabel('🔧 **工具 #12: Read**\n---\n/path')).toBe("🔧 Read");
  });

  it("returns thinking label for thought bubble", () => {
    expect(getToolCallLabel('💭\nThe user wants...')).toBe("💭 思考");
    expect(getToolCallLabel('💭 \nreasoning...')).toBe("💭 思考");
  });

  it("returns fallback for unrecognized tool format", () => {
    expect(getToolCallLabel('🔧 something else')).toBe("🔧 工具调用");
  });
});

describe("getToolCallDetail", () => {
  it("extracts first line after --- separator for tool calls", () => {
    expect(getToolCallDetail('🔧 **工具 #1: Read**\n---\n`/home/hy/skills/shorten-url/SKILL.md`'))
      .toBe("/home/hy/skills/shorten-url/SKILL.md");
  });

  it("extracts command from bash code block", () => {
    const detail = getToolCallDetail('🔧 **工具 #1: Bash**\n---\n```bash\ncurl -sG "https://ziiimo.cn/api/v2/action/shorten"\n```');
    expect(detail).toMatch(/^curl -sG/);
    expect(detail.length).toBeLessThanOrEqual(41);
  });

  it("truncates long details to 40 chars", () => {
    const inner =
      "/very/long/path/that/exceeds/forty/characters/and/should/be/truncated.md";
    const expectedPrefix = inner.slice(0, 40);
    const long = `🔧 **工具 #1: Read**\n---\n\`${inner}\``;
    const result = getToolCallDetail(long);
    expect(result).toBe(`${expectedPrefix}…`);
    expect(result.startsWith(expectedPrefix)).toBe(true);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBe(41);
  });

  it("returns empty string when tool message has no --- separator", () => {
    expect(getToolCallDetail("🔧 **工具 #1: Read**\nbody without separator block")).toBe("");
  });

  it("returns empty string for thinking messages", () => {
    expect(getToolCallDetail('💭\nThe user wants...')).toBe("");
  });
});

describe("getToolCallFullDetail", () => {
  it("returns full path without truncation", () => {
    const path = "/very/long/path/that/exceeds/forty/characters/and/should/not/be/truncated.md";
    expect(getToolCallFullDetail(`🔧 **工具 #1: Read**\n---\n\`${path}\``)).toBe(path);
  });

  it("returns full command from bash code block", () => {
    const cmd = 'curl -sG "https://ziiimo.cn/api/v2/action/shorten" --data-urlencode "key=abc123"';
    expect(getToolCallFullDetail(`🔧 **工具 #1: Bash**\n---\n\`\`\`bash\n${cmd}\n\`\`\``)).toBe(cmd);
  });

  it("returns multiline code block content", () => {
    const content = '🔧 **工具 #1: Bash**\n---\n```bash\nline1\nline2\nline3\n```';
    expect(getToolCallFullDetail(content)).toBe("line1\nline2\nline3");
  });

  it("returns thinking text for thought bubble", () => {
    expect(getToolCallFullDetail("💭\nThe user wants a short link for a GitHub URL.")).toBe(
      "The user wants a short link for a GitHub URL.",
    );
  });

  it("returns empty string for thinking without text", () => {
    expect(getToolCallFullDetail("💭")).toBe("");
  });

  it("returns empty string when no --- separator", () => {
    expect(getToolCallFullDetail("🔧 **工具 #1: Read**\nno separator")).toBe("");
  });
});
