import { describe, it, expect } from "vitest";
import { sanitizeForTts } from "./tts-sanitizer.js";

describe("sanitizeForTts", () => {
  it("removes fenced code blocks", () => {
    const input = "结果如下：\n```js\nconsole.log('hi');\n```\n完成了";
    expect(sanitizeForTts(input)).toBe("结果如下：\n代码已省略\n完成了");
  });

  it("removes inline code backticks", () => {
    expect(sanitizeForTts("使用 `npm install` 安装")).toBe("使用 npm install 安装");
  });

  it("removes markdown heading symbols", () => {
    expect(sanitizeForTts("## 标题内容")).toBe("标题内容");
  });

  it("removes bold/italic markers", () => {
    expect(sanitizeForTts("这是**加粗**和*斜体*")).toBe("这是加粗和斜体");
  });

  it("removes blockquote markers", () => {
    expect(sanitizeForTts("> 引用文本")).toBe("引用文本");
  });

  it("replaces URLs with placeholder", () => {
    expect(sanitizeForTts("访问 https://example.com/path?q=1 查看"))
      .toBe("访问 链接已省略 查看");
  });

  it("removes unordered list markers", () => {
    expect(sanitizeForTts("- 第一项\n- 第二项")).toBe("第一项\n第二项");
  });

  it("removes ordered list markers", () => {
    expect(sanitizeForTts("1. 第一项\n2. 第二项")).toBe("第一项\n第二项");
  });

  it("truncates text over 300 chars", () => {
    const long = "啊".repeat(350);
    const result = sanitizeForTts(long);
    expect(result.length).toBeLessThan(350);
    expect(result).toContain("详细内容可在聊天记录中查看");
  });

  it("returns short text as-is (no truncation)", () => {
    expect(sanitizeForTts("你好")).toBe("你好");
  });

  it("handles combined markdown", () => {
    const input = "## 结果\n\n**成功**完成了 `task`。\n\n```python\nprint('done')\n```\n\n访问 https://example.com";
    const result = sanitizeForTts(input);
    expect(result).not.toContain("```");
    expect(result).not.toContain("**");
    expect(result).not.toContain("`");
    expect(result).not.toContain("##");
    expect(result).not.toContain("https://");
    expect(result).toContain("代码已省略");
    expect(result).toContain("链接已省略");
  });

  it("collapses multiple blank lines", () => {
    expect(sanitizeForTts("第一段\n\n\n\n第二段")).toBe("第一段\n\n第二段");
  });

  it("trims leading/trailing whitespace", () => {
    expect(sanitizeForTts("  你好  ")).toBe("你好");
  });
});
