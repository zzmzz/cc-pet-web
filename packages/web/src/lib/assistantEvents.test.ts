import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeChatKey, type Session } from "@cc-pet/shared";
import {
  createAssistantUpdateBatcher,
  emitAssistantSessionUpdated,
  onAssistantSessionUpdated,
  refreshAssistantSession,
} from "./assistantEvents.js";
import { useMessageStore } from "./store/message.js";
import { useSessionStore } from "./store/session.js";

const session = (key: string, over: Partial<Session> = {}): Session => ({
  key, connectionId: "c1", createdAt: 1, lastActiveAt: 1, ...over,
});

beforeEach(() => {
  useSessionStore.setState({ sessions: {}, activeSessionKey: {}, unread: {} });
  useMessageStore.setState({ messagesByChat: {}, loadedChatKeys: new Set(), watermarks: {} });
});

describe("assistant session events", () => {
  it("delivers emitted events to every listener until it unsubscribes", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onAssistantSessionUpdated(a);
    const offB = onAssistantSessionUpdated(b);
    emitAssistantSessionUpdated({ connectionId: "c1", sessionKey: "item-1" });
    offA();
    emitAssistantSessionUpdated({ connectionId: "c1", sessionKey: "item-2" });
    offB();
    emitAssistantSessionUpdated({ connectionId: "c1", sessionKey: "item-3" });
    expect(a.mock.calls).toEqual([[{ connectionId: "c1", sessionKey: "item-1" }]]);
    expect(b.mock.calls.map((c) => c[0].sessionKey)).toEqual(["item-1", "item-2"]);
  });

  it("keeps calling the other listeners when one throws", () => {
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    const off1 = onAssistantSessionUpdated(bad);
    const off2 = onAssistantSessionUpdated(good);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitAssistantSessionUpdated({ connectionId: "c1", sessionKey: "item-1" });
    off1();
    off2();
    warn.mockRestore();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("createAssistantUpdateBatcher", () => {
  it("flushes once per connection after the burst, with every key seen", () => {
    vi.useFakeTimers();
    try {
      const flush = vi.fn();
      const b = createAssistantUpdateBatcher(flush, 300);
      b.push({ connectionId: "c1", sessionKey: "item-1" });
      vi.advanceTimersByTime(200);
      b.push({ connectionId: "c1", sessionKey: "item-2" });
      b.push({ connectionId: "c2", sessionKey: "item-7" });
      b.push({ connectionId: "c1", sessionKey: "item-1" });
      vi.advanceTimersByTime(299);
      expect(flush).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(flush).toHaveBeenCalledTimes(2);
      expect(flush).toHaveBeenCalledWith("c1", ["item-1", "item-2"]);
      expect(flush).toHaveBeenCalledWith("c2", ["item-7"]);
      b.push({ connectionId: "c1", sessionKey: "item-3" });
      vi.advanceTimersByTime(300);
      expect(flush).toHaveBeenLastCalledWith("c1", ["item-3"]);
      expect(flush).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops pending updates on cancel", () => {
    vi.useFakeTimers();
    try {
      const flush = vi.fn();
      const b = createAssistantUpdateBatcher(flush, 300);
      b.push({ connectionId: "c1", sessionKey: "item-1" });
      b.cancel();
      vi.advanceTimersByTime(1000);
      expect(flush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("refreshAssistantSession", () => {
  it("keeps a just-created local session the server list does not have yet", async () => {
    const now = Date.now();
    useSessionStore.getState().setSessions("c1", [
      session("session-new", { createdAt: now, lastActiveAt: now }),
      session("gone-long-ago", { createdAt: now - 10 * 60_000, lastActiveAt: now - 10 * 60_000 }),
    ]);
    const fetchApi = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions?")) return { sessions: [session("item-1", { lastActiveAt: 5 })] };
      throw new Error(`unexpected ${path}`);
    });
    await refreshAssistantSession({ fetchApi }, "c1", ["item-1"]);
    expect(useSessionStore.getState().sessions.c1.map((s) => s.key)).toEqual(["session-new", "item-1"]);
  });

  it("pulls new messages for every loaded chat in the batch", async () => {
    const a = makeChatKey("c1", "item-1");
    const b = makeChatKey("c1", "item-2");
    for (const ck of [a, b]) {
      useMessageStore.getState().mergeMessages(ck, [{ id: `${ck}-1`, role: "user", content: "旧", timestamp: 1, seq: 1 }]);
      useMessageStore.getState().markChatLoaded(ck);
    }
    const fetchApi = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions?")) return { sessions: [] };
      for (const ck of [a, b]) {
        if (path.startsWith(`/api/history/${encodeURIComponent(ck)}?afterSeq=1`)) {
          return { messages: [{ id: `${ck}-2`, role: "user", content: "新", timestamp: 2, seq: 2 }], hasMore: false };
        }
      }
      throw new Error(`unexpected ${path}`);
    });
    await refreshAssistantSession({ fetchApi }, "c1", ["item-1", "item-2"]);
    expect(useMessageStore.getState().getWatermark(a)).toBe(2);
    expect(useMessageStore.getState().getWatermark(b)).toBe(2);
  });

  it("reloads the session list and pulls new messages for a loaded chat", async () => {
    const ck = makeChatKey("c1", "item-1");
    useMessageStore.getState().mergeMessages(ck, [
      { id: "m1", role: "user", content: "旧消息", timestamp: 1, seq: 4 },
    ]);
    useMessageStore.getState().markChatLoaded(ck);
    const fetchApi = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions?")) return { sessions: [session("item-1", { label: "示例" }), session("res", { isResident: true })] };
      if (path.startsWith(`/api/history/${encodeURIComponent(ck)}?afterSeq=4`)) {
        return { messages: [{ id: "m2", role: "user", content: "（自动）新消息", timestamp: 2, seq: 5 }], hasMore: false };
      }
      throw new Error(`unexpected ${path}`);
    });

    await refreshAssistantSession({ fetchApi }, "c1", ["item-1"]);

    expect(fetchApi).toHaveBeenCalledWith("/api/sessions?connectionId=c1");
    expect(useSessionStore.getState().sessions.c1.map((s) => s.key)).toEqual(["item-1", "res"]);
    expect(useMessageStore.getState().messagesByChat[ck].map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(useMessageStore.getState().getWatermark(ck)).toBe(5);
  });

  it("leaves a chat that was never opened to load when it is opened", async () => {
    const fetchApi = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions?")) return { sessions: [session("item-9")] };
      throw new Error(`unexpected ${path}`);
    });
    await refreshAssistantSession({ fetchApi }, "c1", ["item-9"]);
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(useMessageStore.getState().messagesByChat[makeChatKey("c1", "item-9")]).toBeUndefined();
  });

  it("keeps the old list when the session request fails", async () => {
    useSessionStore.getState().setSessions("c1", [session("keep")]);
    const fetchApi = vi.fn(async () => { throw new Error("offline"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await refreshAssistantSession({ fetchApi }, "c1", ["item-1"]);
    warn.mockRestore();
    expect(useSessionStore.getState().sessions.c1.map((s) => s.key)).toEqual(["keep"]);
  });
});
