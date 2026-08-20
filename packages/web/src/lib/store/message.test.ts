import { describe, it, expect, beforeEach } from "vitest";
import { useMessageStore } from "./message";
import type { ChatMessage } from "@cc-pet/shared";

const msg = (id: string, seq: number): ChatMessage => ({
  id, seq, role: "assistant", content: id, timestamp: 1000 + seq,
});

describe("message store watermark and merge", () => {
  beforeEach(() => {
    useMessageStore.setState({ watermarks: {}, messagesByChat: {} });
  });

  it("tracks the highest seq seen per chatKey", () => {
    useMessageStore.getState().mergeMessages("c::s", [msg("a", 3), msg("b", 7)]);
    expect(useMessageStore.getState().getWatermark("c::s")).toBe(7);
  });

  it("never moves the watermark backwards", () => {
    useMessageStore.getState().setWatermark("c::s", 10);
    useMessageStore.getState().setWatermark("c::s", 4);
    expect(useMessageStore.getState().getWatermark("c::s")).toBe(10);
  });

  it("dedupes by id when a locally rendered message comes back from history", () => {
    const store = useMessageStore.getState();
    store.mergeMessages("c::s", [msg("client-uuid", 5)]);
    store.mergeMessages("c::s", [msg("client-uuid", 5)]);
    const list = useMessageStore.getState().messagesByChat["c::s"] ?? [];
    expect(list.filter((m) => m.id === "client-uuid")).toHaveLength(1);
  });

  it("orders merged messages chronologically", () => {
    useMessageStore.getState().mergeMessages("c::s", [msg("late", 9), msg("early", 2)]);
    const list = useMessageStore.getState().messagesByChat["c::s"] ?? [];
    expect(list.map((m) => m.id)).toEqual(["early", "late"]);
  });

  it("keeps seq-less local messages in chronological position", () => {
    useMessageStore.getState().mergeMessages("c::s", [
      { id: "srv-1", seq: 1, role: "assistant", content: "a", timestamp: 1000 },
      { id: "local-buttons", role: "assistant", content: "b", timestamp: 1500 },
      { id: "srv-2", seq: 2, role: "assistant", content: "c", timestamp: 2000 },
    ]);
    const list = useMessageStore.getState().messagesByChat["c::s"] ?? [];
    expect(list.map((m) => m.id)).toEqual(["srv-1", "local-buttons", "srv-2"]);
  });

  it("breaks same-timestamp ties by seq", () => {
    useMessageStore.getState().mergeMessages("c::s", [
      { id: "b", seq: 9, role: "assistant", content: "b", timestamp: 7000 },
      { id: "a", seq: 4, role: "assistant", content: "a", timestamp: 7000 },
    ]);
    const list = useMessageStore.getState().messagesByChat["c::s"] ?? [];
    expect(list.map((m) => m.id)).toEqual(["a", "b"]);
  });

  // A leftover watermark makes the reconnect backfill keep fetching a chat
  // that no longer exists, once per reconnect for the life of the page.
  it("drops the watermark when a chat is purged", () => {
    useMessageStore.getState().mergeMessages("c::gone", [msg("a", 5)]);
    useMessageStore.getState().mergeMessages("c::stay", [msg("b", 9)]);
    useMessageStore.getState().purgeChat("c::gone");
    expect(useMessageStore.getState().watermarks).not.toHaveProperty("c::gone");
    expect(useMessageStore.getState().getWatermark("c::stay")).toBe(9);
  });

  it("starts from watermark 0 for an unknown chatKey", () => {
    expect(useMessageStore.getState().getWatermark("never::seen")).toBe(0);
  });
});

describe("watermark advancement via live WS pushes", () => {
  beforeEach(() => {
    useMessageStore.setState({ watermarks: {}, messagesByChat: {} });
  });

  it("addMessage with a seq-bearing message advances the watermark", () => {
    const m: ChatMessage = { id: "m1", seq: 5, role: "assistant", content: "hi", timestamp: 1005 };
    useMessageStore.getState().addMessage("chat::1", m);
    expect(useMessageStore.getState().getWatermark("chat::1")).toBe(5);
  });

  it("addMessage with a seq-less message leaves the watermark unchanged", () => {
    useMessageStore.getState().setWatermark("chat::1", 3);
    const m: ChatMessage = { id: "local", role: "user", content: "hi", timestamp: 2000 };
    useMessageStore.getState().addMessage("chat::1", m);
    expect(useMessageStore.getState().getWatermark("chat::1")).toBe(3);
  });

  it("finalizeStream with a seq advances the watermark", () => {
    useMessageStore.getState().finalizeStream("chat::1", "full text", "msg-abc", 8);
    expect(useMessageStore.getState().getWatermark("chat::1")).toBe(8);
  });

  it("watermark does not move backwards when a lower seq arrives", () => {
    useMessageStore.getState().setWatermark("chat::1", 10);
    const m: ChatMessage = { id: "m-low", seq: 4, role: "assistant", content: "late", timestamp: 3000 };
    useMessageStore.getState().addMessage("chat::1", m);
    expect(useMessageStore.getState().getWatermark("chat::1")).toBe(10);
  });
});
