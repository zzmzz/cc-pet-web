import { EventEmitter } from "node:events";
import type { BridgeConfig, BridgeOutgoing } from "@cc-pet/shared";
import { BridgeClient } from "./client.js";

export class BridgeManager extends EventEmitter {
  private clients = new Map<string, BridgeClient>();

  connect(config: BridgeConfig): void {
    if (this.clients.has(config.id)) this.disconnect(config.id);

    const client = new BridgeClient(config.id, config);
    client.on("message", (connId, msg) => this.emit("message", connId, msg));
    client.on("connected", (connId) => this.emit("connected", connId));
    client.on("disconnected", (connId, reason) => this.emit("disconnected", connId, reason));
    client.on("error", (connId, err) => this.emit("error", connId, err));

    this.clients.set(config.id, client);
    client.connect();
  }

  disconnect(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      client.disconnect();
      this.clients.delete(id);
    }
  }

  send(connectionId: string, msg: BridgeOutgoing): void {
    const client = this.clients.get(connectionId);
    if (!client) throw new Error(`No bridge connection: ${connectionId}`);
    client.send(msg);
  }

  getStatus(id: string): boolean {
    return this.clients.get(id)?.connected ?? false;
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) client.disconnect();
    this.clients.clear();
  }
}
