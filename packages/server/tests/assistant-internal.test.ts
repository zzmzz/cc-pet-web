import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { SessionStore } from "../src/storage/sessions.js";
import { MessageStore } from "../src/storage/messages.js";
import { registerAssistantInternalRoutes } from "../src/api/assistant-internal.js";
import { WS_EVENTS } from "@cc-pet/shared";

const TOKEN = "test-internal-token";
const RESIDENT = { connectionId: "br1", key: "br1:resident:resident" };

describe("POST /internal/assistant/send", () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let sessions: SessionStore;
  let messages: MessageStore;
  let sent: { connectionId: string; msg: any }[];
  let events: { event: string; payload: any }[];
  let userSends: string[];

  async function build(token: string | undefined) {
    const a = Fastify();
    // 旧版本有过 onUserSend 钩子；塞一个进去，确认路由不会再调它
    const deps = {
      token,
      getResident: () => RESIDENT,
      sessionStore: sessions,
      messageStore: messages,
      bridgeManager: { send: (connectionId: string, msg: any) => { sent.push({ connectionId, msg }); } },
      broadcast: (event: string, payload: any) => { events.push({ event, payload }); },
      onUserSend: (_c: string, k: string) => { userSends.push(k); },
    };
    registerAssistantInternalRoutes(a, deps);
    await a.ready();
    return a;
  }

  beforeEach(async () => {
    db = new Database(":memory:");
    initSchema(db);
    sessions = new SessionStore(db);
    messages = new MessageStore(db);
    sent = [];
    events = [];
    userSends = [];
    app = await build(TOKEN);
  });
  afterEach(async () => { await app.close(); db.close(); });

  const send = (payload: unknown, token: string | null = TOKEN, a = app) =>
    a.inject({
      method: "POST",
      url: "/internal/assistant/send",
      headers: token === null ? {} : { "x-assistant-token": token },
      payload: payload as object,
    });

  it("returns 404 when the env token is not configured", async () => {
    const a = await build(undefined);
    try {
      expect((await send({ sessionKey: "item-1", content: "hi" }, TOKEN, a)).statusCode).toBe(404);
      expect((await send({ sessionKey: "item-1", content: "hi" }, null, a)).statusCode).toBe(404);
    } finally {
      await a.close();
    }
    const b = await build("");
    try {
      expect((await send({ sessionKey: "item-1", content: "hi" }, "", b)).statusCode).toBe(404);
    } finally {
      await b.close();
    }
  });

  it("returns 401 for a missing or wrong token", async () => {
    expect((await send({ sessionKey: "item-1", content: "hi" }, null)).statusCode).toBe(401);
    expect((await send({ sessionKey: "item-1", content: "hi" }, "wrong")).statusCode).toBe(401);
    expect((await send({ sessionKey: "item-1", content: "hi" }, TOKEN + "x")).statusCode).toBe(401);
    expect(sent).toEqual([]);
  });

  it("rejects keys outside the allowed set with 400", async () => {
    for (const sessionKey of ["item-", "item-abc", "task-1x", "other", "br1:other:other", "", 5, undefined, "item-1 "]) {
      const res = await send({ sessionKey, content: "hi" });
      expect(res.statusCode, String(sessionKey)).toBe(400);
    }
    expect(sent).toEqual([]);
  });

  it("rejects empty or oversized content with 400", async () => {
    expect((await send({ sessionKey: "item-1", content: "" })).statusCode).toBe(400);
    expect((await send({ sessionKey: "item-1", content: "   " })).statusCode).toBe(400);
    expect((await send({ sessionKey: "item-1" })).statusCode).toBe(400);
    expect((await send({ sessionKey: "item-1", content: "字".repeat(8001) })).statusCode).toBe(400);
    expect((await send({ sessionKey: "item-1", content: "字".repeat(8000) })).statusCode).toBe(200);
  });

  it("counts content length in code points, not UTF-16 units", async () => {
    // 每个 emoji 占两个 UTF-16 单元，8000 个就是 16000 个单元
    expect((await send({ sessionKey: "item-1", content: "😀".repeat(8000) })).statusCode).toBe(200);
    expect((await send({ sessionKey: "item-1", content: "😀".repeat(8001) })).statusCode).toBe(400);
  });

  it("rejects a child key longer than 64 characters", async () => {
    expect((await send({ sessionKey: "item-" + "1".repeat(70), content: "hi" })).statusCode).toBe(400);
  });

  it("createIfMissing inserts once and leaves an existing row alone", () => {
    const t = 1000;
    expect(sessions.createIfMissing({ key: "item-9", connectionId: "br1", label: "甲", createdAt: t, lastActiveAt: t })).toBe(true);
    expect(sessions.createIfMissing({ key: "item-9", connectionId: "br1", label: "乙", createdAt: 2000, lastActiveAt: 2000 })).toBe(false);
    expect(sessions.listByConnection("br1")).toEqual([expect.objectContaining({ key: "item-9", label: "甲", createdAt: t })]);
  });

  it("caps a new session's label at 200 characters", async () => {
    const res = await send({ sessionKey: "item-5", content: "hi", label: "长".repeat(300) });
    expect(res.statusCode).toBe(200);
    expect(sessions.listByConnection("br1")[0].label).toBe("长".repeat(200));
  });

  it("creates a missing session with the label, saves, forwards and broadcasts", async () => {
    const content = "（自动）示例事项到期了，看一下进展\n第二行";
    const res = await send({ sessionKey: "item-12", content, label: "示例事项" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, sessionKey: "item-12" });

    const list = sessions.listByConnection("br1");
    expect(list).toEqual([expect.objectContaining({ key: "item-12", label: "示例事项" })]);

    const rows = db.prepare("SELECT id, role, content, connection_id, session_key FROM messages").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "user", content, connection_id: "br1", session_key: "item-12" });

    expect(sent).toHaveLength(1);
    expect(sent[0].connectionId).toBe("br1");
    expect(sent[0].msg).toMatchObject({
      type: "message",
      msg_id: rows[0].id,
      session_key: "item-12",
      reply_ctx: "item-12",
      user_name: "assistant-automation",
      content,
    });
    expect(events).toEqual([
      { event: WS_EVENTS.ASSISTANT_SESSION_UPDATED, payload: { connectionId: "br1", sessionKey: "item-12" } },
    ]);
    expect(WS_EVENTS.ASSISTANT_SESSION_UPDATED).toBe("assistant-session-updated");
  });

  it("keeps an existing session and its label", async () => {
    const t = Date.now() - 10_000;
    sessions.create({ key: "task-3", connectionId: "br1", label: "原来的名字", createdAt: t, lastActiveAt: t });
    const res = await send({ sessionKey: "task-3", content: "继续", label: "新名字" });
    expect(res.statusCode).toBe(200);
    const s = sessions.listByConnection("br1").find((x) => x.key === "task-3")!;
    expect(s.label).toBe("原来的名字");
    expect(s.createdAt).toBe(t);
    expect(sent).toHaveLength(1);
  });

  it("accepts the resident session key without marking it as a user send", async () => {
    sessions.markResident(RESIDENT.connectionId, RESIDENT.key, "主会话");
    const res = await send({ sessionKey: RESIDENT.key, content: "（自动）早上好" });
    expect(res.statusCode).toBe(200);
    expect(sent[0].msg.session_key).toBe(RESIDENT.key);
    expect(sessions.isResident(RESIDENT.connectionId, RESIDENT.key)).toBe(true);
    expect(userSends).toEqual([]);
  });

  it("returns 503 when no assistant resident session is configured", async () => {
    const a = Fastify();
    registerAssistantInternalRoutes(a, {
      token: TOKEN,
      getResident: () => undefined,
      sessionStore: sessions,
      messageStore: messages,
      bridgeManager: { send: () => {} },
      broadcast: () => {},
    });
    await a.ready();
    try {
      expect((await send({ sessionKey: "item-1", content: "hi" }, TOKEN, a)).statusCode).toBe(503);
    } finally {
      await a.close();
    }
  });
});

describe("POST /internal/assistant/notify", () => {
  let app: FastifyInstance;
  let events: { event: string; payload: any }[];
  let pushes: any[];
  let sent: unknown[];

  async function build(opts: { token?: string; resident?: typeof RESIDENT; push?: (p: any) => unknown } = {}) {
    const a = Fastify();
    const db = new Database(":memory:");
    initSchema(db);
    registerAssistantInternalRoutes(a, {
      token: "token" in opts ? opts.token : TOKEN,
      getResident: () => ("resident" in opts ? opts.resident : RESIDENT),
      sessionStore: new SessionStore(db),
      messageStore: new MessageStore(db),
      bridgeManager: { send: (_c: string, m: unknown) => { sent.push(m); } },
      broadcast: (event, payload) => { events.push({ event, payload }); },
      pushToAssistant: opts.push ?? ((p) => { pushes.push(p); }),
    });
    a.addHook("onClose", async () => db.close());
    await a.ready();
    return a;
  }

  beforeEach(async () => {
    events = [];
    pushes = [];
    sent = [];
    app = await build();
  });
  afterEach(async () => { await app.close(); });

  const notify = (payload: unknown, token: string | null = TOKEN, a = app) =>
    a.inject({
      method: "POST",
      url: "/internal/assistant/notify",
      headers: token === null ? {} : { "x-assistant-token": token },
      payload: payload as object,
    });

  const ok = { sessionKey: "task-2", event: "progress", title: "示例报告", text: "资料找齐了" };

  it("shares the token checks with send", async () => {
    const off = await build({ token: undefined });
    try {
      expect((await notify(ok, TOKEN, off)).statusCode).toBe(404);
    } finally {
      await off.close();
    }
    expect((await notify(ok, null)).statusCode).toBe(401);
    expect((await notify(ok, "wrong")).statusCode).toBe(401);
    expect(events).toEqual([]);
  });

  it("returns 503 without a resident session", async () => {
    const a = await build({ resident: undefined });
    try {
      expect((await notify(ok, TOKEN, a)).statusCode).toBe(503);
    } finally {
      await a.close();
    }
  });

  it("rejects bad keys, events, titles and texts with 400", async () => {
    for (const sessionKey of ["other", "item-", "br1:other:other", 3, undefined]) {
      expect((await notify({ ...ok, sessionKey })).statusCode, String(sessionKey)).toBe(400);
    }
    for (const event of ["finished", "", undefined, 1]) {
      expect((await notify({ ...ok, event })).statusCode, String(event)).toBe(400);
    }
    expect((await notify({ ...ok, title: 5 })).statusCode).toBe(400);
    expect((await notify({ ...ok, text: ["x"] })).statusCode).toBe(400);
    expect((await notify({ ...ok, text: "字".repeat(8001) })).statusCode).toBe(400);
    expect(events).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("broadcasts a progress event to the resident connection without pushing or sending", async () => {
    const res = await notify(ok);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(events).toEqual([
      { event: WS_EVENTS.ASSISTANT_SESSION_UPDATED, payload: { connectionId: "br1", sessionKey: "task-2" } },
    ]);
    expect(pushes).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("accepts the resident key itself", async () => {
    expect((await notify({ ...ok, sessionKey: RESIDENT.key })).statusCode).toBe(200);
  });

  it("pushes 「做好了」 for done, pointing at the sub-session", async () => {
    expect((await notify({ ...ok, event: "done", text: "初稿在产出目录" })).statusCode).toBe(200);
    expect(events).toHaveLength(1);
    expect(pushes).toEqual([
      {
        title: "蟹哥",
        body: "『示例报告』做好了：初稿在产出目录",
        tag: "assistant-task-2",
        data: { connectionId: "br1", sessionKey: "task-2" },
      },
    ]);
  });

  it("pushes 「卡住了」 for stuck, ignoring the text", async () => {
    expect((await notify({ ...ok, event: "stuck", text: "随便什么" })).statusCode).toBe(200);
    expect(pushes[0].body).toBe("『示例报告』卡住了，去看看");
  });

  it("falls back to the key when there is no title, and drops an empty text", async () => {
    await notify({ sessionKey: "item-7", event: "done" });
    expect(pushes[0].body).toBe("『item-7』做好了");
  });

  it("caps the push body", async () => {
    await notify({ ...ok, event: "done", text: "长".repeat(1000) });
    expect([...pushes[0].body].length).toBeLessThanOrEqual(200);
  });

  it("still answers 200 when the push fails", async () => {
    const a = await build({ push: () => Promise.reject(new Error("push down")) });
    try {
      expect((await notify({ ...ok, event: "done" }, TOKEN, a)).statusCode).toBe(200);
      const b = await build({ push: () => { throw new Error("push down"); } });
      try {
        expect((await notify({ ...ok, event: "stuck" }, TOKEN, b)).statusCode).toBe(200);
      } finally {
        await b.close();
      }
    } finally {
      await a.close();
    }
  });
});
