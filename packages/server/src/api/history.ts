import type { FastifyInstance } from "fastify";
import type { MessageStore } from "../storage/messages.js";

export function registerHistoryRoutes(app: FastifyInstance, store: MessageStore) {
  app.get<{ Params: { chatKey: string } }>("/api/history/:chatKey", async (req) => {
    return { messages: store.getByChatKey(decodeURIComponent(req.params.chatKey)) };
  });

  app.delete<{ Params: { chatKey: string } }>("/api/history/:chatKey", async (req) => {
    store.deleteByChatKey(decodeURIComponent(req.params.chatKey));
    return { ok: true };
  });
}
