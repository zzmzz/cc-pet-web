import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useOutboxStore, useOutboxEntry, MANUAL_WINDOW_MS, ACK_TIMEOUT_MS, OUTBOX_STORAGE_KEY,
} from "./outbox";

describe("outbox store", () => {
  beforeEach(() => {
    localStorage.clear();
    useOutboxStore.setState({ entries: [] });
  });

  it("enqueues a pending entry and returns its clientMsgId", () => {
    const id = useOutboxStore.getState().enqueue({ type: "send-message", content: "hi" }, "auto");
    const [entry] = useOutboxStore.getState().entries;
    expect(entry.clientMsgId).toBe(id);
    expect(entry.status).toBe("pending");
  });

  it("never enqueues a never-policy payload", () => {
    const id = useOutboxStore.getState().enqueue({ type: "send-message", content: "/stop" }, "never");
    expect(id).toBe("");
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });

  it("marks an entry sent on ack", () => {
    const id = useOutboxStore.getState().enqueue({ content: "hi" }, "auto");
    useOutboxStore.getState().markSent(id);
    expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)).toBeUndefined();
  });

  it("expires a pending auto entry past the ack timeout into failed", () => {
    const sentAt = Date.now();
    const id = useOutboxStore.getState().enqueue({ content: "hi" }, "auto");
    useOutboxStore.getState().markTransmitted([id], sentAt);
    useOutboxStore.getState().expireStale(sentAt + ACK_TIMEOUT_MS + 1);
    const entry = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
    expect(entry.status).toBe("failed");
  });

  // The ack budget measures how long the server has had the bytes. An entry
  // still queued behind a dead socket waits on a connection, not on an ack.
  it("never expires an entry that was never written to the socket", () => {
    const id = useOutboxStore.getState().enqueue({ content: "hi" }, "auto");
    useOutboxStore.getState().expireStale(Date.now() + ACK_TIMEOUT_MS * 100);
    expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!.status).toBe("pending");
  });

  // createdAt is the age of the user's intent; transmittedAt is the ack budget.
  // Sharing one field let every reconnect retransmit slide the manual window
  // forward, so a stale card answer could still be delivered minutes later.
  it("keeps the manual context window anchored to enqueue time across retransmits", () => {
    const enqueuedAt = Date.now();
    const id = useOutboxStore.getState().enqueue({ content: "answer" }, "manual");
    // Two reconnects inside the window each rewrite the ack budget.
    useOutboxStore.getState().markTransmitted([id], enqueuedAt + 60_000);
    useOutboxStore.getState().markTransmitted([id], enqueuedAt + 110_000);
    const sendable = useOutboxStore.getState().takeSendable(enqueuedAt + MANUAL_WINDOW_MS + 1);
    expect(sendable.map((e) => e.clientMsgId)).not.toContain(id);
    expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!.status).toBe("failed");
  });

  it("does not resend a manual entry past its context window", () => {
    const id = useOutboxStore.getState().enqueue({ content: "answer" }, "manual");
    const sendable = useOutboxStore.getState().takeSendable(Date.now() + MANUAL_WINDOW_MS + 1);
    expect(sendable.map((e) => e.clientMsgId)).not.toContain(id);
    expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!.status).toBe("failed");
  });

  it("still resends an auto entry past the manual window", () => {
    const id = useOutboxStore.getState().enqueue({ content: "hi" }, "auto");
    const sendable = useOutboxStore.getState().takeSendable(Date.now() + MANUAL_WINDOW_MS + 1);
    expect(sendable.map((e) => e.clientMsgId)).toContain(id);
  });

  it("keeps oversized payloads in memory but persists only a dropped placeholder", () => {
    const big = "x".repeat(300_000);
    const id = useOutboxStore.getState().enqueue({ files: big }, "auto");
    const live = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
    expect(live.payload.files).toBe(big);
    expect(live.status).toBe("pending");

    const persisted = JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY) ?? "[]");
    const placeholder = persisted.find((e: any) => e.clientMsgId === id);
    expect(placeholder).toBeDefined();
    expect(placeholder.status).toBe("failed");
    expect(placeholder.payloadDropped).toBe(true);
    expect(placeholder.payload).toEqual({});
  });

  describe("useOutboxEntry", () => {
    it("returns undefined when no entry with that id exists", () => {
      const { result } = renderHook(() => useOutboxEntry("nonexistent-id"));
      expect(result.current).toBeUndefined();
    });

    it("returns the entry matching the given clientMsgId", () => {
      const id = useOutboxStore.getState().enqueue({ content: "hello" }, "auto");
      const { result } = renderHook(() => useOutboxEntry(id));
      expect(result.current).toBeDefined();
      expect(result.current!.clientMsgId).toBe(id);
      expect(result.current!.status).toBe("pending");
    });

    it("returns undefined after the entry is removed by markSent", () => {
      const id = useOutboxStore.getState().enqueue({ content: "hello" }, "auto");
      useOutboxStore.getState().markSent(id);
      const { result } = renderHook(() => useOutboxEntry(id));
      expect(result.current).toBeUndefined();
    });
  });

  describe("markTransmitted", () => {
    it("restarts the ack budget for the transmitted entries only", () => {
      const stale = Date.now() - 60_000;
      const queued = useOutboxStore.getState().enqueue({ content: "queued" }, "auto");
      const untouched = useOutboxStore.getState().enqueue({ content: "still waiting" }, "auto");
      useOutboxStore.setState({
        entries: useOutboxStore.getState().entries.map((e) => ({ ...e, createdAt: stale })),
      });

      const sentAt = Date.now();
      useOutboxStore.getState().markTransmitted([queued], sentAt);

      const byId = (id: string) => useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
      expect(byId(queued).transmittedAt).toBe(sentAt);
      expect(byId(queued).status).toBe("pending");
      // The intent clock stays put — only the ack budget moves.
      expect(byId(queued).createdAt).toBe(stale);
      expect(byId(untouched).transmittedAt).toBeUndefined();
    });

    it("does not resurrect an entry that already failed", () => {
      const id = useOutboxStore.getState().enqueue({ content: "gone" }, "manual");
      useOutboxStore.getState().takeSendable(Date.now() + MANUAL_WINDOW_MS + 1);
      expect(useOutboxStore.getState().entries[0].status).toBe("failed");

      useOutboxStore.getState().markTransmitted([id], Date.now());
      expect(useOutboxStore.getState().entries[0].status).toBe("failed");
    });
  });

  describe("reviveAuto", () => {
    it("revives a failed auto entry back to pending with a refreshed createdAt", () => {
      const sentAt = Date.now();
      const id = useOutboxStore.getState().enqueue({ content: "hello" }, "auto");
      // force it to failed by letting the ack budget run out after transmission
      useOutboxStore.getState().markTransmitted([id], sentAt);
      useOutboxStore.getState().expireStale(sentAt + ACK_TIMEOUT_MS + 1);
      expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!.status).toBe("failed");

      const reconnectAt = Date.now() + 60_000;
      useOutboxStore.getState().reviveAuto(reconnectAt);
      const entry = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
      expect(entry.status).toBe("pending");
      expect(entry.createdAt).toBe(reconnectAt);
      // The old budget must be cleared, or the next tick re-fails it instantly.
      expect(entry.transmittedAt).toBeUndefined();
    });

    it("does NOT revive a failed manual entry", () => {
      const id = useOutboxStore.getState().enqueue({ content: "ctx answer" }, "manual");
      // expire it past the manual window
      useOutboxStore.getState().takeSendable(Date.now() + MANUAL_WINDOW_MS + 1);
      expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!.status).toBe("failed");

      useOutboxStore.getState().reviveAuto();
      const entry = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
      expect(entry.status).toBe("failed");
    });

    it("does NOT revive a failed auto entry with payloadDropped", () => {
      const id = useOutboxStore.getState().enqueue({ content: "hi" }, "auto");
      // manually inject payloadDropped into state
      useOutboxStore.setState({
        entries: useOutboxStore.getState().entries.map((e) =>
          e.clientMsgId === id
            ? { ...e, status: "failed" as const, payloadDropped: true }
            : e
        ),
      });
      expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!.payloadDropped).toBe(true);

      useOutboxStore.getState().reviveAuto();
      const entry = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
      expect(entry.status).toBe("failed");
    });

    it("end-to-end: a message enqueued during a 60 s outage survives to the reconnect flush", () => {
      const now = Date.now();
      const id = useOutboxStore.getState().enqueue({ content: "during outage" }, "auto");

      // The poll keeps ticking while the socket is down; the entry was never
      // transmitted, so no ack is owed and it must stay pending.
      useOutboxStore.getState().expireStale(now + ACK_TIMEOUT_MS + 1);
      expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!.status).toBe("pending");

      // socket reconnects at +60 s — flushOutbox calls takeSendable
      const reconnectAt = now + 60_000;
      const sendable = useOutboxStore.getState().takeSendable(reconnectAt);
      expect(sendable.map((e) => e.clientMsgId)).toContain(id);
    });
  });
});
