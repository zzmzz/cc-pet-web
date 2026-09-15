import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { SessionStore } from "../src/storage/sessions.js";
import { SessionsCleanup } from "../src/cleanup/sessions-cleanup.js";

describe("SessionsCleanup excludes resident", () => {
  let db: Database.Database;
  let store: SessionStore;
  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new SessionStore(db);
  });
  afterEach(() => db.close());

  it("keeps resident sessions even when long inactive; deletes stale normal ones", () => {
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    store.markResident("cc", "resident");
    db.prepare("UPDATE sessions SET last_active_at = ? WHERE connection_id='cc' AND key='resident'").run(old);
    store.create({ key: "stale", connectionId: "cc", createdAt: old, lastActiveAt: old });

    const cleanup = new SessionsCleanup(store, db);
    const deleted = cleanup.cleanupInactiveSessions(10);

    expect(deleted).toBe(1);
    const keys = store.listByConnection("cc").map((s) => s.key);
    expect(keys).toContain("resident");
    expect(keys).not.toContain("stale");
  });
});
