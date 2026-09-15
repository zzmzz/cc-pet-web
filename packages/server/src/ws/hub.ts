import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { findTokenIdentity, type AuthIdentity } from "../auth/token-auth.js";
import type { TokenConfig } from "@cc-pet/shared";

interface ClientInfo {
  ws: WebSocket;
  remoteAddress: string;
  auth: AuthIdentity;
}

interface HubLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
  debug: (obj: Record<string, unknown>, msg?: string) => void;
}

/** Max size of a single inbound dashboard WebSocket frame. */
export const DASHBOARD_WS_MAX_PAYLOAD = 100 * 1024 * 1024;

/**
 * Largest raw file that still fits the base64 fallback path: base64 inflates by 4/3 and
 * the JSON envelope adds a little more, so leave a margin under the frame cap.
 */
export const WS_FALLBACK_MAX_FILE_BYTES = Math.floor((DASHBOARD_WS_MAX_PAYLOAD * 3) / 4) - 1024 * 1024;

export class ClientHub {
  private wss: WebSocketServer;
  private clients = new Set<ClientInfo>();
  private logger?: HubLogger;

  onMessage: (msg: any, client: ClientInfo) => void = () => {};
  onClientConnected: (client: ClientInfo, send: (event: string, payload: Record<string, any>) => void) => void = () => {};

  constructor(server: Server, tokens: TokenConfig[], logger?: HubLogger) {
    // Explicit, not inherited: `ws` silently defaults to 100 MiB, and a frame over the
    // limit is dropped with the connection closed — which used to lose whole chat
    // messages with no client-visible error. Chat attachments no longer travel through
    // here (they stream to disk via POST /api/attachments/:connectionId), so this only
    // needs to fit control frames and the base64 fallback for workspace-less bridges.
    // Keep DASHBOARD_WS_MAX_PAYLOAD in sync with the client-side pre-send check.
    this.wss = new WebSocketServer({ server, path: "/ws", maxPayload: DASHBOARD_WS_MAX_PAYLOAD });
    this.logger = logger;

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const token = url.searchParams.get("token");
      const remoteAddress = req.socket.remoteAddress ?? "unknown";
      const identity = findTokenIdentity(tokens, token);

      if (!identity) {
        this.logger?.warn({ remoteAddress }, "Rejected dashboard websocket: unauthorized token");
        ws.close(4001, "Unauthorized");
        return;
      }

      const client: ClientInfo = { ws, remoteAddress, auth: identity };
      this.clients.add(client);
      this.logger?.info(
        { remoteAddress, tokenName: identity.tokenName, clients: this.clients.size },
        "Dashboard websocket connected",
      );
      this.onClientConnected(client, (event, payload) => {
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
            this.onMessage(msg, client);
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
    const connectionId = typeof payload.connectionId === "string" ? payload.connectionId : null;
    for (const client of this.clients) {
      if (connectionId && !client.auth.bridgeIds.has(connectionId)) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  close(): void {
    this.wss.close();
  }
}
