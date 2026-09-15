import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { MessageStore } from "../src/storage/messages.js";

describe("upstream message id adoption", () => {
  let db: Database.Database;
  let messages: MessageStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    messages = new MessageStore(db);
  });
  afterEach(() => db.close());

  it("is idempotent when the client resends the same clientMsgId", () => {
    const clientMsgId = "client-uuid-1";
    for (let i = 0; i < 3; i++) {
      messages.save({
        id: clientMsgId, role: "user", content: "hello",
        timestamp: 1000, connectionId: "c", sessionKey: "s",
      });
    }
    const rows = messages.getByChatKey("c::s");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(clientMsgId);
  });

  it("exposes seq so the server can ack with it", () => {
    messages.save({
      id: "client-uuid-2", role: "user", content: "hi",
      timestamp: 1000, connectionId: "c", sessionKey: "s",
    });
    expect(messages.getByChatKey("c::s")[0].seq).toBeTypeOf("number");
  });

  // The ack reads save()'s return value, not the row — a resend must ack the original seq.
  it("returns the original seq when the client resends", () => {
    const msg = {
      id: "client-uuid-3", role: "user" as const, content: "hi",
      timestamp: 1000, connectionId: "c", sessionKey: "s",
    };
    const first = messages.save(msg);
    expect(first).toBeTypeOf("number");
    messages.save({ ...msg, id: "other", timestamp: 1001 });
    expect(messages.save(msg)).toBe(first);
  });

  // The bridge forward is skipped for an id the store already knows, so a lost
  // ack cannot make Claude re-run the whole turn.
  describe("saveWithStatus", () => {
    const msg = {
      id: "client-uuid-4", role: "user" as const, content: "run the task",
      timestamp: 1000, connectionId: "c", sessionKey: "s",
    };

    it("reports inserted=true for an id the store has never seen", () => {
      expect(messages.saveWithStatus(msg)).toEqual({
        seq: expect.any(Number),
        inserted: true,
      });
    });

    it("reports inserted=false for a resend, keeping the original seq", () => {
      const first = messages.saveWithStatus(msg);
      messages.saveWithStatus({ ...msg, id: "unrelated", timestamp: 1001 });
      const again = messages.saveWithStatus(msg);
      expect(again.inserted).toBe(false);
      expect(again.seq).toBe(first.seq);
    });

    // Clients order history by timestamp. Stamping a resend with the retry
    // time sorted the question after the answers it had already produced.
    it("keeps the original timestamp when the client resends", () => {
      messages.save({ ...msg, timestamp: 1000 });
      messages.save({
        id: "reply", role: "assistant", content: "done",
        timestamp: 2000, connectionId: "c", sessionKey: "s",
      });
      messages.save({ ...msg, timestamp: 3000 });

      const rows = messages.getByChatKey("c::s");
      expect(rows.map((r) => r.id)).toEqual([msg.id, "reply"]);
      expect(rows[0].timestamp).toBe(1000);
    });

    it("keeps save() returning the seq for existing callers", () => {
      const seq = messages.save(msg);
      expect(seq).toBeTypeOf("number");
      expect(messages.saveWithStatus(msg).seq).toBe(seq);
    });
  });
});
