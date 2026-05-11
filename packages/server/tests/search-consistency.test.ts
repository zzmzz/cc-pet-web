import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { MessageStore } from "../src/storage/messages.js";
import { SessionStore } from "../src/storage/sessions.js";
import { registerSearchRoutes } from "../src/api/search.js";

describe("search/session consistency", () => {
  let db: Database.Database;
  let messages: MessageStore;
  let sessions: SessionStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    messages = new MessageStore(db);
    sessions = new SessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  async function search(q: string, connectionId = "conn-1"): Promise<{ results: unknown[]; total: number }> {
    const app = Fastify();
    registerSearchRoutes(app, db);

    try {
      const params = new URLSearchParams({ q, connectionId });
      const res = await app.inject({
        method: "GET",
        url: `/api/search?${params.toString()}`,
      });

      expect(res.statusCode).toBe(200);
      return res.json();
    } finally {
      await app.close();
    }
  }

  function ftsMatches(term: string): number {
    const row = db.prepare(
      "SELECT COUNT(*) AS total FROM messages_fts WHERE messages_fts MATCH ?"
    ).get(`"${term}"`) as { total: number };
    return row.total;
  }

  it("does not return messages whose session was already deleted", async () => {
    messages.save({
      id: "ghost-message",
      role: "user",
      content: "ghost-session-search-token",
      timestamp: 1,
      connectionId: "conn-1",
      sessionKey: "deleted-session",
    });

    await expect(search("ghost-session-search-token")).resolves.toEqual({ results: [], total: 0 });
  });

  it("keeps legacy default-session messages searchable without a sessions row", async () => {
    messages.save({
      id: "default-message",
      role: "user",
      content: "default-orphan-search-token",
      timestamp: 1,
      connectionId: "conn-1",
      sessionKey: "default",
    });

    const result = await search("default-orphan-search-token");

    expect(result.total).toBe(1);
    expect(result.results).toHaveLength(1);
  });

  it("deleting a session removes its messages from the searchable data", async () => {
    sessions.create({
      key: "session-with-message",
      connectionId: "conn-1",
      createdAt: 1,
      lastActiveAt: 1,
    });
    messages.save({
      id: "message-to-delete",
      role: "user",
      content: "deleted-session-token",
      timestamp: 2,
      connectionId: "conn-1",
      sessionKey: "session-with-message",
    });

    sessions.delete("conn-1", "session-with-message");

    expect(messages.getByChatKey("conn-1::session-with-message")).toHaveLength(0);
    expect(ftsMatches("deleted-session-token")).toBe(0);
    await expect(search("deleted-session-token")).resolves.toEqual({ results: [], total: 0 });
  });

  it("updating an existing session preserves its messages", () => {
    db.pragma("recursive_triggers = ON");
    sessions.create({
      key: "stable-session",
      connectionId: "conn-1",
      createdAt: 1,
      lastActiveAt: 1,
    });
    messages.save({
      id: "stable-message",
      role: "user",
      content: "stable-session-token",
      timestamp: 2,
      connectionId: "conn-1",
      sessionKey: "stable-session",
    });

    sessions.create({
      key: "stable-session",
      connectionId: "conn-1",
      label: "renamed",
      createdAt: 1,
      lastActiveAt: 3,
    });

    expect(messages.getByChatKey("conn-1::stable-session")).toHaveLength(1);
  });
});
