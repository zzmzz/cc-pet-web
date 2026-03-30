import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

interface ClientInfo {
  ws: WebSocket;
}

export class ClientHub {
  private wss: WebSocketServer;
  private clients = new Set<ClientInfo>();

  onMessage: (msg: any) => void = () => {};

  constructor(server: Server, secret: string) {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const token = url.searchParams.get("token");

      if (token !== secret) {
        ws.close(4001, "Unauthorized");
        return;
      }

      const client: ClientInfo = { ws };
      this.clients.add(client);

      ws.on("close", () => this.clients.delete(client));
      ws.on("error", () => this.clients.delete(client));

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.onMessage(msg);
        } catch { /* ignore malformed */ }
      });
    });
  }

  broadcast(event: string, payload: Record<string, any>): void {
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
