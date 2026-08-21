import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatCard } from "@cc-pet/shared";
import { AskQuestionCard, detectAskQuestion } from "./AskQuestionCard.js";
import { setPlatform, type PlatformAPI } from "../lib/platform.js";
import { useConnectionStore } from "../lib/store/connection.js";

const sent: any[] = [];

const fakePlatform = {
  connectWs() {},
  disconnectWs() {},
  onWsEvent: () => () => {},
  sendWsMessage: (msg: any) => sent.push(msg),
  getWsBufferedAmount: () => 0,
  fetchApi: async () => ({}) as any,
  fetchApiRaw: async () => new Response(),
} as unknown as PlatformAPI;

const multiCard: ChatCard = {
  header: { title: "Agent 提问", color: "blue" },
  elements: [
    {
      type: "markdown",
      content:
        "**要哪些功能？**（可多选，用逗号分隔）\n\n" +
        "1. **深色模式** — 跟随系统\n" +
        "2. **离线缓存**\n" +
        "3. **快捷键**\n",
    },
  ],
};

const singleCard: ChatCard = {
  elements: [
    { type: "markdown", content: "**选一个**" },
    { type: "list_item", text: "A — 甲", btnText: "A", btnValue: "askq:0:1" },
    { type: "list_item", text: "B — 乙", btnText: "B", btnValue: "askq:0:2" },
  ],
};

describe("AskQuestionCard multi-select", () => {
  beforeEach(() => {
    cleanup();
    sent.length = 0;
    setPlatform(fakePlatform);
    useConnectionStore.setState({ activeConnectionId: "conn-1" } as any);
  });

  it("lets the user tick several options and submits comma separated indices", () => {
    render(<AskQuestionCard data={detectAskQuestion(multiCard)!} />);

    fireEvent.click(screen.getByText("深色模式"));
    fireEvent.click(screen.getByText("快捷键"));
    expect(screen.getByText(/已选 2 项/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe("1,3");
  });

  it("restores the answered state from a previous reply (survives reload)", () => {
    render(<AskQuestionCard data={detectAskQuestion(multiCard)!} answeredWith="2,3" />);

    expect(screen.getByText("已回答：离线缓存, 快捷键")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
    fireEvent.click(screen.getByText("深色模式"));
    expect(sent).toHaveLength(0);
  });

  it("shows a free-text answer verbatim", () => {
    render(<AskQuestionCard data={detectAskQuestion(multiCard)!} answeredWith="都要，另外加个导出" />);
    expect(screen.getByText("已回答：都要，另外加个导出")).toBeTruthy();
  });

  it("locks a single-select card that was already answered", () => {
    render(<AskQuestionCard data={detectAskQuestion(singleCard)!} answeredWith="askq:0:2" />);

    fireEvent.click(screen.getByText("A"));
    expect(sent).toHaveLength(0);
    expect(screen.getByText(/已回答/)).toBeTruthy();
  });
});
