import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatMessage } from "@cc-pet/shared";
import { hydrateSessionsAndHistory } from "./hydrateFromServer.js";
import type { PlatformAPI } from "./platform.js";
import { useMessageStore } from "./store/message.js";
import { useSessionStore } from "./store/session.js";

const CHAT_KEY = "c1::default";

function makeAdapter(messages: ChatMessage[]): PlatformAPI {
  return {
    connectWs: () => {},
    disconnectWs: () => {},
    onWsEvent: () => () => {},
    sendWsMessage: () => "",
    flushOutbox: () => {},
    fetchApi: vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions")) {
        return {
          sessions: [{ key: "default", connectionId: "c1", createdAt: 1, lastActiveAt: 2 }],
        };
      }
      if (path.startsWith("/api/history/")) return { messages };
      throw new Error(`unexpected path ${path}`);
    }) as PlatformAPI["fetchApi"],
    fetchApiRaw: vi.fn() as unknown as PlatformAPI["fetchApiRaw"],
  };
}

describe("hydrateSessionsAndHistory", () => {
  beforeEach(() => {
    localStorage.clear();
    useMessageStore.setState({
      messagesByChat: {},
      watermarks: {},
      loadedChatKeys: new Set<string>(),
      streamingContent: {},
    });
    useSessionStore.setState({ sessions: {}, activeSessionKey: {} });
  });

  it("seeds the watermark from the highest seq in the full history fetch", async () => {
    const adapter = makeAdapter([
      { id: "a", seq: 4, role: "user", content: "hi", timestamp: 1000 },
      { id: "b", seq: 9, role: "assistant", content: "yo", timestamp: 2000 },
    ]);

    await hydrateSessionsAndHistory(adapter, ["c1"]);

    // Without this the first onopen re-pages the whole conversation from seq 0.
    expect(useMessageStore.getState().getWatermark(CHAT_KEY)).toBe(9);
  });

  it("keeps a locally-rendered pending message when the fetch resolves later", async () => {
    const pending: ChatMessage = {
      id: "client-uuid-pending",
      role: "user",
      content: "typed while loading",
      timestamp: 5000,
    };
    useMessageStore.getState().addMessage(CHAT_KEY, pending);

    const adapter = makeAdapter([
      { id: "a", seq: 4, role: "user", content: "hi", timestamp: 1000 },
    ]);
    await hydrateSessionsAndHistory(adapter, ["c1"]);

    const ids = (useMessageStore.getState().messagesByChat[CHAT_KEY] ?? []).map((m) => m.id);
    expect(ids).toContain("client-uuid-pending");
    expect(ids).toContain("a");
  });

  it("leaves the watermark at 0 for an empty history", async () => {
    const adapter = makeAdapter([]);
    await hydrateSessionsAndHistory(adapter, ["c1"]);
    expect(useMessageStore.getState().getWatermark(CHAT_KEY)).toBe(0);
  });
});
