import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { BridgeConfig, BridgeIncoming, BridgeOutgoing } from "@cc-pet/shared";
import { SKILLS_PROBE_REPLY_CTX } from "@cc-pet/shared";
import { registerAckOk } from "./incoming-fields.js";
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingMessages: BridgeOutgoing[] = [];
  private _connected = false;
  private reconnectAttempt = 0;
  private static readonly INITIAL_RECONNECT_MS = 3000;
  private static readonly MAX_RECONNECT_MS = 60_000;

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
      this.reconnectAttempt = 0;
      this.sendRegister();
      this.startHeartbeat();
      this.flushPending();
      this.emit("connected", this.connectionId);
    });

    this.ws.on("message", (data) => {
      const raw = data.toString();
      let envelope: Record<string, unknown> = {};
      try {
        envelope = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* parseBridgeMessage will surface error */
      }
      if (envelope.type === "register_ack" && registerAckOk(envelope)) {
        this.sendSkillsListProbe();
      }
      const msg = parseBridgeMessage(raw);
      this.emit("message", this.connectionId, msg);
    });

    this.ws.on("close", (_code, reason) => {
      const code = _code;
      this._connected = false;
      this.stopHeartbeat();
      this.emit("disconnected", this.connectionId, `code=${code} reason=${reason.toString()}`);
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.emit("error", this.connectionId, err.message);
      // On some WS failures, `error` can happen before/without `close`.
      // Ensure reconnect is still scheduled as a fallback.
      if (!this._connected) {
        this.scheduleReconnect();
      }
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  send(msg: BridgeOutgoing): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.pendingMessages.length >= 100) {
        this.pendingMessages.shift();
      }
      this.pendingMessages.push(msg);
      if (
        !this.ws ||
        this.ws.readyState === WebSocket.CLOSED ||
        this.ws.readyState === WebSocket.CLOSING
      ) {
        this.connect();
      } else if (!this._connected) {
        // CONNECTING state can get stuck on transient network issues.
        // Ensure there is an eventual retry path.
        this.scheduleReconnect();
      }
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      BridgeClient.MAX_RECONNECT_MS,
      BridgeClient.INITIAL_RECONNECT_MS * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      } catch {
        // ping failures are handled by close/error listeners
      }
    }, 25_000);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private flushPending(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.pendingMessages.length === 0) return;
    const queued = [...this.pendingMessages];
    this.pendingMessages = [];
    for (const msg of queued) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendRegister(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: "register",
        platform: this.connectionId,
        capabilities: ["text", "buttons", "typing", "update_message", "preview", "delete_message", "file"],
        metadata: { protocol_version: 1, source: "cc-pet-web" },
      })
    );
  }

  /** cc-pet 对齐：register 成功后探测 `/skills`，reply_ctx 用于服务端过滤、不写入聊天记录 */
  private sendSkillsListProbe(): void {
    this.send({
      type: "message",
      content: "/skills",
      session_key: "default",
      msg_id: `skills-probe-${Date.now()}`,
      user_id: this.connectionId,
      user_name: "cc-pet-user",
      reply_ctx: SKILLS_PROBE_REPLY_CTX,
    });
  }
}
