import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { BridgeClient } from "../src/bridge/client.js";
import type { BridgeConfig } from "@cc-pet/shared";

// Regression for the streaming-preview handshake: cc-connect's SendPreviewStart
// blocks up to 10s waiting for a preview_ack, then degrades to a single whole
// reply. The bridge client must answer every preview_start with a preview_ack
// (echoing ref_id) so the 10s stall never happens.

describe("BridgeClient preview_ack handshake", () => {
  let wss: WebSocketServer | null = null;
  let client: BridgeClient | null = null;

  afterEach(() => {
    client?.disconnect();
    client = null;
    wss?.close();
    wss = null;
  });

  function startServer(onClient: (ws: WebSocket) => void): Promise<number> {
    return new Promise((resolve) => {
      wss = new WebSocketServer({ port: 0, path: "/bridge/ws" });
      wss.on("connection", (ws) => onClient(ws));
      wss.on("listening", () => resolve((wss!.address() as AddressInfo).port));
    });
  }

  it("replies to preview_start with a preview_ack echoing ref_id", async () => {
    const received: any[] = [];
    const gotAck = new Promise<any>((resolve) => {
      startServer((ws) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          received.push(msg);
          if (msg.type === "register") {
            ws.send(JSON.stringify({ type: "register_ack", ok: true }));
            // Now push a preview_start as cc-connect would.
            ws.send(
              JSON.stringify({
                type: "preview_start",
                ref_id: "prev-42",
                session_key: "probe:test:test",
                reply_ctx: "ctx-1",
                content: "partial...",
              }),
            );
          }
          if (msg.type === "preview_ack") resolve(msg);
        });
      }).then((port) => {
        const config: BridgeConfig = {
          id: "cc",
          name: "cc",
          host: "127.0.0.1",
          port,
          token: "t",
          enabled: true,
        };
        client = new BridgeClient("cc", config);
        client.connect();
      });
    });

    const ack = await gotAck;
    expect(ack.type).toBe("preview_ack");
    expect(ack.ref_id).toBe("prev-42");
    expect(typeof ack.preview_handle).toBe("string");
    expect(ack.preview_handle.length).toBeGreaterThan(0);
  });

  it("ignores a preview_start without a ref_id (no malformed ack)", async () => {
    const acks: any[] = [];
    const settled = new Promise<void>((resolve) => {
      startServer((ws) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "register") {
            ws.send(JSON.stringify({ type: "register_ack", ok: true }));
            ws.send(JSON.stringify({ type: "preview_start", content: "no ref id" }));
            // Give the client a moment; then finish.
            setTimeout(resolve, 150);
          }
          if (msg.type === "preview_ack") acks.push(msg);
        });
      }).then((port) => {
        const config: BridgeConfig = {
          id: "cc",
          name: "cc",
          host: "127.0.0.1",
          port,
          token: "t",
          enabled: true,
        };
        client = new BridgeClient("cc", config);
        client.connect();
      });
    });

    await settled;
    expect(acks).toEqual([]);
  });
});
