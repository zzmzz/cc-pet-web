import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { SessionStore } from "../src/storage/sessions.js";
import { MessageStore } from "../src/storage/messages.js";
import { registerSessionRoutes } from "../src/api/sessions.js";

describe("POST /api/sessions/:connectionId/:key/read", () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let store: SessionStore;
  beforeEach(async () => {
    db = new Database(":memory:");
    initSchema(db);
    store = new SessionStore(db);
    app = Fastify();
    registerSessionRoutes(app, store, new MessageStore(db));
    await app.ready();
  });
  afterEach(async () => { await app.close(); db.close(); });

  it("clears unread count", async () => {
    store.markResident("cc", "resident");
    store.incrementUnread("cc", "resident");
    const res = await app.inject({ method: "POST", url: "/api/sessions/cc/resident/read" });
    expect(res.statusCode).toBe(200);
    expect(store.getUnread("cc", "resident")).toBe(0);
  });
});
