import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { BridgeConfig, BridgeIncoming, BridgeOutgoing } from "@cc-pet/shared";
import { parseBridgeMessage } from "./protocol.js";

export interface BridgeClientEvents {
  message: [connectionId: string, msg: BridgeIncoming];
  connected: [connectionId: string];
  disconnected: [connectionId: string, reason: string];
  error: [connectionId: string, error: string];
}

export class BridgeClient extends EventEmitter<BridgeClientEvents> {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;

  constructor(
    public readonly connectionId: string,
    private config: BridgeConfig,
  ) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.ws) this.disconnect();

    const url = `ws://${this.config.host}:${this.config.port}/bridge/ws?token=${encodeURIComponent(this.config.token)}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this._connected = true;
      this.emit("connected", this.connectionId);
    });

    this.ws.on("message", (data) => {
      const raw = data.toString();
      const msg = parseBridgeMessage(raw);
      this.emit("message", this.connectionId, msg);
    });

    this.ws.on("close", (_code, reason) => {
      this._connected = false;
      this.emit("disconnected", this.connectionId, reason.toString());
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.emit("error", this.connectionId, err.message);
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  send(msg: BridgeOutgoing): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emit("error", this.connectionId, "WebSocket not connected");
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}
