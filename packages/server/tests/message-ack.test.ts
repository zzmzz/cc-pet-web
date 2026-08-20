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
});
