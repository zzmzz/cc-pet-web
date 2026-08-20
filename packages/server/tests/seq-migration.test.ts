import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { MessageStore } from "../src/storage/messages.js";

/**
 * The seq backfill runs on every server start. Any row that shows up with a
 * NULL seq after the first upgrade (binary rollback, manual insert) must get a
 * seq above every seq already in the table — a colliding seq would be skipped
 * forever by the `seq > ?` sync cursor.
 */
describe("seq migration backfill", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
  });
  afterEach(() => db.close());

  const insertRaw = (id: string, timestamp: number, seq: number | null): void => {
    db.prepare(
      `INSERT INTO messages (id, chat_key, role, content, timestamp, connection_id, session_key, extra, seq)
       VALUES (?, 'c::s', 'user', ?, ?, 'c', 's', NULL, ?)`
    ).run(id, id, timestamp, seq);
  };

  const seqById = (): Record<string, number> => {
    const rows = db.prepare(`SELECT id, seq FROM messages`).all() as { id: string; seq: number }[];
    return Object.fromEntries(rows.map((r) => [r.id, r.seq]));
  };

  it("gives a late NULL row a seq above the existing max instead of colliding", () => {
    const messages = new MessageStore(db);
    messages.save({ id: "a", role: "user", content: "a", timestamp: 1000, connectionId: "c", sessionKey: "s" });
    messages.save({ id: "b", role: "user", content: "b", timestamp: 2000, connectionId: "c", sessionKey: "s" });
    messages.save({ id: "c", role: "user", content: "c", timestamp: 3000, connectionId: "c", sessionKey: "s" });
    const before = seqById();

    // A row whose timestamp sorts into the middle of history: a naive
    // ROW_NUMBER() over all rows would hand it b's seq.
    insertRaw("d", 1500, null);
    initSchema(db);

    const after = seqById();
    expect(after.a).toBe(before.a);
    expect(after.b).toBe(before.b);
    expect(after.c).toBe(before.c);
    expect(after.d).toBeGreaterThan(Math.max(before.a, before.b, before.c));
    expect(new Set(Object.values(after)).size).toBe(4);
  });

  it("keeps every seq unique so the seq > ? cursor can reach the new row", () => {
    const messages = new MessageStore(db);
    for (let i = 1; i <= 3; i++) {
      messages.save({ id: `m${i}`, role: "user", content: `m${i}`, timestamp: i * 1000, connectionId: "c", sessionKey: "s" });
    }
    insertRaw("late", 1500, null);
    initSchema(db);

    const reopened = new MessageStore(db);
    // The client's watermark is the highest seq it has already seen.
    const cursor = seqById().m3;
    const { messages: got } = reopened.getByChatKeyAfterSeq("c::s", cursor, 200);
    expect(got.map((m) => m.id)).toContain("late");
  });

  it("assigns NULL rows deterministically by (timestamp, rowid) when timestamps tie", () => {
    insertRaw("t1", 5000, null);
    insertRaw("t2", 5000, null);
    insertRaw("t3", 5000, null);
    initSchema(db);

    const rows = db.prepare(`SELECT id FROM messages ORDER BY seq ASC`).all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("is a no-op when run repeatedly with no NULL rows", () => {
    const messages = new MessageStore(db);
    messages.save({ id: "x", role: "user", content: "x", timestamp: 1000, connectionId: "c", sessionKey: "s" });
    messages.save({ id: "y", role: "user", content: "y", timestamp: 2000, connectionId: "c", sessionKey: "s" });
    const before = seqById();
    initSchema(db);
    initSchema(db);
    expect(seqById()).toEqual(before);
  });

  it("keeps FTS search consistent after a backfilled row is indexed", () => {
    insertRaw("ftsrow", 4000, null);
    initSchema(db);
    const hits = db
      .prepare(`SELECT id FROM messages_fts WHERE messages_fts MATCH ?`)
      .all("ftsrow") as { id: string }[];
    expect(hits.map((h) => h.id)).toEqual(["ftsrow"]);
  });

  it("backfills a fresh pre-seq database in timestamp order", () => {
    // Simulate a database created before the seq column existed.
    const legacy = new Database(":memory:");
    legacy.exec(`
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
    `);
    const ins = legacy.prepare(
      `INSERT INTO messages (id, chat_key, role, content, timestamp) VALUES (?, 'c::s', 'user', ?, ?)`
    );
    // Inserted out of timestamp order, mimicking OR REPLACE rowid churn.
    ins.run("late", "late", 3000);
    ins.run("early", "early", 1000);
    ins.run("mid", "mid", 2000);
    initSchema(legacy);
    const rows = legacy.prepare(`SELECT id, seq FROM messages ORDER BY seq ASC`).all() as { id: string; seq: number }[];
    expect(rows.map((r) => r.id)).toEqual(["early", "mid", "late"]);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(3);
    legacy.close();
  });
});
