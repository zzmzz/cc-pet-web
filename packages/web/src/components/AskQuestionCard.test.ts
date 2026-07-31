import { describe, it, expect } from "vitest";
import type { ChatCard } from "@cc-pet/shared";
import { detectAskQuestion, parseAnswerIndices } from "./AskQuestionCard.js";

describe("detectAskQuestion", () => {
  it("returns null for cards without askq list_items", () => {
    const card: ChatCard = {
      elements: [{ type: "markdown", content: "hello" }],
    };
    expect(detectAskQuestion(card)).toBeNull();
  });

  it("extracts options and description from list_items", () => {
    const card: ChatCard = {
      header: { title: "Agent 提问", color: "blue" },
      elements: [
        { type: "markdown", content: "**今天午饭？**" },
        {
          type: "list_item",
          text: "面条 — 汤面、烩面",
          btnText: "面条",
          btnType: "default",
          btnValue: "askq:0:1",
        },
        {
          type: "list_item",
          text: "米饭 — 盖浇饭",
          btnText: "米饭",
          btnType: "default",
          btnValue: "askq:0:2",
        },
        { type: "note", text: "可直接输入" },
      ],
    };
    const data = detectAskQuestion(card);
    expect(data).not.toBeNull();
    expect(data!.multiSelect).toBe(false);
    expect(data!.note).toBe("可直接输入");
    expect(data!.options).toEqual([
      { index: 1, label: "面条", description: "汤面、烩面", value: "askq:0:1" },
      { index: 2, label: "米饭", description: "盖浇饭", value: "askq:0:2" },
    ]);
  });

  it("detects multi-select hint in zh markdown", () => {
    const card: ChatCard = {
      elements: [
        { type: "markdown", content: "**选项**（可多选，用逗号分隔）" },
        { type: "list_item", text: "A", btnText: "A", btnValue: "askq:0:1" },
      ],
    };
    expect(detectAskQuestion(card)!.multiSelect).toBe(true);
  });

  it("detects multi-select hint in english markdown", () => {
    const card: ChatCard = {
      elements: [
        { type: "markdown", content: "**Pick** (multiple selections allowed, separate with commas)" },
        { type: "list_item", text: "A", btnText: "A", btnValue: "askq:0:1" },
      ],
    };
    expect(detectAskQuestion(card)!.multiSelect).toBe(true);
  });

  it("parses multi-select options from the markdown list when the card has no buttons", () => {
    // cc-connect renders multi-select questions as a numbered markdown list with
    // no list_item buttons (a button click can only carry one answer).
    const card: ChatCard = {
      header: { title: "Agent 提问 (2/2)", color: "blue" },
      elements: [
        {
          type: "markdown",
          content:
            "**产出的 HTML 有什么关键要求？**（可多选，用逗号分隔）\n\n" +
            "1. **单文件自包含** — CSS/JS 内联，一个 .html 发给别人就能打开\n" +
            "2. **要有目录/导航** — 侧边栏 TOC、章节锚点\n" +
            "3. **支持图表**\n",
        },
        { type: "note", text: "请回复逗号分隔的选项编号（如 1,3）或直接输入你的回答" },
      ],
    };
    const data = detectAskQuestion(card)!;
    expect(data).not.toBeNull();
    expect(data.multiSelect).toBe(true);
    expect(data.questionMarkdown).toBe("**产出的 HTML 有什么关键要求？**（可多选，用逗号分隔）");
    expect(data.options).toEqual([
      { index: 1, label: "单文件自包含", description: "CSS/JS 内联，一个 .html 发给别人就能打开", value: "" },
      { index: 2, label: "要有目录/导航", description: "侧边栏 TOC、章节锚点" as string, value: "" },
      { index: 3, label: "支持图表", description: "", value: "" },
    ]);
  });

  it("parses multi-select options from an english markdown list", () => {
    const card: ChatCard = {
      elements: [
        {
          type: "markdown",
          content:
            "**Pick features** (multiple selections allowed, separate with commas)\n\n" +
            "1. **Dark mode** — follows the system theme\n" +
            "2. **Offline cache**\n",
        },
      ],
    };
    const data = detectAskQuestion(card)!;
    expect(data.multiSelect).toBe(true);
    expect(data.options.map((o) => o.label)).toEqual(["Dark mode", "Offline cache"]);
  });

  it("returns null for a plain markdown card that only looks like a list", () => {
    const card: ChatCard = {
      elements: [{ type: "markdown", content: "步骤：\n1. **先做这个**\n2. **再做那个**" }],
    };
    expect(detectAskQuestion(card)).toBeNull();
  });

  it("handles list_item where text equals label (no description)", () => {
    const card: ChatCard = {
      elements: [
        { type: "list_item", text: "Yes", btnText: "Yes", btnValue: "askq:0:1" },
      ],
    };
    const data = detectAskQuestion(card)!;
    expect(data.options[0]).toEqual({ index: 1, label: "Yes", description: "", value: "askq:0:1" });
  });
});

describe("parseAnswerIndices", () => {
  it("reads the option index out of a single-select button answer", () => {
    expect(parseAnswerIndices("askq:0:2", 3)).toEqual([2]);
    expect(parseAnswerIndices("askq:1:3", 3)).toEqual([3]);
  });

  it("reads comma separated numbers, incl. fullwidth comma", () => {
    expect(parseAnswerIndices("1,3", 4)).toEqual([1, 3]);
    expect(parseAnswerIndices("2， 4", 4)).toEqual([2, 4]);
  });

  it("ignores out-of-range and non-numeric answers", () => {
    expect(parseAnswerIndices("7", 3)).toEqual([]);
    expect(parseAnswerIndices("其实我想自己写一个", 3)).toEqual([]);
    expect(parseAnswerIndices("askq:0:9", 3)).toEqual([]);
  });
});
