import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@cc-pet/shared";
import { buildAskAnswerMap } from "./ask-answers.js";

const askCard = (id: string, timestamp: number): ChatMessage => ({
  id,
  role: "assistant",
  content: "Agent 提问",
  timestamp,
  card: {
    header: { title: "Agent 提问", color: "blue" },
    elements: [
      { type: "markdown", content: "**选一个**" },
      { type: "list_item", text: "A", btnText: "A", btnValue: "askq:0:1" },
      { type: "list_item", text: "B", btnText: "B", btnValue: "askq:0:2" },
    ],
  },
});

describe("buildAskAnswerMap", () => {
  it("maps each ask card to the first user message that follows it", () => {
    const messages: ChatMessage[] = [
      { id: "u0", role: "user", content: "帮我看看", timestamp: 1 },
      askCard("c1", 2),
      { id: "u1", role: "user", content: "askq:0:2", timestamp: 3 },
      { id: "a1", role: "assistant", content: "好的", timestamp: 4 },
      askCard("c2", 5),
      { id: "u2", role: "user", content: "1,2", timestamp: 6 },
    ];
    const map = buildAskAnswerMap(messages);
    expect(map.get("c1")).toBe("askq:0:2");
    expect(map.get("c2")).toBe("1,2");
  });

  it("leaves a still-pending card unanswered", () => {
    const messages: ChatMessage[] = [
      { id: "u0", role: "user", content: "早于卡片的回复", timestamp: 1 },
      askCard("c1", 2),
      { id: "a1", role: "assistant", content: "正在处理", timestamp: 3 },
    ];
    const map = buildAskAnswerMap(messages);
    expect(map.has("c1")).toBe(false);
  });

  it("ignores non-ask cards", () => {
    const messages: ChatMessage[] = [
      {
        id: "c0",
        role: "assistant",
        content: "权限",
        timestamp: 1,
        card: { elements: [{ type: "markdown", content: "hello" }] },
      },
      { id: "u1", role: "user", content: "allow", timestamp: 2 },
    ];
    expect(buildAskAnswerMap(messages).size).toBe(0);
  });
});
