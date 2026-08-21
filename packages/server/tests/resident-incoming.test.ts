import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { SessionStore } from "../src/storage/sessions.js";
import { ResidentRegistry } from "../src/resident/registry.js";
import { onResidentAssistantMessage } from "../src/resident/incoming.js";
import type { AppConfig } from "@cc-pet/shared";

function makeDeps(db: Database.Database) {
  const sessionStore = new SessionStore(db);
  const config: AppConfig = {
    bridges: [], pet: { opacity: 1, size: 1 }, server: { port: 0, dataDir: "." },
    tokens: [{ token: "t", name: "Z", bridgeIds: ["cc"], residentSession: { bridgeId: "cc", key: "resident" } }],
  };
  // bootstrap 后常驻会话的实际 key 是合规格式 "cc:resident:resident"
  const registry = new ResidentRegistry(config);
  registry.bootstrap(sessionStore);
  return { registry, sessionStore };
}

describe("onResidentAssistantMessage", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); initSchema(db); });
  afterEach(() => db.close());

  it("increments unread and returns owner token for resident session", () => {
    const deps = makeDeps(db);
    const r = onResidentAssistantMessage(deps, "cc", "cc:resident:resident");
    expect(r).toEqual({ unreadCount: 1, ownerToken: "Z" });
    expect(onResidentAssistantMessage(deps, "cc", "cc:resident:resident")?.unreadCount).toBe(2);
  });

  it("returns null for non-resident session", () => {
    const deps = makeDeps(db);
    expect(onResidentAssistantMessage(deps, "cc", "cc:other:other")).toBeNull();
  });
});
