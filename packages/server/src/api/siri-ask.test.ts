import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerSiriAskRoute } from "./siri-ask.js";
import { AskTaskStore } from "../siri/ask-tasks.js";

const runClaude = vi.hoisted(() => vi.fn());
vi.mock("../siri/claude-runner.js", () => ({ runClaude }));

function ok(text: string) {
  return { text, stderr: "", exitCode: 0, timedOut: false, truncated: false };
}
const TIMED_OUT = { text: "", stderr: "", exitCode: null, timedOut: true, truncated: false };

function buildApp(
  options: { residentPairs?: unknown[]; bridgeIds?: string[]; handoffMs?: number } = {},
) {
  const app = Fastify();
  const tasks = new AskTaskStore();

  const mockBridgeManager = { send: vi.fn(), getStatus: vi.fn().mockReturnValue(true) };
  const mockMessageStore = { save: vi.fn() };
  const mockResidentRegistry = {
    pairs: vi.fn().mockReturnValue(
      options.residentPairs ?? [
        { connectionId: "bridge1", key: "bridge1:resident:resident", tokenName: "test" },
      ],
    ),
    isResident: vi.fn().mockReturnValue(true),
  };

  const auth = { tokenName: "test", bridgeIds: new Set(options.bridgeIds ?? ["bridge1"]) };
  app.addHook("onRequest", async (req) => {
    (req as any).__auth = auth;
  });

  registerSiriAskRoute(app, {
    bridgeManager: mockBridgeManager as any,
    messageStore: mockMessageStore as any,
    residentRegistry: mockResidentRegistry as any,
    getAuthIdentity: (req) => (req as any).__auth,
    claude: { bin: "claude", cwd: "/code/hass-agent", model: "claude-haiku-4-5", timeoutMs: 90_000 },
    handoffMs: options.handoffMs ?? 10_000,
    tasks,
  });

  return { app, tasks, mockBridgeManager, mockMessageStore };
}

function ask(app: ReturnType<typeof buildApp>["app"], content: unknown) {
  return app.inject({ method: "POST", url: "/api/siri/ask", payload: { content } });
}
function poll(app: ReturnType<typeof buildApp>["app"], id: string) {
  return app.inject({ method: "GET", url: `/api/siri/ask/poll?id=${encodeURIComponent(id)}` });
}

beforeEach(() => {
  runClaude.mockReset();
});

describe("POST /api/siri/ask", () => {
  it("answers inline when claude finishes before the handoff deadline", async () => {
    runClaude.mockResolvedValue(ok("客厅灯开着。"));
    const { app } = buildApp();
    const res = await ask(app, "客厅灯开着吗");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ttsText: "客厅灯开着。", mode: "direct" });
  });

  it("passes the voice-mode prompt and configured claude options through", async () => {
    runClaude.mockResolvedValue(ok("好了"));
    const { app } = buildApp();
    await ask(app, "开灯");

    const [prompt, opts] = runClaude.mock.calls[0];
    expect(prompt).toContain("[语音模式]");
    expect(prompt).toContain("开灯");
    expect(opts).toMatchObject({ cwd: "/code/hass-agent", model: "claude-haiku-4-5" });
  });

  it("strips markdown so TTS does not read symbols aloud", async () => {
    runClaude.mockResolvedValue(ok("**客厅** 26 度\n\n- 湿度 54%"));
    const { app } = buildApp();
    const { ttsText } = (await ask(app, "温度")).json();
    expect(ttsText).not.toContain("**");
    expect(ttsText).not.toMatch(/^- /m);
    expect(ttsText).toContain("客厅");
  });

  it("rejects empty content", async () => {
    const { app } = buildApp();
    expect((await ask(app, "   ")).statusCode).toBe(400);
    expect(runClaude).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests on both routes", async () => {
    const app = Fastify();
    registerSiriAskRoute(app, {
      bridgeManager: { send: vi.fn() } as any,
      messageStore: { save: vi.fn() } as any,
      residentRegistry: { pairs: () => [] } as any,
      getAuthIdentity: () => null,
      claude: { bin: "claude", cwd: "/tmp", model: "m", timeoutMs: 1000 },
      handoffMs: 10,
    });
    expect((await app.inject({ method: "POST", url: "/api/siri/ask", payload: { content: "hi" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/siri/ask/poll?id=x" })).statusCode).toBe(401);
    expect(runClaude).not.toHaveBeenCalled();
  });

  // 这是 poll 机制存在的理由：iOS 的「获取 URL 内容」超过 25 秒报错，而实测一轮
  // 家居查询要 15～25 秒，所以慢的活必须改成轮询，不能同步等到底。
  describe("when claude is slower than the handoff deadline", () => {
    it("returns a pollId instead of blocking, then serves the result via poll", async () => {
      let finish!: (v: unknown) => void;
      runClaude.mockImplementation(() => new Promise((r) => { finish = r; }));

      const { app } = buildApp({ handoffMs: 20 });
      const body = (await ask(app, "把所有容器都查一遍")).json();

      expect(body.mode).toBe("pending");
      expect(body.pollId).toBeTruthy();
      expect(body.ttsText).toBeTruthy(); // 让 Siri 当场有话可说

      // 还在跑时 poll 只报 running，不给 ttsText
      const midway = (await poll(app, body.pollId)).json();
      expect(midway.status).toBe("running");
      expect(midway.ttsText).toBeUndefined();

      finish(ok("查完了，都正常。"));
      await vi.waitFor(async () => {
        const done = (await poll(app, body.pollId)).json();
        expect(done.status).toBe("done");
        expect(done.ttsText).toBe("查完了，都正常。");
      });
    });

    it("frees the inflight slot once the background run settles", async () => {
      let finish!: (v: unknown) => void;
      runClaude.mockImplementation(() => new Promise((r) => { finish = r; }));
      const { app } = buildApp({ handoffMs: 10 });

      for (const q of ["1", "2", "3"]) await ask(app, q);
      expect((await ask(app, "4")).statusCode).toBe(429);

      finish(ok("done"));
      await vi.waitFor(async () => {
        expect((await ask(app, "5")).statusCode).not.toBe(429);
      });
    });
  });

  it("returns 404 for an unknown poll id", async () => {
    const { app } = buildApp();
    expect((await poll(app, "nope")).statusCode).toBe(404);
  });

  describe("on total timeout", () => {
    it("hands the task to the resident session", async () => {
      runClaude.mockResolvedValue(TIMED_OUT);
      const { app, mockBridgeManager, mockMessageStore } = buildApp();
      const res = await ask(app, "把所有容器都查一遍");

      expect(res.json().mode).toBe("delegated");
      expect(res.json().ttsText).toContain("第二大脑");

      // 转交必须同时落库，否则用户在面板上看不到这轮
      expect(mockMessageStore.save).toHaveBeenCalledOnce();
      expect(mockBridgeManager.send).toHaveBeenCalledOnce();

      const sent = mockBridgeManager.send.mock.calls[0][1];
      expect(sent.session_key).toBe("bridge1:resident:resident");
      expect(sent.content).toContain("把所有容器都查一遍");
      expect(sent.content).toContain("Siri 转交");
      // 结果在网页上看，不该再套语音那套长度限制
      expect(sent.content).not.toContain("[语音模式]");
    });

    it("does not hand off to a resident session the token cannot access", async () => {
      runClaude.mockResolvedValue(TIMED_OUT);
      const { app, mockBridgeManager } = buildApp({
        residentPairs: [{ connectionId: "other", key: "other:resident:resident", tokenName: "someone-else" }],
        bridgeIds: ["bridge1"],
      });
      expect((await ask(app, "干活")).statusCode).toBe(500);
      expect(mockBridgeManager.send).not.toHaveBeenCalled();
    });
  });

  describe("on failure", () => {
    it("reports a missing claude binary without falling back to the bridge", async () => {
      runClaude.mockResolvedValue({
        text: "", stderr: "spawn claude ENOENT", exitCode: null, timedOut: false,
        truncated: false, errorCode: "ENOENT",
      });
      const { app, mockBridgeManager } = buildApp();
      const res = await ask(app, "开灯");

      expect(res.statusCode).toBe(500);
      expect(res.json().mode).toBe("error");
      // 明确要求：spawn 失败不做 bridge 降级
      expect(mockBridgeManager.send).not.toHaveBeenCalled();
    });

    it("reports a non-zero exit", async () => {
      runClaude.mockResolvedValue({ text: "", stderr: "boom", exitCode: 1, timedOut: false, truncated: false });
      const { app } = buildApp();
      expect((await ask(app, "开灯")).statusCode).toBe(500);
    });

    it("survives a rejected run instead of hanging the request", async () => {
      runClaude.mockRejectedValue(new Error("boom"));
      const { app } = buildApp();
      const res = await ask(app, "开灯");
      expect(res.statusCode).toBe(500);
      expect(res.json().mode).toBe("error");
    });

    it("still says something when claude exits cleanly but prints nothing", async () => {
      runClaude.mockResolvedValue(ok(""));
      const { app } = buildApp();
      const { ttsText, mode } = (await ask(app, "开灯")).json();
      expect(mode).toBe("direct");
      expect(ttsText.length).toBeGreaterThan(0);
    });
  });
});
