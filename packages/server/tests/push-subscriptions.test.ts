import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { PushSubscriptionStore } from "../src/storage/push-subscriptions.js";

describe("PushSubscriptionStore", () => {
  let db: Database.Database;
  let store: PushSubscriptionStore;
  beforeEach(() => { db = new Database(":memory:"); store = new PushSubscriptionStore(db); });
  afterEach(() => db.close());

  it("upserts by endpoint and lists by token", () => {
    store.upsert({ tokenName: "Z", endpoint: "e1", p256dh: "k1", auth: "a1" });
    store.upsert({ tokenName: "Z", endpoint: "e1", p256dh: "k1b", auth: "a1b" }); // same endpoint updates
    store.upsert({ tokenName: "Z", endpoint: "e2", p256dh: "k2", auth: "a2" });
    store.upsert({ tokenName: "Y", endpoint: "e3", p256dh: "k3", auth: "a3" });
    const zs = store.listByToken("Z");
    expect(zs).toHaveLength(2);
    expect(zs.find((s) => s.endpoint === "e1")?.p256dh).toBe("k1b");
    expect(store.listByToken("Y")).toHaveLength(1);
  });

  it("deletes by endpoint", () => {
    store.upsert({ tokenName: "Z", endpoint: "e1", p256dh: "k", auth: "a" });
    store.deleteByEndpoint("e1");
    expect(store.listByToken("Z")).toHaveLength(0);
  });
});
