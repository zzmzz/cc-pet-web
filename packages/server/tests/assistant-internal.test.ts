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
    registerAssistantInternalRoutes(a, {
      token,
      getResident: () => RESIDENT,
      sessionStore: sessions,
      messageStore: messages,
      bridgeManager: { send: (connectionId, msg) => { sent.push({ connectionId, msg }); } },
      broadcast: (event, payload) => { events.push({ event, payload }); },
      onUserSend: (_c, k) => { userSends.push(k); },
    });
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

  it("accepts the resident session key and marks the user send", async () => {
    sessions.markResident(RESIDENT.connectionId, RESIDENT.key, "主会话");
    const res = await send({ sessionKey: RESIDENT.key, content: "（自动）早上好" });
    expect(res.statusCode).toBe(200);
    expect(sent[0].msg.session_key).toBe(RESIDENT.key);
    expect(sessions.isResident(RESIDENT.connectionId, RESIDENT.key)).toBe(true);
    expect(userSends).toEqual([RESIDENT.key]);
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
