import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerSiriAskRoute } from "./siri-ask.js";

const runClaude = vi.hoisted(() => vi.fn());
vi.mock("../siri/claude-runner.js", () => ({ runClaude }));

function ok(text: string) {
  return { text, stderr: "", exitCode: 0, timedOut: false, truncated: false };
}

function buildApp(options: { residentPairs?: unknown[]; bridgeIds?: string[] } = {}) {
  const app = Fastify();

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
    claude: { bin: "claude", cwd: "/code/hass-agent", model: "claude-haiku-4-5", timeoutMs: 20_000 },
  });

  return { app, mockBridgeManager, mockMessageStore, mockResidentRegistry };
}

function ask(app: ReturnType<typeof buildApp>["app"], content: unknown) {
  return app.inject({ method: "POST", url: "/api/siri/ask", payload: { content } });
}

beforeEach(() => {
  runClaude.mockReset();
});

describe("POST /api/siri/ask", () => {
  it("returns claude's answer as ttsText", async () => {
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

  it("rejects unauthenticated requests", async () => {
    const app = Fastify();
    registerSiriAskRoute(app, {
      bridgeManager: { send: vi.fn() } as any,
      messageStore: { save: vi.fn() } as any,
      residentRegistry: { pairs: () => [] } as any,
      getAuthIdentity: () => null,
      claude: { bin: "claude", cwd: "/tmp", model: "m", timeoutMs: 1000 },
    });
    const res = await app.inject({ method: "POST", url: "/api/siri/ask", payload: { content: "hi" } });
    expect(res.statusCode).toBe(401);
    expect(runClaude).not.toHaveBeenCalled();
  });

  describe("on timeout", () => {
    const timedOut = { text: "", stderr: "", exitCode: null, timedOut: true, truncated: false };

    it("hands the task to the resident session and says so", async () => {
      runClaude.mockResolvedValue(timedOut);
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
      // 结果在网页上看，不该再套语音那套长度限制
      expect(sent.content).toContain("Siri 转交");
      expect(sent.content).not.toContain("[语音模式]");
    });

    it("does not hand off to a resident session the token cannot access", async () => {
      runClaude.mockResolvedValue(timedOut);
      const { app, mockBridgeManager } = buildApp({
        residentPairs: [{ connectionId: "other-bridge", key: "other:resident:resident", tokenName: "someone-else" }],
        bridgeIds: ["bridge1"],
      });
      const res = await ask(app, "干活");

      expect(res.json().mode).toBe("timeout");
      expect(mockBridgeManager.send).not.toHaveBeenCalled();
    });

    it("reports timeout when no resident session is configured", async () => {
      runClaude.mockResolvedValue(timedOut);
      const { app, mockBridgeManager } = buildApp({ residentPairs: [] });
      const res = await ask(app, "干活");

      expect(res.json().mode).toBe("timeout");
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
      runClaude.mockResolvedValue({
        text: "", stderr: "boom", exitCode: 1, timedOut: false, truncated: false,
      });
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

  it("sheds load past the inflight cap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    runClaude.mockImplementation(async () => { await gate; return ok("ok"); });

    const { app } = buildApp();
    const inflight = [ask(app, "1"), ask(app, "2"), ask(app, "3")];
    // 让上面三个先占满
    await new Promise((r) => setTimeout(r, 20));
    const overflow = await ask(app, "4");
    expect(overflow.statusCode).toBe(429);

    release();
    await Promise.all(inflight);
  });
});
