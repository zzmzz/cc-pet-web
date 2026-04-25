# Siri 语音集成实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 cc-pet-web 服务端新增 Siri 语音集成 API，让 iPhone 用户通过 Apple Shortcuts + Siri 与 Claude Code 进行纯语音对话。

**Architecture:** 服务端新增 `/api/siri/send` 和 `/api/siri/poll` 两个 REST 端点。`/send` 接收文字消息、注入语音模式提示词、通过现有 bridge 转发给 Claude Code，并创建内存中的 ReplyCollector 监听回复。`/poll` 按 msgId 查询回复状态，返回清洗后的 TTS 文本。Apple Shortcut 每 3 秒轮询直到回复完成，再由 iOS TTS 朗读。

**Tech Stack:** TypeScript, Fastify, Vitest, Apple Shortcuts

**Spec:** `docs/superpowers/specs/2026-04-25-siri-voice-integration-design.md`

---

## 文件结构

| 操作 | 路径 | 职责 |
|------|------|------|
| Create | `packages/server/src/siri/tts-sanitizer.ts` | TTS 文本清洗函数 |
| Create | `packages/server/src/siri/tts-sanitizer.test.ts` | TTS 清洗单元测试 |
| Create | `packages/server/src/siri/voice-prompt.ts` | 语音模式提示词常量和注入函数 |
| Create | `packages/server/src/siri/reply-collector.ts` | ReplyCollector 类，管理回复收集和生命周期 |
| Create | `packages/server/src/siri/reply-collector.test.ts` | ReplyCollector 单元测试 |
| Create | `packages/server/src/api/siri.ts` | `/api/siri/send` 和 `/api/siri/poll` 路由 |
| Create | `packages/server/src/api/siri.test.ts` | Siri API 路由集成测试 |
| Modify | `packages/server/src/index.ts` | 注册 Siri 路由 + 将 bridge 事件连接到 ReplyCollector |

---

### Task 1: TTS 文本清洗函数

**Files:**
- Create: `packages/server/src/siri/tts-sanitizer.ts`
- Create: `packages/server/src/siri/tts-sanitizer.test.ts`

- [ ] **Step 1: Write the failing tests**

在 `packages/server/src/siri/tts-sanitizer.test.ts` 中：

```typescript
import { describe, it, expect } from "vitest";
import { sanitizeForTts } from "./tts-sanitizer.js";

describe("sanitizeForTts", () => {
  it("removes fenced code blocks", () => {
    const input = "结果如下：\n```js\nconsole.log('hi');\n```\n完成了";
    expect(sanitizeForTts(input)).toBe("结果如下：\n代码已省略\n完成了");
  });

  it("removes inline code backticks", () => {
    expect(sanitizeForTts("使用 `npm install` 安装")).toBe("使用 npm install 安装");
  });

  it("removes markdown heading symbols", () => {
    expect(sanitizeForTts("## 标题内容")).toBe("标题内容");
  });

  it("removes bold/italic markers", () => {
    expect(sanitizeForTts("这是**加粗**和*斜体*")).toBe("这是加粗和斜体");
  });

  it("removes blockquote markers", () => {
    expect(sanitizeForTts("> 引用文本")).toBe("引用文本");
  });

  it("replaces URLs with placeholder", () => {
    expect(sanitizeForTts("访问 https://example.com/path?q=1 查看"))
      .toBe("访问 链接已省略 查看");
  });

  it("removes unordered list markers", () => {
    expect(sanitizeForTts("- 第一项\n- 第二项")).toBe("第一项\n第二项");
  });

  it("removes ordered list markers", () => {
    expect(sanitizeForTts("1. 第一项\n2. 第二项")).toBe("第一项\n第二项");
  });

  it("truncates text over 300 chars", () => {
    const long = "啊".repeat(350);
    const result = sanitizeForTts(long);
    expect(result.length).toBeLessThan(350);
    expect(result).toContain("详细内容可在聊天记录中查看");
  });

  it("returns short text as-is (no truncation)", () => {
    expect(sanitizeForTts("你好")).toBe("你好");
  });

  it("handles combined markdown", () => {
    const input = "## 结果\n\n**成功**完成了 `task`。\n\n```python\nprint('done')\n```\n\n访问 https://example.com";
    const result = sanitizeForTts(input);
    expect(result).not.toContain("```");
    expect(result).not.toContain("**");
    expect(result).not.toContain("`");
    expect(result).not.toContain("##");
    expect(result).not.toContain("https://");
    expect(result).toContain("代码已省略");
    expect(result).toContain("链接已省略");
  });

  it("collapses multiple blank lines", () => {
    expect(sanitizeForTts("第一段\n\n\n\n第二段")).toBe("第一段\n\n第二段");
  });

  it("trims leading/trailing whitespace", () => {
    expect(sanitizeForTts("  你好  ")).toBe("你好");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/ssd/workspace/cc-pet-web && pnpm -C packages/server exec vitest run src/siri/tts-sanitizer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

在 `packages/server/src/siri/tts-sanitizer.ts` 中：

```typescript
const MAX_TTS_LENGTH = 300;

export function sanitizeForTts(text: string): string {
  let result = text;

  // Remove fenced code blocks
  result = result.replace(/```[\s\S]*?```/g, "代码已省略");

  // Remove inline code backticks
  result = result.replace(/`([^`]+)`/g, "$1");

  // Remove heading markers
  result = result.replace(/^#{1,6}\s+/gm, "");

  // Remove bold/italic markers
  result = result.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");

  // Remove blockquote markers
  result = result.replace(/^>\s+/gm, "");

  // Remove unordered list markers
  result = result.replace(/^[-*+]\s+/gm, "");

  // Remove ordered list markers
  result = result.replace(/^\d+\.\s+/gm, "");

  // Replace URLs
  result = result.replace(/https?:\/\/[^\s)]+/g, "链接已省略");

  // Collapse multiple blank lines to one
  result = result.replace(/\n{3,}/g, "\n\n");

  // Trim
  result = result.trim();

  // Truncate if too long
  if (result.length > MAX_TTS_LENGTH) {
    result = result.slice(0, MAX_TTS_LENGTH) + "……详细内容可在聊天记录中查看";
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/ssd/workspace/cc-pet-web && pnpm -C packages/server exec vitest run src/siri/tts-sanitizer.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/siri/tts-sanitizer.ts packages/server/src/siri/tts-sanitizer.test.ts
git commit -m "feat(siri): add TTS text sanitizer"
```

---

### Task 2: 语音模式提示词

**Files:**
- Create: `packages/server/src/siri/voice-prompt.ts`

- [ ] **Step 1: Write the module**

在 `packages/server/src/siri/voice-prompt.ts` 中：

```typescript
const VOICE_MODE_PROMPT = `[语音模式] 用户正在通过语音与你对话，请注意：
- 回复简洁口语化，控制在3句话以内
- 不要使用Markdown格式、代码块、列表或链接
- 如果涉及代码或复杂内容，只说结论和关键信息
- 用"完成了"、"出错了"等简短状态词汇`;

export function wrapWithVoicePrompt(userContent: string): string {
  return `${VOICE_MODE_PROMPT}\n\n${userContent}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/siri/voice-prompt.ts
git commit -m "feat(siri): add voice mode prompt injection"
```

---

### Task 3: ReplyCollector

**Files:**
- Create: `packages/server/src/siri/reply-collector.ts`
- Create: `packages/server/src/siri/reply-collector.test.ts`

- [ ] **Step 1: Write the failing tests**

在 `packages/server/src/siri/reply-collector.test.ts` 中：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReplyCollector } from "./reply-collector.js";

describe("ReplyCollector", () => {
  let collector: ReplyCollector;

  beforeEach(() => {
    vi.useFakeTimers();
    collector = new ReplyCollector();
  });

  afterEach(() => {
    collector.dispose();
    vi.useRealTimers();
  });

  it("creates a collector and polls waiting status", () => {
    const msgId = collector.create("conn1", "session1");
    const result = collector.poll(msgId);
    expect(result).toEqual({ status: "waiting" });
  });

  it("returns null for unknown msgId", () => {
    expect(collector.poll("unknown")).toBeNull();
  });

  it("tracks streaming deltas", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onDelta("conn1", "session1", "你好");
    const result = collector.poll(msgId);
    expect(result?.status).toBe("streaming");
  });

  it("completes with full text and generates ttsText", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onDelta("conn1", "session1", "你好世界");
    collector.onDone("conn1", "session1", "你好世界");
    const result = collector.poll(msgId);
    expect(result?.status).toBe("done");
    expect(result?.ttsText).toBe("你好世界");
  });

  it("uses fullText from onDone over accumulated deltas", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onDelta("conn1", "session1", "partial");
    collector.onDone("conn1", "session1", "完整回复文本");
    const result = collector.poll(msgId);
    expect(result?.ttsText).toBe("完整回复文本");
  });

  it("sanitizes ttsText (removes code blocks)", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onDone("conn1", "session1", "结果：\n```js\ncode\n```\n完成");
    const result = collector.poll(msgId);
    expect(result?.ttsText).not.toContain("```");
    expect(result?.ttsText).toContain("代码已省略");
  });

  it("rejects duplicate session with active collector", () => {
    collector.create("conn1", "session1");
    expect(() => collector.create("conn1", "session1")).toThrow();
  });

  it("times out after 120 seconds", () => {
    const msgId = collector.create("conn1", "session1");
    vi.advanceTimersByTime(120_000);
    const result = collector.poll(msgId);
    expect(result?.status).toBe("error");
    expect(result?.ttsText).toContain("超时");
  });

  it("cleans up 60 seconds after done", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onDone("conn1", "session1", "完成");
    vi.advanceTimersByTime(60_000);
    expect(collector.poll(msgId)).toBeNull();
  });

  it("cleans up 60 seconds after error/timeout", () => {
    const msgId = collector.create("conn1", "session1");
    vi.advanceTimersByTime(120_000); // timeout
    vi.advanceTimersByTime(60_000); // cleanup
    expect(collector.poll(msgId)).toBeNull();
  });

  it("reports activeCount", () => {
    expect(collector.activeCount).toBe(0);
    collector.create("conn1", "s1");
    expect(collector.activeCount).toBe(1);
    collector.create("conn1", "s2");
    expect(collector.activeCount).toBe(2);
  });

  it("onReply completes immediately for non-streaming replies", () => {
    const msgId = collector.create("conn1", "session1");
    collector.onReply("conn1", "session1", "直接回复");
    const result = collector.poll(msgId);
    expect(result?.status).toBe("done");
    expect(result?.ttsText).toBe("直接回复");
  });

  it("ignores events for sessions without active collector", () => {
    collector.onDelta("conn1", "no-session", "data");
    collector.onDone("conn1", "no-session", "data");
    collector.onReply("conn1", "no-session", "data");
    // no error thrown
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/ssd/workspace/cc-pet-web && pnpm -C packages/server exec vitest run src/siri/reply-collector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

在 `packages/server/src/siri/reply-collector.ts` 中：

```typescript
import { sanitizeForTts } from "./tts-sanitizer.js";

type CollectorStatus = "waiting" | "streaming" | "done" | "error";

interface CollectorEntry {
  msgId: string;
  connectionId: string;
  sessionKey: string;
  status: CollectorStatus;
  deltas: string[];
  rawText?: string;
  ttsText?: string;
  rawLength?: number;
  truncated?: boolean;
  timeoutTimer: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface PollResult {
  status: CollectorStatus;
  ttsText?: string;
  rawLength?: number;
  truncated?: boolean;
}

export class ReplyCollector {
  private byMsgId = new Map<string, CollectorEntry>();
  private bySession = new Map<string, CollectorEntry>();

  get activeCount(): number {
    return this.byMsgId.size;
  }

  create(connectionId: string, sessionKey: string): string {
    const sessionId = `${connectionId}::${sessionKey}`;
    if (this.bySession.has(sessionId)) {
      const existing = this.bySession.get(sessionId)!;
      if (existing.status === "waiting" || existing.status === "streaming") {
        throw new Error(`Session ${sessionId} already has an active collector`);
      }
    }

    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const entry: CollectorEntry = {
      msgId,
      connectionId,
      sessionKey,
      status: "waiting",
      deltas: [],
      timeoutTimer: setTimeout(() => this.markError(msgId, "回复超时"), 120_000),
    };

    this.byMsgId.set(msgId, entry);
    this.bySession.set(sessionId, entry);
    return msgId;
  }

  poll(msgId: string): PollResult | null {
    const entry = this.byMsgId.get(msgId);
    if (!entry) return null;
    return {
      status: entry.status,
      ttsText: entry.ttsText,
      rawLength: entry.rawLength,
      truncated: entry.truncated,
    };
  }

  onDelta(connectionId: string, sessionKey: string, delta: string): void {
    const entry = this.bySession.get(`${connectionId}::${sessionKey}`);
    if (!entry || entry.status === "done" || entry.status === "error") return;
    entry.deltas.push(delta);
    entry.status = "streaming";
  }

  onDone(connectionId: string, sessionKey: string, fullText?: string): void {
    const entry = this.bySession.get(`${connectionId}::${sessionKey}`);
    if (!entry || entry.status === "done" || entry.status === "error") return;
    const raw = fullText || entry.deltas.join("");
    this.finalize(entry, raw);
  }

  onReply(connectionId: string, sessionKey: string, content: string): void {
    const entry = this.bySession.get(`${connectionId}::${sessionKey}`);
    if (!entry || entry.status === "done" || entry.status === "error") return;
    this.finalize(entry, content);
  }

  dispose(): void {
    for (const entry of this.byMsgId.values()) {
      clearTimeout(entry.timeoutTimer);
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    }
    this.byMsgId.clear();
    this.bySession.clear();
  }

  private finalize(entry: CollectorEntry, rawText: string): void {
    clearTimeout(entry.timeoutTimer);
    entry.status = "done";
    entry.rawText = rawText;
    entry.rawLength = rawText.length;
    entry.ttsText = sanitizeForTts(rawText);
    entry.truncated = entry.ttsText !== rawText;
    this.scheduleCleanup(entry);
  }

  private markError(msgId: string, message: string): void {
    const entry = this.byMsgId.get(msgId);
    if (!entry || entry.status === "done" || entry.status === "error") return;
    entry.status = "error";
    entry.ttsText = message;
    this.scheduleCleanup(entry);
  }

  private scheduleCleanup(entry: CollectorEntry): void {
    entry.cleanupTimer = setTimeout(() => {
      this.byMsgId.delete(entry.msgId);
      this.bySession.delete(`${entry.connectionId}::${entry.sessionKey}`);
    }, 60_000);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/ssd/workspace/cc-pet-web && pnpm -C packages/server exec vitest run src/siri/reply-collector.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/siri/reply-collector.ts packages/server/src/siri/reply-collector.test.ts
git commit -m "feat(siri): add ReplyCollector with dual-index and lifecycle management"
```

---

### Task 4: Siri API 路由

**Files:**
- Create: `packages/server/src/api/siri.ts`
- Create: `packages/server/src/api/siri.test.ts`

- [ ] **Step 1: Write the failing tests**

在 `packages/server/src/api/siri.test.ts` 中：

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/ssd/workspace/cc-pet-web && pnpm -C packages/server exec vitest run src/api/siri.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

在 `packages/server/src/api/siri.ts` 中：

```typescript
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BridgeManager } from "../bridge/manager.js";
import type { MessageStore } from "../storage/messages.js";
import type { ReplyCollector } from "../siri/reply-collector.js";
import { wrapWithVoicePrompt } from "../siri/voice-prompt.js";

const MAX_ACTIVE_COLLECTORS = 5;

interface SiriDeps {
  bridgeManager: BridgeManager;
  messageStore: MessageStore;
  replyCollector: ReplyCollector;
  getAuthIdentity: (req: FastifyRequest) => { name: string; bridgeIds: Set<string> } | null;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/ssd/workspace/cc-pet-web && pnpm -C packages/server exec vitest run src/api/siri.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api/siri.ts packages/server/src/api/siri.test.ts
git commit -m "feat(siri): add /api/siri/send and /api/siri/poll endpoints"
```

---

### Task 5: 集成到主服务器

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add imports at the top of index.ts**

在 index.ts 的 import 区域添加：

```typescript
import { ReplyCollector } from "./siri/reply-collector.js";
import { registerSiriRoutes } from "./api/siri.js";
import { getRequestAuthIdentity } from "./middleware/auth.js";
```

注意：`getRequestAuthIdentity` 可能已经被导入，如果是则跳过。

- [ ] **Step 2: Create ReplyCollector instance and register routes**

在 index.ts 中现有的 `registerXxxRoutes(...)` 调用块之后（约 line 147 附近），添加：

```typescript
const replyCollector = new ReplyCollector();
registerSiriRoutes(app, {
  bridgeManager,
  messageStore,
  replyCollector,
  getAuthIdentity: getRequestAuthIdentity,
  getDefaultConnectionId: (bridgeIds) => [...bridgeIds][0],
});
```

- [ ] **Step 3: Hook ReplyCollector into bridge event handling**

在 `bridgeManager.on("message", ...)` 的 switch 语句中，找到 `case "reply":` 和 `case "reply_stream":` 分支。在每个分支内、现有逻辑之后，追加 ReplyCollector 通知。

在 `case "reply":` 分支的 `hub.broadcast(...)` 调用之后添加：

```typescript
replyCollector.onReply(connId, sessionKey ?? "default", replyContent);
```

在 `case "reply_stream":` 分支中：
- 在 `hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DONE, ...)` 之后添加：
```typescript
replyCollector.onDone(connId, sessionKey ?? "default", fullText);
```
- 在 `hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DELTA, ...)` 之后添加：
```typescript
if (delta) replyCollector.onDelta(connId, sessionKey ?? "default", delta);
```

- [ ] **Step 4: Run all server tests**

Run: `cd /Volumes/ssd/workspace/cc-pet-web && pnpm -C packages/server test`
Expected: All tests PASS (existing + new)

- [ ] **Step 5: Manual smoke test**

Run: `cd /Volumes/ssd/workspace/cc-pet-web && pnpm dev`

用 curl 测试：

```bash
# Send
curl -X POST http://localhost:3000/api/siri/send \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"content": "你好"}'

# Poll (用上一步返回的 msgId)
curl http://localhost:3000/api/siri/poll?msgId=<msgId> \
  -H "Authorization: Bearer <your-token>"
```

验证：send 返回 msgId，poll 返回 status（如果 bridge 连接正常，最终应该返回 done + ttsText）。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(siri): integrate ReplyCollector into server and bridge event flow"
```

---

### Task 6: Apple Shortcut 制作指南

此任务为文档任务，不涉及代码。

- [ ] **Step 1: 在 iPhone 快捷指令 app 中创建 Shortcut**

Shortcut 名称：**Ask Claude**（用于 Siri 触发："Hey Siri, Ask Claude"）

Shortcut 步骤：

1. **Dictate Text** — 获取语音输入，结果存入变量 `userText`
2. **Text** — 设置服务器地址变量 `serverUrl`，值为 `http://<your-server-ip>:3000`
3. **Text** — 设置 token 变量 `token`，值为你的 Bearer token
4. **Get Contents of URL** — POST 请求
   - URL: `{serverUrl}/api/siri/send`
   - Method: POST
   - Headers: `Authorization: Bearer {token}`
   - Request Body (JSON): `{"content": "{userText}"}`
5. **Get Dictionary Value** — 从响应中取 `msgId`，存入变量 `msgId`
6. **Repeat 30 times:**
   - a. **Wait** 3 seconds
   - b. **Get Contents of URL** — GET 请求
     - URL: `{serverUrl}/api/siri/poll?msgId={msgId}`
     - Headers: `Authorization: Bearer {token}`
   - c. **Get Dictionary Value** — 取 `status`
   - d. **If** status equals "done" or status equals "error":
     - **Get Dictionary Value** — 取 `ttsText`，存入变量 `replyText`
     - **Exit Repeat**
7. **Speak Text** — 朗读 `replyText`

- [ ] **Step 2: 测试 Shortcut**

在 iPhone 上运行 Shortcut，对 Siri 说一句话，验证：
- 消息成功发送
- 轮询正常工作
- 收到回复后 TTS 朗读
- cc-pet-web 网页端能看到这条对话

- [ ] **Step 3: Commit documentation**

无代码改动，可选择在项目中添加使用文档。
