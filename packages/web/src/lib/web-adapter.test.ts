import { beforeEach, describe, expect, it, vi } from "vitest";
import { WS_EVENTS } from "@cc-pet/shared";
import type { ChatMessage } from "@cc-pet/shared";
import { useOutboxStore } from "./store/outbox.js";
import { useMessageStore } from "./store/message.js";
import { useUIStore } from "./store/ui.js";

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
  useMessageStore.setState({
    messagesByChat: {},
    watermarks: {},
    loadedChatKeys: new Set<string>(),
    streamingContent: {},
  });
  useUIStore.getState().setPetState("idle");
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

  it("surfaces the failure in the chat when the socket is not OPEN", async () => {
    const adapter = await getAdapter();
    fakeWs.readyState = FakeWebSocket.CLOSED;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    adapter.sendWsMessage(
      {
        type: WS_EVENTS.SEND_MESSAGE,
        connectionId: "c1",
        sessionKey: "s1",
        content: "/stop",
      },
      "never",
    );

    // A never-policy send is never queued, so a silent drop leaves the user with
    // no idea their /stop went nowhere.
    const msgs = useMessageStore.getState().messagesByChat["c1::s1"] ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toContain("发送失败");
    expect(useUIStore.getState().petState).toBe("error");
    warnSpy.mockRestore();
  });

  it("does not add a chat bubble when the dropped message has no chat target", async () => {
    const adapter = await getAdapter();
    fakeWs.readyState = FakeWebSocket.CLOSED;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    adapter.sendWsMessage({ type: "ping" }, "never");

    expect(useMessageStore.getState().messagesByChat).toEqual({});
    warnSpy.mockRestore();
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

  it("restarts the ack budget when an entry is actually written to the socket", async () => {
    const adapter = await getAdapter();

    // Queued 60 s ago while the socket was down — far past ACK_TIMEOUT_MS.
    fakeWs.readyState = FakeWebSocket.CLOSED;
    const id = adapter.sendWsMessage(
      { type: WS_EVENTS.SEND_MESSAGE, content: "queued during outage" },
      "auto",
    );
    const staleAt = Date.now() - 60_000;
    useOutboxStore.setState({
      entries: useOutboxStore.getState().entries.map((e) => ({ ...e, createdAt: staleAt })),
    });

    fakeWs.readyState = FakeWebSocket.OPEN;
    adapter.flushOutbox();
    expect(fakeWs.sent.map((s) => JSON.parse(s).clientMsgId)).toContain(id);

    // The ack budget must start at transmission, so the very next expiry sweep
    // (which runs every 5 s while the socket is open) must not kill it.
    const entry = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
    expect(entry.transmittedAt).toBeGreaterThan(staleAt);
    useOutboxStore.getState().expireStale();
    expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!.status).toBe(
      "pending",
    );
  });
});

describe("flushOutbox – single-message retry", () => {
  function seedFailed(content: string, policy: "auto" | "manual") {
    const clientMsgId = crypto.randomUUID();
    useOutboxStore.setState({
      entries: [
        ...useOutboxStore.getState().entries,
        {
          clientMsgId,
          payload: { type: WS_EVENTS.SEND_MESSAGE, content },
          policy,
          status: "failed" as const,
          createdAt: Date.now() - 300_000,
        },
      ],
    });
    return clientMsgId;
  }

  it("resends only the requested entry and leaves other failures alone", async () => {
    const adapter = await getAdapter();
    const target = seedFailed("retry just me", "auto");
    const otherAuto = seedFailed("leave me failed", "auto");
    const otherManual = seedFailed("leave me too", "manual");

    adapter.flushOutbox(target);

    expect(fakeWs.sent.map((s) => JSON.parse(s).clientMsgId)).toEqual([target]);
    const byId = (id: string) =>
      useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
    expect(byId(otherAuto).status).toBe("failed");
    expect(byId(otherManual).status).toBe("failed");
  });

  it("resends a failed manual entry past its context window when asked explicitly", async () => {
    const adapter = await getAdapter();
    const target = seedFailed("stale card reply", "manual");

    adapter.flushOutbox(target);

    expect(fakeWs.sent.map((s) => JSON.parse(s).clientMsgId)).toEqual([target]);
    expect(
      useOutboxStore.getState().entries.find((e) => e.clientMsgId === target)!.status,
    ).toBe("pending");
  });

  it("does not resend an entry whose payload was dropped", async () => {
    const adapter = await getAdapter();
    const clientMsgId = crypto.randomUUID();
    useOutboxStore.setState({
      entries: [
        {
          clientMsgId,
          payload: {},
          policy: "auto",
          status: "failed",
          createdAt: Date.now(),
          payloadDropped: true,
        },
      ],
    });

    adapter.flushOutbox(clientMsgId);

    expect(fakeWs.sent.length).toBe(0);
  });

  // 重新发送 is the only way a manual entry escapes failed — reviveAuto skips
  // that tier by design. Dropping the tap while offline lost the message.
  it("queues an offline retry tap so the next reconnect carries it", async () => {
    const adapter = await getAdapter();
    const target = seedFailed("tapped while offline", "manual");
    fakeWs.readyState = FakeWebSocket.CLOSED;

    adapter.flushOutbox(target);

    expect(fakeWs.sent.length).toBe(0);
    expect(
      useOutboxStore.getState().entries.find((e) => e.clientMsgId === target)!.status,
    ).toBe("pending");

    fakeWs.readyState = FakeWebSocket.OPEN;
    adapter.flushOutbox();
    expect(fakeWs.sent.map((s) => JSON.parse(s).clientMsgId)).toEqual([target]);
  });
});

describe("reconnect backfill", () => {
  type Page = { messages: ChatMessage[]; hasMore: boolean };

  /** Stub global fetch and record every history path the adapter asks for. */
  function stubHistory(pages: Record<string, Page[]>): { paths: string[] } {
    const paths: string[] = [];
    const cursors: Record<string, number> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        paths.push(url);
        const chatKey = decodeURIComponent(url.replace(/^.*\/api\/history\//, "").split("?")[0]);
        const queue = pages[chatKey] ?? [];
        const page = queue[cursors[chatKey] ?? 0] ?? { messages: [], hasMore: false };
        cursors[chatKey] = (cursors[chatKey] ?? 0) + 1;
        return { ok: true, json: async () => page } as unknown as Response;
      }),
    );
    return { paths };
  }

  const srvMsg = (id: string, seq: number): ChatMessage => ({
    id, seq, role: "assistant", content: id, timestamp: 1000 + seq,
  });

  it("does not fetch history on the very first onopen (initial connect, not a reconnect)", async () => {
    const { paths } = stubHistory({ "c1::default": [{ messages: [srvMsg("a", 5)], hasMore: false }] });
    useMessageStore.getState().setWatermark("c1::default", 3);

    await getAdapter();
    await new Promise((r) => setTimeout(r, 10));

    expect(paths).toEqual([]);
  });

  it("backfills every chat with a watermark on reconnect, not just the active one", async () => {
    const { paths } = stubHistory({
      "c1::active": [{ messages: [srvMsg("act", 11)], hasMore: false }],
      "c1::other": [{ messages: [srvMsg("oth", 21)], hasMore: false }],
    });
    useMessageStore.getState().setWatermark("c1::active", 10);
    useMessageStore.getState().setWatermark("c1::other", 20);

    const adapter = await getAdapter();
    fakeWs.onopen?.(); // reconnect

    await vi.waitFor(() => {
      expect(useMessageStore.getState().getWatermark("c1::other")).toBe(21);
    });
    expect(useMessageStore.getState().getWatermark("c1::active")).toBe(11);
    expect(paths.some((p) => p.includes("c1%3A%3Aactive") && p.includes("afterSeq=10"))).toBe(true);
    expect(paths.some((p) => p.includes("c1%3A%3Aother") && p.includes("afterSeq=20"))).toBe(true);
    adapter.disconnectWs();
  });

  it("backfills a loaded chat that has no watermark yet", async () => {
    const { paths } = stubHistory({ "c1::loaded": [{ messages: [], hasMore: false }] });
    useMessageStore.getState().markChatLoaded("c1::loaded");

    const adapter = await getAdapter();
    fakeWs.onopen?.();

    await vi.waitFor(() => {
      expect(paths.some((p) => p.includes("c1%3A%3Aloaded"))).toBe(true);
    });
    adapter.disconnectWs();
  });

  it("pages until caught up when the backlog exceeds one page", async () => {
    stubHistory({
      "c1::default": [
        { messages: [srvMsg("p1", 11), srvMsg("p2", 12)], hasMore: true },
        { messages: [srvMsg("p3", 13)], hasMore: false },
      ],
    });
    useMessageStore.getState().setWatermark("c1::default", 10);

    const adapter = await getAdapter();
    fakeWs.onopen?.();

    await vi.waitFor(() => {
      expect(useMessageStore.getState().getWatermark("c1::default")).toBe(13);
    });
    expect((useMessageStore.getState().messagesByChat["c1::default"] ?? []).map((m) => m.id))
      .toEqual(["p1", "p2", "p3"]);
    adapter.disconnectWs();
  });

  it("stops paging when a page comes back with no new seq (watermark cannot advance)", async () => {
    const { paths } = stubHistory({
      // hasMore stays true forever and the seq never exceeds the watermark:
      // only the strict-advance guard can terminate this.
      "c1::default": Array.from({ length: 20 }, () => ({ messages: [srvMsg("stuck", 10)], hasMore: true })),
    });
    useMessageStore.getState().setWatermark("c1::default", 10);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const adapter = await getAdapter();
    fakeWs.onopen?.();
    await new Promise((r) => setTimeout(r, 30));

    expect(paths.length).toBe(1);
    warn.mockRestore();
    adapter.disconnectWs();
  });

  it("stops paging on an empty page", async () => {
    const { paths } = stubHistory({
      "c1::default": [{ messages: [], hasMore: true }],
    });
    useMessageStore.getState().setWatermark("c1::default", 10);

    const adapter = await getAdapter();
    fakeWs.onopen?.();
    await new Promise((r) => setTimeout(r, 30));

    expect(paths.length).toBe(1);
    adapter.disconnectWs();
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

// ---------------------------------------------------------------------------
// uploadAttachment
// ---------------------------------------------------------------------------

class FakeXhr {
  static instances: FakeXhr[] = [];
  status = 200;
  responseText = "";
  upload = { onprogress: null as ((e: any) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  sentBody: any = null;

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: any) {
    this.sentBody = body;
  }
  /** Drive a response as the browser would. */
  respond(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

describe("uploadAttachment", () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr as any);
  });

  it("posts to the connection's attachment endpoint with the bearer token", async () => {
    const adapter = await getAdapter();
    const file = new File(["body"], "a.zip", { type: "application/zip" });
    const promise = adapter.uploadAttachment("conn-1", file, () => {});

    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("http://localhost/api/attachments/conn-1");
    expect(xhr.headers.Authorization).toBe("Bearer test-token");

    xhr.respond(200, JSON.stringify({ ok: true, attachment: { name: "a.zip", size: 4, agentPath: "/w/a.zip" } }));
    await expect(promise).resolves.toEqual({ name: "a.zip", size: 4, agentPath: "/w/a.zip" });
  });

  it("caps progress at 99 until the server acks", async () => {
    const adapter = await getAdapter();
    const seen: number[] = [];
    const promise = adapter.uploadAttachment(
      "conn-1",
      new File(["x"], "a.zip"),
      (percent) => seen.push(percent),
    );

    const xhr = FakeXhr.instances[0];
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    // 100% before the response would repeat the old lie: bytes leaving the browser
    // is not the same as the server having accepted them.
    expect(seen).toEqual([99]);

    xhr.respond(200, JSON.stringify({ ok: true, attachment: { name: "a.zip", size: 1, agentPath: "/w/a.zip" } }));
    await promise;
    expect(seen.at(-1)).toBe(100);
  });

  it("explains a gateway timeout instead of reporting an unparseable response", async () => {
    const adapter = await getAdapter();
    const promise = adapter.uploadAttachment("conn-1", new File(["x"], "a.zip"), () => {});

    // Traefik's readTimeout cutting the body mid-upload yields a plain-text 502.
    FakeXhr.instances[0].respond(502, "Bad Gateway");

    await expect(promise).rejects.toThrow(/网关中断.*502/);
  });

  it("surfaces the server's message on a normal error response", async () => {
    const adapter = await getAdapter();
    const promise = adapter.uploadAttachment("conn-1", new File(["x"], "a.zip"), () => {});

    FakeXhr.instances[0].respond(507, JSON.stringify({ error: "ATTACHMENT_DISK_FULL", message: "工作区磁盘空间不足，上传未完成。" }));

    await expect(promise).rejects.toThrow("工作区磁盘空间不足，上传未完成。");
  });
});
