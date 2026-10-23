import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { WS_EVENTS } from "@cc-pet/shared";
import type { BridgeManager } from "../bridge/manager.js";
import type { MessageStore } from "../storage/messages.js";
import type { SessionStore } from "../storage/sessions.js";

/** 后台往会话里发消息的上限，防止误把整份文件塞进来 */
const MAX_CONTENT = 8000;
const CHILD_KEY = /^(item|task)-[1-9]\d*$/;
/** 新建子会话时的标题上限；key 本身已由 CHILD_KEY 卡住格式，这里再兜一道长度 */
const MAX_LABEL = 200;
const MAX_KEY = 64;

export interface AssistantInternalDeps {
  /** 环境变量 ASSISTANT_INTERNAL_TOKEN；没配时整个接口返回 404 */
  token: string | undefined;
  /** 助手令牌（ui: "assistant"）的常驻会话，key 已规范化；没配就是 undefined */
  getResident: () => { connectionId: string; key: string } | undefined;
  sessionStore: Pick<SessionStore, "createIfMissing">;
  messageStore: Pick<MessageStore, "saveWithStatus">;
  bridgeManager: Pick<BridgeManager, "send">;
  broadcast: (event: string, payload: Record<string, unknown>) => void;
  /** 给 ui: "assistant" 那个令牌的订阅发网页推送；没配就不推 */
  pushToAssistant?: (payload: AssistantPush) => unknown;
}

export interface AssistantPush {
  title: string;
  body: string;
  /** 同一个子会话的推送互相替换，不同子会话的各留一条 */
  tag: string;
  /** 点开推送时进入这个会话 */
  data: { connectionId: string; sessionKey: string };
}

const NOTIFY_EVENTS: readonly string[] = ["progress", "done", "stuck"];
/** 推送正文上限，太长手机上也看不全 */
const MAX_PUSH_BODY = 200;

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
 * 只有一点不同：不记成「用户刚发过话」，助手随后的回复仍算主动消息，照常走 Web Push。
 */
function validKey(sessionKey: unknown, residentKey: string): sessionKey is string {
  return (
    typeof sessionKey === "string" &&
    sessionKey.length <= MAX_KEY &&
    (sessionKey === residentKey || CHILD_KEY.test(sessionKey))
  );
}

function clip(text: string, max: number): string {
  return [...text].slice(0, max).join("");
}

export function registerAssistantInternalRoutes(app: FastifyInstance, deps: AssistantInternalDeps): void {
  /** 两个接口共用的令牌和常驻会话检查；返回 undefined 表示已回复错误 */
  function authorize(
    req: { headers: Record<string, unknown> },
    reply: FastifyReply,
  ): { connectionId: string; key: string } | undefined {
    const expected = deps.token;
    if (!expected) {
      void reply.code(404).send({ error: "Not Found" });
      return undefined;
    }
    if (!tokenMatches(expected, req.headers["x-assistant-token"])) {
      void reply.code(401).send({ error: "Unauthorized" });
      return undefined;
    }
    const resident = deps.getResident();
    if (!resident) {
      void reply.code(503).send({ error: "没有配置助手的常驻会话" });
      return undefined;
    }
    return resident;
  }

  app.post<{ Body: { sessionKey?: unknown; content?: unknown; label?: unknown } }>(
    "/internal/assistant/send",
    async (req, reply) => {
      const resident = authorize(req, reply);
      if (!resident) return reply;

      const { sessionKey, content, label } = req.body ?? {};
      if (!validKey(sessionKey, resident.key)) {
        return reply.code(400).send({ error: "Invalid sessionKey" });
      }
      if (typeof content !== "string" || content.trim().length === 0 || [...content].length > MAX_CONTENT) {
        return reply.code(400).send({ error: "Invalid content" });
      }
      const connectionId = resident.connectionId;

      const now = Date.now();
      const trimmed = typeof label === "string" ? clip(label.trim(), MAX_LABEL) : "";
      // 已有会话（含它的标题）原样保留
      deps.sessionStore.createIfMissing({
        key: sessionKey,
        connectionId,
        label: trimmed || undefined,
        createdAt: now,
        lastActiveAt: now,
      });

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
      deps.broadcast(WS_EVENTS.ASSISTANT_SESSION_UPDATED, { connectionId, sessionKey });
      req.log.info({ connectionId, sessionKey, contentLength: content.length }, "Assistant backend sent message");
      return { ok: true, sessionKey };
    },
  );
  /**
   * 后台报子会话进度用：progress、done、stuck。页面收到广播就刷新进度栏；
   * done 和 stuck 另外给助手令牌发一条网页推送，点开进那个子会话。推送失败只记日志。
   */
  app.post<{ Body: { sessionKey?: unknown; event?: unknown; title?: unknown; text?: unknown } }>(
    "/internal/assistant/notify",
    async (req, reply) => {
      const resident = authorize(req, reply);
      if (!resident) return reply;

      const { sessionKey, event, title, text } = req.body ?? {};
      if (!validKey(sessionKey, resident.key)) {
        return reply.code(400).send({ error: "Invalid sessionKey" });
      }
      if (typeof event !== "string" || !NOTIFY_EVENTS.includes(event)) {
        return reply.code(400).send({ error: "Invalid event" });
      }
      if (title !== undefined && typeof title !== "string") {
        return reply.code(400).send({ error: "Invalid title" });
      }
      if (text !== undefined && (typeof text !== "string" || [...text].length > MAX_CONTENT)) {
        return reply.code(400).send({ error: "Invalid text" });
      }
      const connectionId = resident.connectionId;
      deps.broadcast(WS_EVENTS.ASSISTANT_SESSION_UPDATED, { connectionId, sessionKey });

      if ((event === "done" || event === "stuck") && deps.pushToAssistant) {
        const name = clip(title?.trim() || sessionKey, MAX_LABEL);
        const detail = text?.trim() ?? "";
        const body =
          event === "stuck" ? `『${name}』卡住了，去看看` : detail ? `『${name}』做好了：${detail}` : `『${name}』做好了`;
        try {
          void Promise.resolve(
            deps.pushToAssistant({
              title: "蟹哥",
              body: clip(body, MAX_PUSH_BODY),
              tag: `assistant-${sessionKey}`,
              data: { connectionId, sessionKey },
            }),
          ).catch((err: unknown) => req.log.warn({ err, sessionKey }, "Assistant push failed"));
        } catch (err) {
          req.log.warn({ err, sessionKey }, "Assistant push failed");
        }
      }
      req.log.info({ connectionId, sessionKey, event }, "Assistant backend notified");
      return { ok: true };
    },
  );
}
