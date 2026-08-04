import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BridgeManager } from "../bridge/manager.js";
import type { MessageStore } from "../storage/messages.js";
import type { AuthIdentity } from "../auth/token-auth.js";
import type { ResidentRegistry } from "../resident/registry.js";
import { wrapWithVoicePrompt } from "../siri/voice-prompt.js";
import { sanitizeForTts } from "../siri/tts-sanitizer.js";
import { runClaude, type ClaudeRunOptions } from "../siri/claude-runner.js";

/** Siri 连点或快捷指令重试时别把机器打满 */
const MAX_INFLIGHT = 3;

const TTS_DELEGATED = "这活儿有点大，我交给第二大脑了，完事你在面板上看。";
const TTS_NO_RESIDENT = "这活儿超过二十秒了，但我没找到能接手的常驻会话。";
const TTS_UNAVAILABLE = "助手起不来，检查一下 claude 装没装。";
const TTS_FAILED = "出错了，没办好。";
const TTS_EMPTY = "办完了，但它没说话。";

export interface SiriAskDeps {
  bridgeManager: BridgeManager;
  messageStore: MessageStore;
  residentRegistry: ResidentRegistry;
  getAuthIdentity: (req: FastifyRequest) => AuthIdentity | null;
  claude: ClaudeRunOptions;
}

type AskMode = "direct" | "delegated" | "timeout" | "error";

interface AskReply {
  ttsText: string;
  mode: AskMode;
}

/**
 * 把这一轮交给常驻会话（「第二大脑」）接着干。
 *
 * 注意这是**超时转交**，不是 spawn 失败时的降级 —— claude 起不来就直接报错，
 * 不偷偷改走 bridge。
 */
function delegateToResident(deps: SiriAskDeps, auth: AuthIdentity, content: string): boolean {
  const pairs = deps.residentRegistry.pairs();
  // 优先用这个 token 自己的常驻会话；没有就退到它有权访问的任一条
  const pair =
    pairs.find((p) => p.tokenName === auth.tokenName && auth.bridgeIds.has(p.connectionId)) ??
    pairs.find((p) => auth.bridgeIds.has(p.connectionId));
  if (!pair) return false;

  const msgId = `siri-ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // 告诉第二大脑这是从哪来的、以及不必再守语音那套长度限制（结果是在网页上看的）
  const handoff =
    "[Siri 转交] 下面这个请求我在语音通道里 20 秒没做完，交给你接着干。" +
    "用户是语音提的，但结果他会在面板上看，所以不用管长度限制，正常回答就行。\n\n" +
    content;

  deps.messageStore.save({
    id: msgId,
    role: "user",
    content: handoff,
    timestamp: Date.now(),
    connectionId: pair.connectionId,
    sessionKey: pair.key,
  });

  deps.bridgeManager.send(pair.connectionId, {
    type: "message",
    msg_id: msgId,
    session_key: pair.key,
    user_id: pair.connectionId,
    user_name: "siri",
    reply_ctx: pair.key,
    content: handoff,
  });

  return true;
}

export function registerSiriAskRoute(app: FastifyInstance, deps: SiriAskDeps): void {
  let inflight = 0;

  app.post<{ Body: { content?: string } }>("/api/siri/ask", async (req, reply) => {
    const auth = deps.getAuthIdentity(req);
    if (!auth) return reply.code(401).send({ error: "Unauthorized" });

    const content = req.body?.content?.trim();
    if (!content) return reply.code(400).send({ error: "content is required" });

    if (inflight >= MAX_INFLIGHT) {
      return reply.code(429).send({ error: "Too many active requests" });
    }

    inflight += 1;
    try {
      const result = await runClaude(wrapWithVoicePrompt(content), deps.claude);

      if (result.timedOut) {
        const handed = delegateToResident(deps, auth, content);
        app.log.info({ content, handed }, "siri/ask timed out");
        const body: AskReply = handed
          ? { ttsText: TTS_DELEGATED, mode: "delegated" }
          : { ttsText: TTS_NO_RESIDENT, mode: "timeout" };
        return body;
      }

      // spawn 找不到二进制时 Node 把 "spawn claude ENOENT" 灌进 error.message，
      // 所以 ENOENT 必须先于 stderr 判断，否则返回的是迷惑的 Node 错误。
      if (result.errorCode === "ENOENT") {
        app.log.error({ bin: deps.claude.bin }, "siri/ask: claude executable not found");
        return reply.code(500).send({ error: "claude executable not available", ttsText: TTS_UNAVAILABLE, mode: "error" });
      }
      if (result.errorCode || result.exitCode !== 0) {
        app.log.error(
          { errorCode: result.errorCode, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
          "siri/ask: claude failed",
        );
        return reply.code(500).send({ error: "claude run failed", ttsText: TTS_FAILED, mode: "error" });
      }

      const ttsText = sanitizeForTts(result.text);
      const body: AskReply = { ttsText: ttsText || TTS_EMPTY, mode: "direct" };
      return body;
    } finally {
      inflight -= 1;
    }
  });
}
