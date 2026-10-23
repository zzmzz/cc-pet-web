import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeChatKey, type Session } from "@cc-pet/shared";
import {
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

describe("refreshAssistantSession", () => {
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

    await refreshAssistantSession({ fetchApi }, "c1", "item-1");

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
    await refreshAssistantSession({ fetchApi }, "c1", "item-9");
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(useMessageStore.getState().messagesByChat[makeChatKey("c1", "item-9")]).toBeUndefined();
  });

  it("keeps the old list when the session request fails", async () => {
    useSessionStore.getState().setSessions("c1", [session("keep")]);
    const fetchApi = vi.fn(async () => { throw new Error("offline"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await refreshAssistantSession({ fetchApi }, "c1", "item-1");
    warn.mockRestore();
    expect(useSessionStore.getState().sessions.c1.map((s) => s.key)).toEqual(["keep"]);
  });
});
