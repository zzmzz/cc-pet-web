import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { MessageStore } from "../src/storage/messages.js";

/**
 * `extra` is optional metadata, so one unreadable value must not be able to
 * take a whole session's history down with it. It could before: the history
 * route maps every row through toChatMessage, and a single JSON.parse throw
 * turned into a 500 for the entire chat — the session simply would not open.
 * Found the hard way, repairing rows recovered from freed SQLite pages.
 */
describe("MessageStore tolerates unreadable extra", () => {
  let db: Database.Database;
  let messages: MessageStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    messages = new MessageStore(db);
  });
  afterEach(() => db.close());

  function seed(): void {
    for (const [id, content] of [["m-1", "头一条"], ["m-2", "坏行"], ["m-3", "末一条"]]) {
      messages.save({ id, role: "user", content, timestamp: Number(id.slice(2)) * 1000, connectionId: "c", sessionKey: "s" });
    }
  }

  function corrupt(id: string, raw: string): void {
    db.prepare("UPDATE messages SET extra = ? WHERE id = ?").run(raw, id);
  }

  it("still returns the whole session when one row's extra is not JSON", () => {
    seed();
    corrupt("m-2", "{truncated");

    const rows = messages.getByChatKey("c::s");
    expect(rows.map((r) => r.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(rows.map((r) => r.content)).toEqual(["头一条", "坏行", "末一条"]);
  });

  it("drops the unreadable metadata rather than the message", () => {
    seed();
    corrupt("m-2", "{truncated");

    const bad = messages.getByChatKey("c::s").find((r) => r.id === "m-2");
    expect(bad?.content).toBe("坏行");
    expect(bad?.timestamp).toBe(2000);
  });

  it("ignores extra that parses but is not an object", () => {
    seed();
    // Spreading a string would scatter its characters across the message as
    // numeric keys; spreading a number or null silently yields nothing.
    corrupt("m-2", JSON.stringify("乱入的字符串"));

    const bad = messages.getByChatKey("c::s").find((r) => r.id === "m-2") as Record<string, unknown>;
    expect(bad.content).toBe("坏行");
    expect(bad["0"]).toBeUndefined();
  });

  it("keeps honouring well-formed extra", () => {
    messages.save({
      id: "m-ok", role: "assistant", content: "正常", timestamp: 9000,
      connectionId: "c", sessionKey: "s",
      buttons: [{ id: "b1", label: "选我", value: "v1" }],
    } as never);

    const row = messages.getByChatKey("c::s").find((r) => r.id === "m-ok") as Record<string, unknown>;
    expect(row.buttons).toEqual([{ id: "b1", label: "选我", value: "v1" }]);
  });

  it("survives a bad row on the incremental backfill path too", () => {
    seed();
    corrupt("m-2", "{truncated");

    const page = messages.getByChatKeyAfterSeq("c::s", 0, 100);
    expect(page.messages.map((r) => r.id)).toEqual(["m-1", "m-2", "m-3"]);
  });
});
