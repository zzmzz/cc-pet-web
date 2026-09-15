import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PushSubscriptionStore } from "../storage/push-subscriptions.js";
import type { WebPushService } from "../push/web-push-service.js";
import type { AuthIdentity } from "../auth/token-auth.js";

export interface PushRoutesDeps {
  store: PushSubscriptionStore;
  webPush: WebPushService;
  getAuthIdentity: (req: FastifyRequest) => AuthIdentity | null;
}

interface SubscribeBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

export function registerPushRoutes(app: FastifyInstance, deps: PushRoutesDeps): void {
  const { store, webPush, getAuthIdentity } = deps;

  app.get("/api/push/vapid-public-key", async () => ({ publicKey: webPush.publicKey() }));

  app.post<{ Body: SubscribeBody }>("/api/push/subscribe", async (req, reply) => {
    const auth = getAuthIdentity(req);
    if (!auth) return reply.code(401).send({ error: "Unauthorized" });
    const { endpoint, keys } = req.body ?? {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return reply.code(400).send({ error: "Invalid subscription" });
    }
    store.upsert({ tokenName: auth.tokenName, endpoint, p256dh: keys.p256dh, auth: keys.auth });
    return { ok: true };
  });

  app.post<{ Body: { endpoint?: string } }>("/api/push/unsubscribe", async (req, reply) => {
    const auth = getAuthIdentity(req);
    if (!auth) return reply.code(401).send({ error: "Unauthorized" });
    const endpoint = req.body?.endpoint;
    if (!endpoint) return reply.code(400).send({ error: "endpoint is required" });
    store.deleteByEndpoint(endpoint, auth.tokenName);
    return { ok: true };
  });
}
