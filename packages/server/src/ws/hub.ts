import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

interface ClientInfo {
  ws: WebSocket;
}

interface HubLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
  debug: (obj: Record<string, unknown>, msg?: string) => void;
}

export class ClientHub {
  private wss: WebSocketServer;
  private clients = new Set<ClientInfo>();
  private logger?: HubLogger;

  onMessage: (msg: any) => void = () => {};
  onClientConnected: (send: (event: string, payload: Record<string, any>) => void) => void = () => {};

  constructor(server: Server, secret: string, logger?: HubLogger) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.logger = logger;
    const authEnabled = secret.trim().length > 0;

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const token = url.searchParams.get("token");
      const remoteAddress = req.socket.remoteAddress ?? "unknown";

      if (authEnabled && token !== secret) {
        this.logger?.warn({ remoteAddress }, "Rejected dashboard websocket: unauthorized token");
        ws.close(4001, "Unauthorized");
        return;
      }

      const client: ClientInfo = { ws };
      this.clients.add(client);
      this.logger?.info({ remoteAddress, clients: this.clients.size }, "Dashboard websocket connected");
      this.onClientConnected((event, payload) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: event, ...payload }));
      });

      ws.on("close", (code, reason) => {
        this.clients.delete(client);
        this.logger?.info(
          { remoteAddress, code, reason: reason.toString(), clients: this.clients.size },
          "Dashboard websocket closed"
        );
      });
      ws.on("error", (err) => {
        this.clients.delete(client);
        this.logger?.warn({ remoteAddress, error: err.message, clients: this.clients.size }, "Dashboard websocket error");
      });

      ws.on("message", (data) => {
        const raw = data.toString();
        try {
          const msg = JSON.parse(raw);
          try {
            this.onMessage(msg);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger?.error({ remoteAddress, error: message }, "Failed handling dashboard websocket message");
          }
        } catch {
          this.logger?.warn({ remoteAddress, rawPreview: raw.slice(0, 200) }, "Ignored malformed dashboard websocket message");
        }
      });
    });
  }

  broadcast(event: string, payload: Record<string, any>): void {
    this.logger?.debug({ event, clients: this.clients.size }, "Broadcasting websocket event");
    const data = JSON.stringify({ type: event, ...payload });
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  close(): void {
    this.wss.close();
  }
}
