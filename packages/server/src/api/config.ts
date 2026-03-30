import type { FastifyInstance } from "fastify";
import type { ConfigStore } from "../storage/config.js";

export function registerConfigRoutes(app: FastifyInstance, store: ConfigStore) {
  app.get("/api/config", async () => store.load());

  app.put<{ Body: any }>("/api/config", async (req) => {
    store.save(req.body);
    return { ok: true };
  });
}
