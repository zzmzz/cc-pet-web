import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BridgeManager } from "../bridge/manager.js";
import type { MessageStore } from "../storage/messages.js";
import type { AuthIdentity } from "../auth/token-auth.js";
import type { ResidentRegistry } from "../resident/registry.js";
import { wrapWithVoicePrompt } from "../siri/voice-prompt.js";
import { sanitizeForTts } from "../siri/tts-sanitizer.js";
import { runClaude, type ClaudeRunOptions } from "../siri/claude-runner.js";
import { AskTaskStore } from "../siri/ask-tasks.js";

/** Siri 连点或快捷指令重试时别把机器打满 */
const MAX_INFLIGHT = 3;

/** poll 的长轮询上限。压在 iOS「获取 URL 内容」那 25 秒之下，留足网络余量。 */
const MAX_POLL_WAIT_MS = 15_000;
const POLL_TICK_MS = 200;

const TTS_PENDING = "在办，稍等。";
const TTS_DELEGATED = "这活儿有点大，我交给第二大脑了，完事你在面板上看。";
const TTS_NO_RESIDENT = "这活儿太大了我没办完，也没找到能接手的常驻会话。";
const TTS_UNAVAILABLE = "助手起不来，检查一下 claude 装没装。";
const TTS_FAILED = "出错了，没办好。";
const TTS_EMPTY = "办完了，但它没说话。";

export interface SiriAskDeps {
  bridgeManager: BridgeManager;
  messageStore: MessageStore;
  residentRegistry: ResidentRegistry;
  getAuthIdentity: (req: FastifyRequest) => AuthIdentity | null;
  claude: ClaudeRunOptions;
  /** 同步等多久还没出结果就改发 pollId。必须显著小于 iOS 的 25 秒上限。 */
  handoffMs: number;
  tasks?: AskTaskStore;
}

type AskMode = "direct" | "pending" | "delegated" | "error";

/**
 * 把这一轮交给常驻会话（「第二大脑」）接着干。
 *
 * 这是**超时转交**，不是 spawn 失败时的降级 —— claude 起不来就直接报错，
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
  // 告诉第二大脑这是从哪来的，以及不必再守语音那套长度限制（结果是在网页上看的）
  const handoff =
    "[Siri 转交] 下面这个请求我在语音通道里没做完，交给你接着干。" +
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
  const tasks = deps.tasks ?? new AskTaskStore();
  let inflight = 0;

  app.post<{ Body: { content?: string } }>("/api/siri/ask", async (req, reply) => {
    const auth = deps.getAuthIdentity(req);
    if (!auth) return reply.code(401).send({ error: "Unauthorized" });

    const content = req.body?.content?.trim();
    if (!content) return reply.code(400).send({ error: "content is required" });

    if (inflight >= MAX_INFLIGHT) {
      return reply.code(429).send({ error: "Too many active requests" });
    }

    const taskId = tasks.create();
    inflight += 1;

    // 故意不 await 到底：下面只等 handoffMs，剩下的让它在后台跑完并写进任务表。
    const running = runClaude(wrapWithVoicePrompt(content), deps.claude)
      .then((result) => {
        if (result.timedOut) {
          const handed = delegateToResident(deps, auth, content);
          app.log.info({ taskId, handed }, "siri/ask exceeded total timeout");
          tasks.finish(taskId, handed ? "delegated" : "error", handed ? TTS_DELEGATED : TTS_NO_RESIDENT);
          return;
        }
        // spawn 找不到二进制时 Node 把 "spawn claude ENOENT" 灌进 error.message，
        // 所以 ENOENT 必须先于 stderr 判断，否则记下来的是迷惑的 Node 错误。
        if (result.errorCode === "ENOENT") {
          app.log.error({ taskId, bin: deps.claude.bin }, "siri/ask: claude executable not found");
          tasks.finish(taskId, "error", TTS_UNAVAILABLE);
          return;
        }
        if (result.errorCode || result.exitCode !== 0) {
          app.log.error(
            { taskId, errorCode: result.errorCode, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
            "siri/ask: claude failed",
          );
          tasks.finish(taskId, "error", TTS_FAILED);
          return;
        }
        tasks.finish(taskId, "done", sanitizeForTts(result.text) || TTS_EMPTY);
      })
      .catch((err: unknown) => {
        app.log.error({ taskId, err }, "siri/ask: unexpected failure");
        tasks.finish(taskId, "error", TTS_FAILED);
      })
      .finally(() => {
        inflight -= 1;
      });

    // 快的活当场答完，慢的活发个 id 让快捷指令来轮询 —— iOS 的「获取 URL 内容」
    // 超过 25 秒就报错，而实测一轮家居查询要 15～25 秒，同步等到底会随机失败。
    const HANDED_OFF = Symbol("handoff");
    const raced = await Promise.race([
      running.then(() => tasks.get(taskId)),
      new Promise<typeof HANDED_OFF>((resolve) => {
        const t = setTimeout(() => resolve(HANDED_OFF), deps.handoffMs);
        t.unref?.();
      }),
    ]);

    if (raced === HANDED_OFF) {
      return { pollId: taskId, ttsText: TTS_PENDING, mode: "pending" satisfies AskMode };
    }

    const done = raced as ReturnType<AskTaskStore["get"]>;
    if (done?.status === "error") {
      return reply.code(500).send({ error: "claude run failed", ttsText: done.ttsText, mode: "error" });
    }
    return {
      ttsText: done?.ttsText ?? TTS_EMPTY,
      mode: (done?.status === "delegated" ? "delegated" : "direct") satisfies AskMode,
    };
  });

  app.get<{ Querystring: { id?: string; wait?: string } }>("/api/siri/ask/poll", async (req, reply) => {
    const auth = deps.getAuthIdentity(req);
    if (!auth) return reply.code(401).send({ error: "Unauthorized" });

    const id = req.query.id;
    if (!id) return reply.code(400).send({ error: "id is required" });

    let task = tasks.get(id);
    if (!task) return reply.code(404).send({ error: "Unknown id" });

    // 长轮询：iOS 快捷指令的「重复」没有 break，纯短轮询要写成「循环 15 次 + 里面
    // 套两层如果」才不空等。让服务端 hold 住请求，快捷指令就只需重复三四次，
    // 且结果出来后剩下几次是秒回。上限压在 iOS 那 25 秒之下。
    const waitMs = Math.min(Math.max(Number(req.query.wait ?? 0), 0) * 1000, MAX_POLL_WAIT_MS);
    if (waitMs > 0 && task.status === "running") {
      const deadline = Date.now() + waitMs;
      while (task?.status === "running" && Date.now() < deadline) {
        await new Promise((r) => {
          const t = setTimeout(r, POLL_TICK_MS);
          t.unref?.();
        });
        task = tasks.get(id);
      }
      if (!task) return reply.code(404).send({ error: "Unknown id" });
    }

    // 还在跑就只回 status，让快捷指令再来一次
    if (task.status === "running") return { status: "running", mode: "pending" satisfies AskMode };
    return {
      status: task.status,
      ttsText: task.ttsText,
      mode: (task.status === "done" ? "direct" : task.status) satisfies AskMode,
    };
  });
}
