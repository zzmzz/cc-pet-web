import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { WS_EVENTS } from "@cc-pet/shared";
import type { BridgeManager } from "../bridge/manager.js";
import type { MessageStore } from "../storage/messages.js";
import type { SessionStore } from "../storage/sessions.js";

/** 后台往会话里发消息的上限，防止误把整份文件塞进来 */
const MAX_CONTENT = 8000;
const CHILD_KEY = /^(item|task)-[1-9]\d*$/;

export interface AssistantInternalDeps {
  /** 环境变量 ASSISTANT_INTERNAL_TOKEN；没配时整个接口返回 404 */
  token: string | undefined;
  /** 助手令牌（ui: "assistant"）的常驻会话，key 已规范化；没配就是 undefined */
  getResident: () => { connectionId: string; key: string } | undefined;
  sessionStore: Pick<SessionStore, "exists" | "create">;
  messageStore: Pick<MessageStore, "saveWithStatus">;
  bridgeManager: Pick<BridgeManager, "send">;
  broadcast: (event: string, payload: Record<string, unknown>) => void;
  onUserSend?: (connectionId: string, sessionKey: string) => void;
}

function tokenMatches(expected: string, got: unknown): boolean {
  if (typeof got !== "string") return false;
  // 先各自取摘要再比，长度不同也不会提前返回
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * 给助手后台用的内部接口，挂在 /api/ 之外，不走面板令牌，靠 X-Assistant-Token 自己校验。
 * 后台用它往常驻会话或事项子会话里发一条消息，效果和用户在网页上发的一样。
 */
export function registerAssistantInternalRoutes(app: FastifyInstance, deps: AssistantInternalDeps): void {
  app.post<{ Body: { sessionKey?: unknown; content?: unknown; label?: unknown } }>(
    "/internal/assistant/send",
    async (req, reply) => {
      const expected = deps.token;
      if (!expected) return reply.code(404).send({ error: "Not Found" });
      if (!tokenMatches(expected, req.headers["x-assistant-token"])) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const resident = deps.getResident();
      if (!resident) return reply.code(503).send({ error: "没有配置助手的常驻会话" });

      const { sessionKey, content, label } = req.body ?? {};
      if (typeof sessionKey !== "string" || (sessionKey !== resident.key && !CHILD_KEY.test(sessionKey))) {
        return reply.code(400).send({ error: "Invalid sessionKey" });
      }
      if (typeof content !== "string" || content.trim().length === 0 || content.length > MAX_CONTENT) {
        return reply.code(400).send({ error: "Invalid content" });
      }
      const connectionId = resident.connectionId;

      if (!deps.sessionStore.exists(connectionId, sessionKey)) {
        const now = Date.now();
        deps.sessionStore.create({
          key: sessionKey,
          connectionId,
          label: typeof label === "string" && label.trim() ? label.trim() : undefined,
          createdAt: now,
          lastActiveAt: now,
        });
      }

      const msgId = `assistant-auto-${randomUUID()}`;
      deps.messageStore.saveWithStatus({
        id: msgId,
        role: "user",
        content,
        timestamp: Date.now(),
        connectionId,
        sessionKey,
      });
      deps.bridgeManager.send(connectionId, {
        type: "message",
        msg_id: msgId,
        session_key: sessionKey,
        user_id: connectionId,
        user_name: "assistant-automation",
        reply_ctx: sessionKey,
        content,
      });
      deps.onUserSend?.(connectionId, sessionKey);
      deps.broadcast(WS_EVENTS.ASSISTANT_SESSION_UPDATED, { connectionId, sessionKey });
      req.log.info({ connectionId, sessionKey, contentLength: content.length }, "Assistant backend sent message");
      return { ok: true, sessionKey };
    },
  );
}
