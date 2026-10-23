import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { ConfigStore } from "../src/storage/config.js";
import { registerConfigRoutes } from "../src/api/config.js";
import type { AuthIdentity } from "../src/auth/token-auth.js";

describe("config API access by ui mode", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let identity: AuthIdentity;

  beforeEach(async () => {
    db = new Database(":memory:");
    initSchema(db);
    const store = new ConfigStore(db);
    identity = { tokenName: "A", bridgeIds: new Set() };
    app = Fastify();
    registerConfigRoutes(app, store, () => identity);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("rejects assistant tokens on GET and PUT", async () => {
    identity = { tokenName: "A", bridgeIds: new Set(), ui: "assistant" };
    expect((await app.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(403);
    const put = await app.inject({ method: "PUT", url: "/api/config", payload: { tokens: [] } });
    expect(put.statusCode).toBe(403);
  });

  it("lets normal tokens through", async () => {
    const get = await app.inject({ method: "GET", url: "/api/config" });
    expect(get.statusCode).toBe(200);
    const put = await app.inject({ method: "PUT", url: "/api/config", payload: get.json() });
    expect(put.statusCode).toBe(200);
  });
});
