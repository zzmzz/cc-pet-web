import { describe, it, expect } from "vitest";
import type { ChatCard } from "@cc-pet/shared";
import { detectAskQuestion } from "./AskQuestionCard.js";

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
