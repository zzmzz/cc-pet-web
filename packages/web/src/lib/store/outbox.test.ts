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
    const id = useOutboxStore.getState().enqueue({ content: "hi" }, "auto");
    useOutboxStore.getState().expireStale(Date.now() + ACK_TIMEOUT_MS + 1);
    const entry = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
    expect(entry.status).toBe("failed");
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

  describe("reviveAuto", () => {
    it("revives a failed auto entry back to pending with a refreshed createdAt", () => {
      const id = useOutboxStore.getState().enqueue({ content: "hello" }, "auto");
      // force it to failed by advancing time past ACK_TIMEOUT_MS
      useOutboxStore.getState().expireStale(Date.now() + ACK_TIMEOUT_MS + 1);
      expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!.status).toBe("failed");

      const reconnectAt = Date.now() + 60_000;
      useOutboxStore.getState().reviveAuto(reconnectAt);
      const entry = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
      expect(entry.status).toBe("pending");
      expect(entry.createdAt).toBe(reconnectAt);
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

    it("end-to-end: enqueue → expireStale (lost during outage) → reviveAuto → takeSendable returns it", () => {
      const now = Date.now();
      const id = useOutboxStore.getState().enqueue({ content: "during outage" }, "auto");

      // 15 s of offline time elapses — expireStale flips it to failed
      useOutboxStore.getState().expireStale(now + ACK_TIMEOUT_MS + 1);
      expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!.status).toBe("failed");

      // socket reconnects at +60 s
      const reconnectAt = now + 60_000;
      useOutboxStore.getState().reviveAuto(reconnectAt);

      // flushOutbox calls takeSendable — must get the entry back
      const sendable = useOutboxStore.getState().takeSendable(reconnectAt);
      expect(sendable.map((e) => e.clientMsgId)).toContain(id);
    });
  });
});
