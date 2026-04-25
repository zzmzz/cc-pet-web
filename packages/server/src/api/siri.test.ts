import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerSiriRoutes } from "./siri.js";
import { ReplyCollector } from "../siri/reply-collector.js";

function buildApp() {
  const app = Fastify();
  const collector = new ReplyCollector();

  const mockBridgeManager = {
    send: vi.fn(),
    getStatus: vi.fn().mockReturnValue(true),
  };

  const mockMessageStore = {
    save: vi.fn(),
  };

  const mockAuthIdentity = {
    name: "test",
    bridgeIds: new Set(["bridge1"]),
  };

  // Simulate auth middleware: attach identity to every request
  app.addHook("onRequest", async (req) => {
    (req as any).__auth = mockAuthIdentity;
  });

  registerSiriRoutes(app, {
    bridgeManager: mockBridgeManager as any,
    messageStore: mockMessageStore as any,
    replyCollector: collector,
    getAuthIdentity: (req) => (req as any).__auth,
    getDefaultConnectionId: () => "bridge1",
  });

  return { app, collector, mockBridgeManager, mockMessageStore };
}

describe("POST /api/siri/send", () => {
  it("sends message and returns msgId", async () => {
    const { app, mockBridgeManager } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/siri/send",
      payload: { content: "你好" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.msgId).toBeDefined();
    expect(body.connectionId).toBe("bridge1");
    expect(body.sessionKey).toBe("default");
    expect(mockBridgeManager.send).toHaveBeenCalledOnce();

    // Verify voice prompt was injected into bridge message
    const sentMsg = mockBridgeManager.send.mock.calls[0][1];
    expect(sentMsg.content).toContain("[语音模式]");
    expect(sentMsg.content).toContain("你好");
  });

  it("saves user message to store without voice prompt", async () => {
    const { app, mockMessageStore } = buildApp();
    await app.inject({
      method: "POST",
      url: "/api/siri/send",
      payload: { content: "测试消息" },
    });
    expect(mockMessageStore.save).toHaveBeenCalledOnce();
    const saved = mockMessageStore.save.mock.calls[0][0];
    expect(saved.content).toBe("测试消息");
    expect(saved.role).toBe("user");
  });

  it("rejects empty content", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/siri/send",
      payload: { content: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 409 when session already has active collector", async () => {
    const { app } = buildApp();
    await app.inject({ method: "POST", url: "/api/siri/send", payload: { content: "第一条" } });
    const res = await app.inject({ method: "POST", url: "/api/siri/send", payload: { content: "第二条" } });
    expect(res.statusCode).toBe(409);
  });

  it("uses custom connectionId and sessionKey", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/siri/send",
      payload: { content: "你好", connectionId: "bridge1", sessionKey: "custom" },
    });
    const body = JSON.parse(res.payload);
    expect(body.sessionKey).toBe("custom");
  });
});

describe("GET /api/siri/poll", () => {
  it("returns poll result for valid msgId", async () => {
    const { app, collector } = buildApp();
    const sendRes = await app.inject({
      method: "POST",
      url: "/api/siri/send",
      payload: { content: "你好" },
    });
    const { msgId } = JSON.parse(sendRes.payload);

    const pollRes = await app.inject({
      method: "GET",
      url: `/api/siri/poll?msgId=${msgId}`,
    });
    expect(pollRes.statusCode).toBe(200);
    expect(JSON.parse(pollRes.payload).status).toBe("waiting");
  });

  it("returns 404 for unknown msgId", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/siri/poll?msgId=unknown",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when msgId is missing", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/siri/poll",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns done with ttsText after reply completes", async () => {
    const { app, collector } = buildApp();
    const sendRes = await app.inject({
      method: "POST",
      url: "/api/siri/send",
      payload: { content: "你好" },
    });
    const { msgId, connectionId, sessionKey } = JSON.parse(sendRes.payload);

    collector.onReply(connectionId, sessionKey, "你好，有什么可以帮你的？");

    const pollRes = await app.inject({
      method: "GET",
      url: `/api/siri/poll?msgId=${msgId}`,
    });
    const body = JSON.parse(pollRes.payload);
    expect(body.status).toBe("done");
    expect(body.ttsText).toBe("你好，有什么可以帮你的？");
  });
});
