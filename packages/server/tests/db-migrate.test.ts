import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";

describe("sessions schema migration", () => {
  it("has is_resident and unread_count columns on a fresh db", () => {
    const db = new Database(":memory:");
    initSchema(db);
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("is_resident");
    expect(cols).toContain("unread_count");
    db.close();
  });

  it("adds columns to a pre-existing sessions table without them", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (
      connection_id TEXT NOT NULL, key TEXT NOT NULL, label TEXT,
      created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
      PRIMARY KEY (connection_id, key));`);
    initSchema(db);
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("is_resident");
    expect(cols).toContain("unread_count");
    db.close();
  });
});
