import { beforeEach, describe, expect, it, vi } from "vitest";
import { WS_EVENTS } from "@cc-pet/shared";
import { useOutboxStore } from "./store/outbox.js";

// ---------------------------------------------------------------------------
// Minimal WebSocket fake
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static CONNECTING = 0;

  readyState: number = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Test helper: simulate server message */
  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  /** Test helper: trigger open */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

let fakeWs: FakeWebSocket;

vi.mock("./store/outbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store/outbox.js")>();
  return actual;
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function FakeWebSocketConstructor() {
  return fakeWs;
}
FakeWebSocketConstructor.OPEN = 1;
FakeWebSocketConstructor.CLOSING = 2;
FakeWebSocketConstructor.CLOSED = 3;
FakeWebSocketConstructor.CONNECTING = 0;

beforeEach(() => {
  fakeWs = new FakeWebSocket();
  vi.stubGlobal("WebSocket", FakeWebSocketConstructor as unknown as typeof WebSocket);
  // Reset outbox store
  useOutboxStore.setState({ entries: [] });
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Import adapter AFTER stubbing WebSocket so the module sees the fake
// ---------------------------------------------------------------------------

async function getAdapter() {
  // Dynamic import so the module is re-evaluated each time in the same process
  // (vitest isolates modules per test file, not per test). We just import once.
  const { createWebAdapter } = await import("./web-adapter.js");
  const adapter = createWebAdapter("http://localhost", "test-token");
  adapter.connectWs();
  fakeWs.open();
  return adapter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendWsMessage – policy='never'", () => {
  it("sends immediately when socket is OPEN and returns empty string", async () => {
    const adapter = await getAdapter();
    const id = adapter.sendWsMessage({ type: "ping" }, "never");
    expect(id).toBe("");
    expect(fakeWs.sent.length).toBe(1);
    expect(JSON.parse(fakeWs.sent[0])).toMatchObject({ type: "ping" });
  });

  it("drops message and returns '' when socket is not OPEN", async () => {
    const adapter = await getAdapter();
    fakeWs.readyState = FakeWebSocket.CLOSED;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = adapter.sendWsMessage({ type: "ping" }, "never");
    expect(id).toBe("");
    expect(fakeWs.sent.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not enqueue into outbox for never policy", async () => {
    const adapter = await getAdapter();
    adapter.sendWsMessage({ type: "ping" }, "never");
    expect(useOutboxStore.getState().entries.length).toBe(0);
  });
});

describe("sendWsMessage – policy='auto'", () => {
  it("enqueues and sends immediately when socket is OPEN, returns clientMsgId", async () => {
    const adapter = await getAdapter();
    const id = adapter.sendWsMessage(
      { type: WS_EVENTS.SEND_MESSAGE, content: "hello" },
      "auto",
    );
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(fakeWs.sent.length).toBe(1);
    const sent = JSON.parse(fakeWs.sent[0]);
    expect(sent.clientMsgId).toBe(id);
    expect(sent.type).toBe(WS_EVENTS.SEND_MESSAGE);
  });

  it("enqueues but does NOT send when socket is closed", async () => {
    const adapter = await getAdapter();
    fakeWs.readyState = FakeWebSocket.CLOSED;
    const id = adapter.sendWsMessage(
      { type: WS_EVENTS.SEND_MESSAGE, content: "queued" },
      "auto",
    );
    expect(id.length).toBeGreaterThan(0);
    expect(fakeWs.sent.length).toBe(0);
    const entries = useOutboxStore.getState().entries;
    expect(entries.some((e) => e.clientMsgId === id)).toBe(true);
  });
});

describe("sendWsMessage – policy='manual'", () => {
  it("enqueues and sends immediately when socket is OPEN", async () => {
    const adapter = await getAdapter();
    const id = adapter.sendWsMessage(
      { type: WS_EVENTS.SEND_MESSAGE, content: "card reply" },
      "manual",
    );
    expect(id.length).toBeGreaterThan(0);
    const entries = useOutboxStore.getState().entries;
    expect(entries.some((e) => e.clientMsgId === id && e.policy === "manual")).toBe(true);
  });
});

describe("MESSAGE_ACK handling", () => {
  it("calls markSent on the outbox when an ack arrives", async () => {
    const adapter = await getAdapter();
    const id = adapter.sendWsMessage(
      { type: WS_EVENTS.SEND_MESSAGE, content: "hello" },
      "auto",
    );
    // Outbox should have one pending entry
    expect(useOutboxStore.getState().entries.some((e) => e.clientMsgId === id)).toBe(true);

    // Simulate server ack (flat envelope)
    fakeWs.receive({ type: WS_EVENTS.MESSAGE_ACK, clientMsgId: id, seq: 42 });

    // Entry should be removed
    expect(useOutboxStore.getState().entries.some((e) => e.clientMsgId === id)).toBe(false);
  });

  it("does not forward ack to the event handler", async () => {
    const adapter = await getAdapter();
    const handler = vi.fn();
    adapter.onWsEvent(handler);

    const id = adapter.sendWsMessage(
      { type: WS_EVENTS.SEND_MESSAGE, content: "hello" },
      "auto",
    );
    fakeWs.receive({ type: WS_EVENTS.MESSAGE_ACK, clientMsgId: id, seq: 1 });

    expect(handler).not.toHaveBeenCalledWith(WS_EVENTS.MESSAGE_ACK, expect.anything());
  });
});

describe("flushOutbox on reconnect", () => {
  it("resends pending entries when socket reopens", async () => {
    const adapter = await getAdapter();

    // Queue a message while socket is "down"
    fakeWs.readyState = FakeWebSocket.CLOSED;
    const id = adapter.sendWsMessage(
      { type: WS_EVENTS.SEND_MESSAGE, content: "retry me" },
      "auto",
    );
    expect(fakeWs.sent.length).toBe(0);

    // Simulate reconnect: new socket opens
    fakeWs.readyState = FakeWebSocket.OPEN;
    // Call open handler (simulates onopen firing)
    fakeWs.onopen?.();

    // flushOutbox should have re-sent the pending entry
    expect(fakeWs.sent.length).toBeGreaterThanOrEqual(1);
    const sentPayloads = fakeWs.sent.map((s) => JSON.parse(s));
    expect(sentPayloads.some((p) => p.clientMsgId === id)).toBe(true);
  });

  it("calls reviveAuto before takeSendable so failed-auto entries are retried", async () => {
    const adapter = await getAdapter();

    // Manually insert a failed auto entry (simulating expiry during outage)
    const clientMsgId = crypto.randomUUID();
    useOutboxStore.setState({
      entries: [
        {
          clientMsgId,
          payload: { type: WS_EVENTS.SEND_MESSAGE, content: "was failed" },
          policy: "auto",
          status: "failed",
          createdAt: Date.now() - 30_000,
        },
      ],
    });

    // Trigger flush
    adapter.flushOutbox();

    expect(fakeWs.sent.length).toBe(1);
    expect(JSON.parse(fakeWs.sent[0]).clientMsgId).toBe(clientMsgId);
  });
});

describe("expireStale interval", () => {
  it("does NOT expire entries when socket is not OPEN", async () => {
    vi.useFakeTimers();
    const adapter = await getAdapter();
    fakeWs.readyState = FakeWebSocket.CLOSED;

    const id = adapter.sendWsMessage(
      { type: WS_EVENTS.SEND_MESSAGE, content: "offline msg" },
      "auto",
    );

    // Advance time past ACK_TIMEOUT_MS (15s); expireStale should NOT run because socket is closed
    vi.advanceTimersByTime(20_000);

    const entry = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id);
    expect(entry?.status).toBe("pending"); // still pending, not expired

    vi.useRealTimers();
    adapter.disconnectWs();
  });

  it("expires entries when socket is OPEN", async () => {
    vi.useFakeTimers();
    const adapter = await getAdapter();
    // socket is OPEN by default from getAdapter()

    const id = adapter.sendWsMessage(
      { type: WS_EVENTS.SEND_MESSAGE, content: "will expire" },
      "auto",
    );

    // Advance past ACK_TIMEOUT_MS (15s) + one interval tick (5s)
    vi.advanceTimersByTime(20_000);

    const entry = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id);
    expect(entry?.status).toBe("failed");

    vi.useRealTimers();
    adapter.disconnectWs();
  });
});
