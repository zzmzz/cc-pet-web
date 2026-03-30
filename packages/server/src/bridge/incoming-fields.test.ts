import { describe, it, expect } from "vitest";
import {
  bridgeReplyCtx,
  bridgeReplyTextContent,
  registerAckOk,
  extractReplyStreamFullText,
  extractReplyStreamChunk,
} from "./incoming-fields.js";
import { SKILLS_PROBE_REPLY_CTX } from "@cc-pet/shared";

describe("incoming-fields", () => {
  it("bridgeReplyCtx reads data.reply_ctx like cc-pet", () => {
    expect(
      bridgeReplyCtx({
        type: "reply",
        data: { reply_ctx: SKILLS_PROBE_REPLY_CTX, content: "/x — y" },
      }),
    ).toBe(SKILLS_PROBE_REPLY_CTX);
  });

  it("bridgeReplyTextContent reads data.content", () => {
    expect(
      bridgeReplyTextContent({
        type: "reply",
        data: { content: "/a — b", reply_ctx: SKILLS_PROBE_REPLY_CTX },
      }),
    ).toBe("/a — b");
  });

  it("registerAckOk accepts data.ok", () => {
    expect(registerAckOk({ type: "register_ack", data: { ok: true } })).toBe(true);
    expect(registerAckOk({ type: "register_ack", ok: true })).toBe(true);
    expect(registerAckOk({ type: "register_ack" })).toBe(false);
  });

  it("extractReplyStreamFullText reads nested data", () => {
    expect(
      extractReplyStreamFullText({
        type: "reply_stream",
        done: true,
        data: { full_text: "/s — d" },
      }),
    ).toBe("/s — d");
  });

  it("extractReplyStreamChunk reads data.delta", () => {
    expect(
      extractReplyStreamChunk({
        type: "reply_stream",
        data: { delta: "hi" },
      }),
    ).toBe("hi");
  });
});
