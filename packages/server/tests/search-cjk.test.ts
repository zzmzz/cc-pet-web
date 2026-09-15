import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { MessageStore } from "../src/storage/messages.js";
import { SessionStore } from "../src/storage/sessions.js";
import { registerSearchRoutes } from "../src/api/search.js";
import type { SearchResult } from "../src/api/search.js";
import type { ChatMessage } from "@cc-pet/shared";

interface SearchResponse {
  results: SearchResult[];
  total: number;
}

describe("search: CJK & display behavior", () => {
  let db: Database.Database;
  let messages: MessageStore;
  let sessions: SessionStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    messages = new MessageStore(db);
    sessions = new SessionStore(db);
    // A visible session so its messages pass the visibility filter.
    sessions.create({ key: "s1", connectionId: "conn-1", createdAt: 1, lastActiveAt: 1 });
  });

  afterEach(() => {
    db.close();
  });

  function addMessage(id: string, content: string, role: ChatMessage["role"] = "user", ts = 1) {
    messages.save({ id, role, content, timestamp: ts, connectionId: "conn-1", sessionKey: "s1" });
  }

  async function search(
    q: string,
    extra: Record<string, string> = {},
  ): Promise<SearchResponse> {
    const app = Fastify();
    registerSearchRoutes(app, db);
    try {
      const params = new URLSearchParams({ q, ...extra });
      const res = await app.inject({ method: "GET", url: `/api/search?${params.toString()}` });
      expect(res.statusCode).toBe(200);
      return res.json();
    } finally {
      await app.close();
    }
  }

  it("finds a 2-character Chinese substring inside a longer run (the core bug)", async () => {
    addMessage("m1", "全文搜索功能已经上线了");
    const r = await search("搜索");
    expect(r.total).toBe(1);
    expect(r.results[0].messageId).toBe("m1");
  });

  it("finds a single Chinese character", async () => {
    addMessage("m1", "我在北京工作");
    expect((await search("京")).total).toBe(1);
  });

  it("treats the query as a substring (non-adjacent characters do not match)", async () => {
    addMessage("m1", "全文搜索功能");
    expect((await search("搜能")).total).toBe(0);
  });

  it("does not match Chinese text that lacks the substring", async () => {
    addMessage("m1", "我在北京工作");
    expect((await search("上海")).total).toBe(0);
  });

  it("still matches English words case-insensitively", async () => {
    addMessage("m1", "Hello World from the pet");
    expect((await search("world")).total).toBe(1);
  });

  it("searches mixed Chinese/English content", async () => {
    addMessage("m1", "使用 React 开发前端");
    expect((await search("前端")).total).toBe(1);
    expect((await search("react")).total).toBe(1);
  });

  it("wraps the matched Chinese substring in highlight markers", async () => {
    addMessage("m1", "这是一段关于搜索功能的说明文字");
    const r = await search("搜索");
    expect(r.results[0].snippet).toContain("<<hl>>搜索<</hl>>");
  });

  it("returns empty for a whitespace-only query", async () => {
    addMessage("m1", "任意内容");
    await expect(search("   ")).resolves.toEqual({ results: [], total: 0 });
  });

  it("paginates with limit/offset while reporting the full total", async () => {
    for (let i = 0; i < 5; i++) addMessage(`m${i}`, `第${i}条包含关键词的消息`, "user", i + 1);
    const page = await search("关键词", { limit: "2", offset: "0" });
    expect(page.total).toBe(5);
    expect(page.results).toHaveLength(2);

    const page2 = await search("关键词", { limit: "2", offset: "4" });
    expect(page2.total).toBe(5);
    expect(page2.results).toHaveLength(1);
  });

  it("respects the connectionId filter", async () => {
    addMessage("m1", "共享关键词内容");
    messages.save({
      id: "m2",
      role: "user",
      content: "共享关键词内容",
      timestamp: 2,
      connectionId: "conn-2",
      sessionKey: "default",
    });
    const r = await search("关键词", { connectionId: "conn-1" });
    expect(r.total).toBe(1);
    expect(r.results[0].connectionId).toBe("conn-1");
  });
});

describe("search: FTS migration from legacy unicode61 external-content index", () => {
  it("rebuilds a legacy index so previously-unmatchable CJK becomes searchable", async () => {
    const db = new Database(":memory:");
    try {
      // Recreate the pre-migration schema: a plain messages table plus the OLD
      // external-content FTS with the unicode61 tokenizer and user_version 0.
      db.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          chat_key TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          connection_id TEXT,
          session_key TEXT,
          extra TEXT
        );
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          id, content, content='messages', content_rowid='rowid', tokenize='unicode61'
        );
        CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, id, content) VALUES (new.rowid, new.id, new.content);
        END;
      `);
      db.prepare(
        `INSERT INTO messages (id, chat_key, role, content, timestamp, connection_id, session_key)
         VALUES (?, 'conn-1::default', 'user', ?, 1, 'conn-1', 'default')`,
      ).run("legacy", "全文搜索功能已经上线");

      const legacyMatches = db
        .prepare('SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?')
        .get('"搜索"') as { n: number };
      expect(legacyMatches.n).toBe(0); // legacy index cannot match the substring

      // Running the current schema init should migrate & repopulate the index.
      initSchema(db);
      expect(db.pragma("user_version", { simple: true })).toBe(2);

      const app = Fastify();
      registerSearchRoutes(app, db);
      try {
        const res = await app.inject({ method: "GET", url: "/api/search?q=搜索" });
        const body = res.json() as SearchResponse;
        expect(body.total).toBe(1);
        expect(body.results[0].messageId).toBe("legacy");
      } finally {
        await app.close();
      }
    } finally {
      db.close();
    }
  });
});
