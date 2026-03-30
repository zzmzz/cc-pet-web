import { describe, it, expect } from "vitest";
import { parseBridgeMessage } from "../src/bridge/protocol.js";

describe("parseBridgeMessage", () => {
  it("should parse reply message", () => {
    const raw = JSON.stringify({ type: "reply", session_key: "s1", content: "hello" });
    const msg = parseBridgeMessage(raw);
    expect(msg).toEqual({ type: "reply", session_key: "s1", content: "hello" });
  });

  it("should parse stream message", () => {
    const raw = JSON.stringify({ type: "reply_stream", session_key: "s1", content: "chunk", done: false });
    const msg = parseBridgeMessage(raw);
    expect(msg).toEqual({ type: "reply_stream", session_key: "s1", content: "chunk", done: false });
  });

  it("should parse buttons message", () => {
    const raw = JSON.stringify({ type: "buttons", session_key: "s1", content: "pick one", buttons: [{ id: "1", label: "Yes" }] });
    const msg = parseBridgeMessage(raw);
    expect(msg.type).toBe("buttons");
  });

  it("should return error for invalid JSON", () => {
    const msg = parseBridgeMessage("not json");
    expect(msg.type).toBe("error");
  });
});
