import { describe, it, expect, beforeEach } from "vitest";
import { makeChatKey } from "@cc-pet/shared";
import { useSessionStore } from "./session.js";

describe("session store resident unread", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: {}, unread: {} } as never);
  });

  it("incrementUnread is a no-op for resident chat keys, setUnread is absolute", () => {
    const now = Date.now();
    useSessionStore.getState().setSessions("cc", [
      { key: "resident", connectionId: "cc", createdAt: now, lastActiveAt: now, isResident: true, unreadCount: 0 },
    ]);
    const ck = makeChatKey("cc", "resident");
    useSessionStore.getState().incrementUnread(ck);
    expect(useSessionStore.getState().unread[ck] ?? 0).toBe(0); // server drives
    useSessionStore.getState().setUnread(ck, 3);
    expect(useSessionStore.getState().unread[ck]).toBe(3);
  });

  it("incrementUnread still works for non-resident sessions", () => {
    const now = Date.now();
    useSessionStore.getState().setSessions("cc", [
      { key: "s1", connectionId: "cc", createdAt: now, lastActiveAt: now },
    ]);
    const ck = makeChatKey("cc", "s1");
    useSessionStore.getState().incrementUnread(ck);
    expect(useSessionStore.getState().unread[ck]).toBe(1);
  });
});
