import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatCard } from "@cc-pet/shared";
import { AskQuestionCard, detectAskQuestion } from "./AskQuestionCard.js";
import { CardMessage } from "./CardMessage.js";
import { getPlatform } from "../lib/platform.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { useMessageStore } from "../lib/store/message.js";
import { useSessionStore } from "../lib/store/session.js";

vi.mock("../lib/platform.js", () => ({
  getPlatform: vi.fn(),
}));

const CHAT_KEY = "c1::s1";
const CLIENT_MSG_ID = "client-msg-id-1";

/**
 * The manual retry tier only means something if the send produces a bubble:
 * MessageList looks the outbox entry up by message.id, so a send whose
 * clientMsgId is discarded can never render pending/failed, and the user never
 * gets a retry button. These tests pin the local echo at both manual send sites.
 */
describe("manual-tier local echo", () => {
  let sendWsMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    sendWsMessage = vi.fn().mockReturnValue(CLIENT_MSG_ID);
    vi.mocked(getPlatform).mockReturnValue({ sendWsMessage } as never);
    useMessageStore.setState({ messagesByChat: {} });
    useConnectionStore.setState({ activeConnectionId: "c1" });
    useSessionStore.setState({ activeSessionKey: { c1: "s1" } });
  });

  function echoed() {
    return useMessageStore.getState().messagesByChat[CHAT_KEY] ?? [];
  }

  describe("AskQuestionCard", () => {
    const card: ChatCard = {
      elements: [
        { type: "markdown", content: "**pick one**" },
        { type: "list_item", text: "面条", btnText: "面条", btnValue: "askq:0:1" },
      ],
    };

    it("adds a local user message keyed by the returned clientMsgId", () => {
      render(<AskQuestionCard data={detectAskQuestion(card)!} />);

      fireEvent.click(screen.getByRole("button", { name: "面条" }));

      expect(sendWsMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: "askq:0:1" }),
        "manual",
      );
      expect(echoed()).toHaveLength(1);
      expect(echoed()[0]).toMatchObject({
        id: CLIENT_MSG_ID,
        role: "user",
        content: "askq:0:1",
        connectionId: "c1",
        sessionKey: "s1",
      });
    });

    it("echoes the joined indices for a multi-select submit", () => {
      const multi: ChatCard = {
        elements: [
          { type: "markdown", content: "**pick**（可多选，用逗号分隔）" },
          { type: "list_item", text: "A", btnText: "A", btnValue: "askq:0:1" },
          { type: "list_item", text: "B", btnText: "B", btnValue: "askq:0:2" },
        ],
      };
      render(<AskQuestionCard data={detectAskQuestion(multi)!} />);

      fireEvent.click(screen.getByRole("button", { name: /A/ }));
      fireEvent.click(screen.getByRole("button", { name: /B/ }));
      fireEvent.click(screen.getByRole("button", { name: "提交" }));

      expect(echoed()).toHaveLength(1);
      expect(echoed()[0]).toMatchObject({ id: CLIENT_MSG_ID, content: "1,2" });
    });

    it("does not echo when the send was refused", () => {
      sendWsMessage.mockReturnValue("");
      render(<AskQuestionCard data={detectAskQuestion(card)!} />);

      fireEvent.click(screen.getByRole("button", { name: "面条" }));

      expect(echoed()).toHaveLength(0);
    });
  });

  describe("CardMessage", () => {
    it("adds a local user message keyed by the returned clientMsgId", () => {
      const card: ChatCard = {
        elements: [
          {
            type: "actions",
            buttons: [{ text: "继续", value: "continue" }],
          },
        ],
      };
      render(<CardMessage card={card} />);

      fireEvent.click(screen.getByRole("button", { name: "继续" }));

      expect(sendWsMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: "continue" }),
        "manual",
      );
      expect(echoed()).toHaveLength(1);
      expect(echoed()[0]).toMatchObject({ id: CLIENT_MSG_ID, role: "user", content: "continue" });
    });

    it("echoes the stripped content for a cmd: button", () => {
      const card: ChatCard = {
        elements: [
          {
            type: "actions",
            buttons: [{ text: "重试", value: "cmd:/retry" }],
          },
        ],
      };
      render(<CardMessage card={card} />);

      fireEvent.click(screen.getByRole("button", { name: "重试" }));

      expect(echoed()).toHaveLength(1);
      expect(echoed()[0]).toMatchObject({ id: CLIENT_MSG_ID, content: "/retry" });
    });
  });
});
