import type { FastifyInstance } from "fastify";
import type { SessionStore } from "../storage/sessions.js";

export function registerSessionRoutes(app: FastifyInstance, store: SessionStore) {
  app.get<{ Querystring: { connectionId?: string } }>("/api/sessions", async (req) => {
    const connectionId = req.query.connectionId;
    if (connectionId) {
      return { sessions: store.listByConnection(connectionId) };
    }
    return { sessions: [] };
  });

  app.post<{ Body: { connectionId: string; key: string; label?: string } }>("/api/sessions", async (req) => {
    const { connectionId, key, label } = req.body;
    const now = Date.now();
    store.create({ key, connectionId, label, createdAt: now, lastActiveAt: now });
    return { ok: true };
  });

  app.delete<{ Params: { connectionId: string; key: string } }>("/api/sessions/:connectionId/:key", async (req) => {
    store.delete(req.params.connectionId, req.params.key);
    return { ok: true };
  });
}
