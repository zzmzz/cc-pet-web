import { describe, expect, it } from "vitest";
import { resolveIncomingSessionKey, sessionFromReplyCtx } from "./sessionRouting.js";

describe("sessionFromReplyCtx", () => {
  it("returns null for missing or non-ccpet prefix", () => {
    expect(sessionFromReplyCtx(undefined)).toBeNull();
    expect(sessionFromReplyCtx("")).toBeNull();
    expect(sessionFromReplyCtx("other:foo:1")).toBeNull();
  });

  it("takes content before last colon after ccpet: prefix", () => {
    expect(sessionFromReplyCtx("ccpet:session-a:42")).toBe("session-a");
    expect(sessionFromReplyCtx("ccpet:a:b:c:tail")).toBe("a:b:c");
  });

  it("returns null when no colon after prefix or colon at start", () => {
    expect(sessionFromReplyCtx("ccpet:nocolon")).toBeNull();
    expect(sessionFromReplyCtx("ccpet::x")).toBeNull();
  });
});

describe("resolveIncomingSessionKey", () => {
  it("ignores blank payload sessionKey and continues fallback chain", () => {
    const resolved = resolveIncomingSessionKey({
      payloadSessionKey: "   ",
      replyCtx: undefined,
      knownSessions: ["first", "second"],
      activeSessionKey: "active",
    });
    expect(resolved).toBe("active");
  });

  it("prefers payload sessionKey over active session to avoid cross-session mixing", () => {
    const resolved = resolveIncomingSessionKey({
      payloadSessionKey: "session-other",
      replyCtx: undefined,
      knownSessions: ["session-current", "session-other"],
      activeSessionKey: "session-current",
    });
    expect(resolved).toBe("session-other");
  });

  it("extracts session key from ccpet reply context when payload session key is missing", () => {
    const resolved = resolveIncomingSessionKey({
      payloadSessionKey: undefined,
      replyCtx: "ccpet:session-a:42",
      knownSessions: ["session-a", "session-b"],
      activeSessionKey: "session-b",
    });
    expect(resolved).toBe("session-a");
  });

  it("falls back when replyCtx key is not in knownSessions", () => {
    const resolved = resolveIncomingSessionKey({
      payloadSessionKey: undefined,
      replyCtx: "ccpet:session-x:42",
      knownSessions: ["session-a", "session-b"],
      activeSessionKey: "session-b",
    });
    expect(resolved).toBe("session-b");
  });

  it("falls back to active session when no payload key and no valid reply context", () => {
    const resolved = resolveIncomingSessionKey({
      payloadSessionKey: undefined,
      replyCtx: "invalid",
      knownSessions: ["session-a", "session-b"],
      activeSessionKey: "session-b",
    });
    expect(resolved).toBe("session-b");
  });

  it("falls back to knownSessions[0] when payload, replyCtx, and active are unusable", () => {
    const resolved = resolveIncomingSessionKey({
      payloadSessionKey: undefined,
      replyCtx: undefined,
      knownSessions: ["first", "second"],
      activeSessionKey: undefined,
    });
    expect(resolved).toBe("first");
  });

  it("falls back to default when nothing else applies", () => {
    const resolved = resolveIncomingSessionKey({
      payloadSessionKey: undefined,
      replyCtx: undefined,
      knownSessions: [],
      activeSessionKey: undefined,
    });
    expect(resolved).toBe("default");
  });
});
