import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "@cc-pet/shared";
import type { ConfigStore } from "../storage/config.js";
import type { AuthIdentity } from "../auth/token-auth.js";

export function registerConfigRoutes(
  app: FastifyInstance,
  store: ConfigStore,
  getAuthIdentity?: (req: FastifyRequest) => AuthIdentity | null,
) {
  // 助手模式的令牌只用助手页面，且整份配置里有其他令牌的信息
  const isAssistant = (req: FastifyRequest) => getAuthIdentity?.(req)?.ui === "assistant";

  app.get("/api/config", async (req, reply) => {
    if (isAssistant(req)) return reply.code(403).send({ error: "Forbidden" });
    return store.load();
  });

  app.put<{ Body: AppConfig }>("/api/config", async (req, reply) => {
    if (isAssistant(req)) return reply.code(403).send({ error: "Forbidden" });
    store.save(req.body);
    return { ok: true };
  });
}
