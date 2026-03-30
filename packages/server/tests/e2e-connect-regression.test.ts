import { describe, it, expect } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { WS_EVENTS } from "@cc-pet/shared";

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tester = net.createServer();
    tester.once("error", reject);
    tester.listen(0, "127.0.0.1", () => {
      const address = tester.address();
      if (!address || typeof address === "string") {
        tester.close();
        reject(new Error("failed to allocate test port"));
        return;
      }
      tester.close((err) => {
        if (err) reject(err);
        else resolve(address.port);
      });
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function waitForWsMessage<T = any>(
  ws: WebSocket,
  predicate: (msg: T) => boolean,
  timeoutMs = 3_000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handleMessage);
      reject(new Error(`did not receive expected websocket event within ${timeoutMs}ms`));
    }, timeoutMs);

    const handleMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as T;
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off("message", handleMessage);
      resolve(msg);
    };

    ws.on("message", handleMessage);
  });
}

async function startServerAndBridge() {
  const bridgePort = await getFreePort();
  const serverPort = await getFreePort();
  const secret = "cc-pet-dev";
  const bridgeToken = "V&cMUakQ$5c8da256";
  const connectionId = "cc-connect";
  const dataDir = await mkdtemp(path.join(tmpdir(), "cc-pet-e2e-"));

  let bridgeClient: WebSocket | null = null;
  let resolveBridgeClient: ((ws: WebSocket) => void) | null = null;
  const bridgeClientReady = new Promise<WebSocket>((resolve) => {
    resolveBridgeClient = resolve;
  });
  const bridgeConnectionQueue: WebSocket[] = [];
  const bridgeConnectionWaiters: Array<(ws: WebSocket) => void> = [];

  const bridgeWss = new WebSocketServer({
    host: "127.0.0.1",
    port: bridgePort,
    path: "/bridge/ws",
  });

  bridgeWss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
    if (token !== bridgeToken) {
      ws.close(4001, "bad token");
      return;
    }
    bridgeClient = ws;
    bridgeConnectionQueue.push(ws);
    while (bridgeConnectionWaiters.length > 0 && bridgeConnectionQueue.length > 0) {
      const waiter = bridgeConnectionWaiters.shift();
      const nextWs = bridgeConnectionQueue.shift();
      if (waiter && nextWs) waiter(nextWs);
    }
    resolveBridgeClient?.(ws);
  });

  const serverProcess = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      CC_PET_PORT: String(serverPort),
      CC_PET_SECRET: secret,
      CC_PET_DATA_DIR: dataDir,
      CC_CONNECT_ID: connectionId,
      CC_CONNECT_NAME: connectionId,
      CC_CONNECT_HOST: "127.0.0.1",
      CC_CONNECT_PORT: String(bridgePort),
      CC_CONNECT_TOKEN: bridgeToken,
      CC_CONNECT_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  serverProcess.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  });

  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/bridges/${connectionId}/status`);
      if (!res.ok) return false;
      const body = (await res.json()) as { connected?: boolean };
      return body.connected === true;
    } catch {
      return false;
    }
  });

  await bridgeClientReady;
  // Initial bridge connection is established; subsequent waits should observe reconnects only.
  bridgeConnectionQueue.length = 0;

  const openDashboardWs = async (): Promise<WebSocket> =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?token=${encodeURIComponent(secret)}`);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });

  const waitForBridgeReconnect = async (): Promise<WebSocket> =>
    new Promise<WebSocket>((resolve) => {
      const queued = bridgeConnectionQueue.shift();
      if (queued) {
        resolve(queued);
        return;
      }
      bridgeConnectionWaiters.push(resolve);
    });

  const fetchHistory = async () => {
    const chatKey = encodeURIComponent(`${connectionId}::default`);
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/history/${chatKey}`);
    const body = (await res.json()) as { messages: Array<{ role: string; content: string }> };
    return body.messages;
  };

  const stop = async () => {
    serverProcess.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      serverProcess.once("exit", () => resolve());
      setTimeout(() => resolve(), 2_000);
    });
    await new Promise<void>((resolve, reject) => {
      bridgeWss.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(dataDir, { recursive: true, force: true });
    if (stderr.includes("EADDRINUSE")) {
      throw new Error(`server port conflict during test\n${stderr}\n${stdout}`);
    }
  };

  return {
    connectionId,
    bridgeClient: () => {
      if (!bridgeClient) throw new Error("bridge client not connected");
      return bridgeClient;
    },
    openDashboardWs,
    waitForBridgeReconnect,
    fetchHistory,
    stop,
  };
}

describe("e2e bridge connection status sync", () => {
  it("pushes current bridge connected state to a newly connected dashboard client", async () => {
    const stack = await startServerAndBridge();
    const dashboardWs = await stack.openDashboardWs();

    try {
      const connectedEvent = await waitForWsMessage<{ type: string; connectionId: string; connected: boolean }>(
        dashboardWs,
        (msg) => msg.type === WS_EVENTS.BRIDGE_CONNECTED && msg.connectionId === stack.connectionId
      );

      expect(connectedEvent.connected).toBe(true);
    } finally {
      dashboardWs.close();
      await stack.stop();
    }
  }, 30_000);

  it("forwards dashboard SEND_MESSAGE to bridge and persists user message", async () => {
    const stack = await startServerAndBridge();
    const dashboardWs = await stack.openDashboardWs();
    const bridgeClient = stack.bridgeClient();

    try {
      await waitForWsMessage(dashboardWs, (msg: any) => msg.type === WS_EVENTS.BRIDGE_CONNECTED);

      dashboardWs.send(
        JSON.stringify({
          type: WS_EVENTS.SEND_MESSAGE,
          connectionId: stack.connectionId,
          sessionKey: "default",
          content: "hello from dashboard",
        })
      );

      const bridgeOutgoing = await waitForWsMessage<{ type: string; session_key: string; content: string }>(
        bridgeClient,
        (msg) => msg.type === "message"
      );

      expect(bridgeOutgoing).toMatchObject({
        type: "message",
        session_key: "default",
        content: "hello from dashboard",
      });

      await waitFor(async () => {
        const history = await stack.fetchHistory();
        return history.some((m) => m.role === "user" && m.content === "hello from dashboard");
      });
    } finally {
      dashboardWs.close();
      await stack.stop();
    }
  }, 30_000);

  it("forwards dashboard SEND_FILE as message with files payload", async () => {
    const stack = await startServerAndBridge();
    const dashboardWs = await stack.openDashboardWs();
    const bridgeClient = stack.bridgeClient();

    try {
      await waitForWsMessage(dashboardWs, (msg: any) => msg.type === WS_EVENTS.BRIDGE_CONNECTED);

      dashboardWs.send(
        JSON.stringify({
          type: WS_EVENTS.SEND_FILE,
          connectionId: stack.connectionId,
          sessionKey: "default",
          content: "file caption",
          name: "demo.txt",
          mimeType: "text/plain",
          data: "aGVsbG8=",
        })
      );

      const bridgeOutgoing = await waitForWsMessage<any>(
        bridgeClient,
        (msg) => msg.type === "message" && Array.isArray(msg.files),
      );

      expect(bridgeOutgoing).toMatchObject({
        type: "message",
        session_key: "default",
        content: "file caption",
      });
      expect(bridgeOutgoing.files).toHaveLength(1);
      expect(bridgeOutgoing.files[0]).toMatchObject({
        file_name: "demo.txt",
        mime_type: "text/plain",
        data: "aGVsbG8=",
      });
    } finally {
      dashboardWs.close();
      await stack.stop();
    }
  }, 30_000);

  it("forwards dashboard SEND_FILE with multiple files in one bridge message", async () => {
    const stack = await startServerAndBridge();
    const dashboardWs = await stack.openDashboardWs();
    const bridgeClient = stack.bridgeClient();

    try {
      await waitForWsMessage(dashboardWs, (msg: any) => msg.type === WS_EVENTS.BRIDGE_CONNECTED);

      dashboardWs.send(
        JSON.stringify({
          type: WS_EVENTS.SEND_FILE,
          connectionId: stack.connectionId,
          sessionKey: "default",
          content: "two files",
          files: [
            { file_name: "a.txt", mime_type: "text/plain", data: "YQ==" },
            { file_name: "b.txt", mime_type: "text/plain", data: "Yg==" },
          ],
        })
      );

      const bridgeOutgoing = await waitForWsMessage<any>(
        bridgeClient,
        (msg) => msg.type === "message" && Array.isArray(msg.files) && msg.files.length === 2,
      );

      expect(bridgeOutgoing).toMatchObject({
        type: "message",
        session_key: "default",
        content: "two files",
      });
      expect(bridgeOutgoing.files[0]).toMatchObject({ file_name: "a.txt", mime_type: "text/plain" });
      expect(bridgeOutgoing.files[1]).toMatchObject({ file_name: "b.txt", mime_type: "text/plain" });
    } finally {
      dashboardWs.close();
      await stack.stop();
    }
  }, 30_000);

  it("forwards bridge reply to dashboard and persists assistant message", async () => {
    const stack = await startServerAndBridge();
    const dashboardWs = await stack.openDashboardWs();
    const bridgeClient = stack.bridgeClient();

    try {
      await waitForWsMessage(dashboardWs, (msg: any) => msg.type === WS_EVENTS.BRIDGE_CONNECTED);

      bridgeClient.send(
        JSON.stringify({
          type: "reply",
          session_key: "default",
          content: "pong from bridge",
        })
      );

      const dashboardEvent = await waitForWsMessage<{ type: string; content: string; sessionKey: string }>(
        dashboardWs,
        (msg) => msg.type === WS_EVENTS.BRIDGE_MESSAGE && msg.content === "pong from bridge"
      );

      expect(dashboardEvent.sessionKey).toBe("default");

      await waitFor(async () => {
        const history = await stack.fetchHistory();
        return history.some((m) => m.role === "assistant" && m.content === "pong from bridge");
      });
    } finally {
      dashboardWs.close();
      await stack.stop();
    }
  }, 30_000);

  it("reconnects bridge automatically after disconnect and continues forwarding messages", async () => {
    const stack = await startServerAndBridge();
    const dashboardWs = await stack.openDashboardWs();
    const initialBridgeClient = stack.bridgeClient();

    try {
      await waitForWsMessage(dashboardWs, (msg: any) => msg.type === WS_EVENTS.BRIDGE_CONNECTED);

      // Simulate upstream bridge drop.
      initialBridgeClient.close();

      const disconnectedEvent = await waitForWsMessage<{ type: string; connected: boolean; reason?: string }>(
        dashboardWs,
        (msg) => msg.type === WS_EVENTS.BRIDGE_CONNECTED && msg.connected === false,
        10_000
      );
      expect(disconnectedEvent.connected).toBe(false);

      // Server should auto-reconnect to bridge endpoint.
      const reconnectedBridgeClient = await stack.waitForBridgeReconnect();
      expect(reconnectedBridgeClient.readyState).toBe(WebSocket.OPEN);

      const reconnectedEvent = await waitForWsMessage<{ type: string; connected: boolean }>(
        dashboardWs,
        (msg) => msg.type === WS_EVENTS.BRIDGE_CONNECTED && msg.connected === true,
        10_000
      );
      expect(reconnectedEvent.connected).toBe(true);

      dashboardWs.send(
        JSON.stringify({
          type: WS_EVENTS.SEND_MESSAGE,
          connectionId: stack.connectionId,
          sessionKey: "default",
          content: "hello after reconnect",
        })
      );

      const bridgeOutgoing = await waitForWsMessage<{ type: string; content: string }>(
        reconnectedBridgeClient,
        (msg) => msg.type === "message" && msg.content === "hello after reconnect",
        10_000
      );
      expect(bridgeOutgoing.content).toBe("hello after reconnect");
    } finally {
      dashboardWs.close();
      await stack.stop();
    }
  }, 40_000);
});
