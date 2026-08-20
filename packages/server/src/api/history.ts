import type { FastifyInstance } from "fastify";
import type { MessageStore } from "../storage/messages.js";

export function registerHistoryRoutes(app: FastifyInstance, store: MessageStore) {
  app.get<{
    Params: { chatKey: string };
    Querystring: { afterSeq?: string; limit?: string };
  }>("/api/history/:chatKey", async (req) => {
    const chatKey = decodeURIComponent(req.params.chatKey);
    if (req.query.afterSeq === undefined) {
      return { messages: store.getByChatKey(chatKey) };
    }
    const afterSeq = Number(req.query.afterSeq);
    const limit = Number(req.query.limit ?? 200);
    if (!Number.isFinite(afterSeq) || !Number.isFinite(limit) || limit <= 0) {
      return { messages: store.getByChatKey(chatKey) };
    }
    return store.getByChatKeyAfterSeq(chatKey, afterSeq, Math.min(limit, 500));
  });

  app.delete<{ Params: { chatKey: string } }>("/api/history/:chatKey", async (req) => {
    store.deleteByChatKey(decodeURIComponent(req.params.chatKey));
    return { ok: true };
  });
}
