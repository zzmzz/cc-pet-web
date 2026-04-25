import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BridgeManager } from "../bridge/manager.js";
import type { MessageStore } from "../storage/messages.js";
import type { ReplyCollector } from "../siri/reply-collector.js";
import type { AuthIdentity } from "../auth/token-auth.js";
import { wrapWithVoicePrompt } from "../siri/voice-prompt.js";

const MAX_ACTIVE_COLLECTORS = 5;

interface SiriDeps {
  bridgeManager: BridgeManager;
  messageStore: MessageStore;
  replyCollector: ReplyCollector;
  getAuthIdentity: (req: FastifyRequest) => AuthIdentity | null;
  getDefaultConnectionId: (bridgeIds: Set<string>) => string | undefined;
}

export function registerSiriRoutes(app: FastifyInstance, deps: SiriDeps): void {
  const { bridgeManager, messageStore, replyCollector, getAuthIdentity, getDefaultConnectionId } = deps;

  app.post<{ Body: { content: string; connectionId?: string; sessionKey?: string } }>(
    "/api/siri/send",
    async (req, reply) => {
      const auth = getAuthIdentity(req);
      if (!auth) return reply.code(401).send({ error: "Unauthorized" });

      const { content, sessionKey = "default" } = req.body;
      const connectionId = req.body.connectionId || getDefaultConnectionId(auth.bridgeIds);

      if (!content || content.trim().length === 0) {
        return reply.code(400).send({ error: "content is required" });
      }

      if (!connectionId || !auth.bridgeIds.has(connectionId)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      if (replyCollector.activeCount >= MAX_ACTIVE_COLLECTORS) {
        return reply.code(429).send({ error: "Too many active requests" });
      }

      let msgId: string;
      try {
        msgId = replyCollector.create(connectionId, sessionKey);
      } catch {
        return reply.code(409).send({ error: "Session already has an active request" });
      }

      messageStore.save({
        id: msgId,
        role: "user",
        content,
        timestamp: Date.now(),
        connectionId,
        sessionKey,
      });

      bridgeManager.send(connectionId, {
        type: "message",
        msg_id: msgId,
        session_key: sessionKey,
        user_id: connectionId,
        user_name: "siri",
        reply_ctx: sessionKey,
        content: wrapWithVoicePrompt(content),
      });

      return { msgId, connectionId, sessionKey };
    },
  );

  app.get<{ Querystring: { msgId?: string } }>(
    "/api/siri/poll",
    async (req, reply) => {
      const auth = getAuthIdentity(req);
      if (!auth) return reply.code(401).send({ error: "Unauthorized" });

      const { msgId } = req.query;
      if (!msgId) return reply.code(400).send({ error: "msgId is required" });

      const result = replyCollector.poll(msgId);
      if (!result) return reply.code(404).send({ error: "Unknown msgId" });

      return result;
    },
  );
}
