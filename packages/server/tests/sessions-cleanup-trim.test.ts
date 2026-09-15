import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { makeChatKey } from "@cc-pet/shared";
import { initSchema } from "../src/storage/db.js";
import { SessionStore } from "../src/storage/sessions.js";
import { MessageStore } from "../src/storage/messages.js";
import { SessionsCleanup } from "../src/cleanup/sessions-cleanup.js";

describe("SessionsCleanup.trimResidentMessages", () => {
  let db: Database.Database;
  let sessions: SessionStore;
  let messages: MessageStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    sessions = new SessionStore(db);
    messages = new MessageStore(db);
  });
  afterEach(() => db.close());

  function seed(connectionId: string, sessionKey: string, count: number, baseTs: number) {
    for (let i = 0; i < count; i++) {
      messages.save({
        id: `${connectionId}:${sessionKey}:${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg ${i}`,
        timestamp: baseTs + i, // 递增，i 越大越新
        connectionId,
        sessionKey,
      } as any);
    }
  }

  function msgCount(chatKey: string): number {
    return (db.prepare("SELECT COUNT(*) c FROM messages WHERE chat_key = ?").get(chatKey) as any).c;
  }

  it("trims a resident session down to the newest 500 messages", () => {
    sessions.markResident("bridge", "resident");
    seed("bridge", "resident", 600, 1_000);
    const chatKey = makeChatKey("bridge", "resident");
    expect(msgCount(chatKey)).toBe(600);

    const cleanup = new SessionsCleanup(sessions, db);
    const deleted = cleanup.trimResidentMessages(500);

    expect(deleted).toBe(100);
    expect(msgCount(chatKey)).toBe(500);
    // 最老的 100 条（i=0..99, timestamp 1000..1099）应被删，最新的应保留
    const oldest = db.prepare("SELECT MIN(timestamp) t FROM messages WHERE chat_key = ?").get(chatKey) as any;
    expect(oldest.t).toBe(1_100); // i=100
  });

  it("keeps messages_fts row count in sync via the delete trigger", () => {
    sessions.markResident("bridge", "resident");
    seed("bridge", "resident", 600, 1_000);

    const cleanup = new SessionsCleanup(sessions, db);
    cleanup.trimResidentMessages(500);

    const ftsCount = (db.prepare("SELECT COUNT(*) c FROM messages_fts").get() as any).c;
    expect(ftsCount).toBe(500);
  });

  it("does not touch non-resident sessions", () => {
    sessions.create({ key: "normal", connectionId: "bridge", createdAt: 1_000, lastActiveAt: 1_600 });
    seed("bridge", "normal", 600, 1_000);
    const chatKey = makeChatKey("bridge", "normal");

    const cleanup = new SessionsCleanup(sessions, db);
    const deleted = cleanup.trimResidentMessages(500);

    expect(deleted).toBe(0);
    expect(msgCount(chatKey)).toBe(600);
  });
});
