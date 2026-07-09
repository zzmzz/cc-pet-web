import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { SessionStore } from "../src/storage/sessions.js";

describe("SessionStore resident + unread", () => {
  let db: Database.Database;
  let store: SessionStore;
  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new SessionStore(db);
  });
  afterEach(() => db.close());

  it("marks a session resident and lists it with isResident", () => {
    store.markResident("cc", "resident", "第二大脑");
    const list = store.listByConnection("cc");
    expect(list).toHaveLength(1);
    expect(list[0].isResident).toBe(true);
    expect(list[0].label).toBe("第二大脑");
    expect(list[0].unreadCount).toBe(0);
  });

  it("markResident is idempotent and preserves unread + created_at", () => {
    store.markResident("cc", "resident", "L1");
    store.incrementUnread("cc", "resident");
    const before = store.listByConnection("cc")[0];
    store.markResident("cc", "resident", "L2");
    const after = store.listByConnection("cc")[0];
    expect(after.unreadCount).toBe(1);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.label).toBe("L2");
  });

  it("increments and clears unread", () => {
    store.markResident("cc", "resident");
    expect(store.incrementUnread("cc", "resident")).toBe(1);
    expect(store.incrementUnread("cc", "resident")).toBe(2);
    expect(store.getUnread("cc", "resident")).toBe(2);
    store.clearUnread("cc", "resident");
    expect(store.getUnread("cc", "resident")).toBe(0);
  });

  it("non-resident sessions report isResident false", () => {
    const now = Date.now();
    store.create({ key: "s1", connectionId: "cc", createdAt: now, lastActiveAt: now });
    expect(store.listByConnection("cc")[0].isResident).toBe(false);
  });
});
