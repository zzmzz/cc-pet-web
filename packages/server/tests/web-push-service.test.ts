import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { PushSubscriptionStore } from "../src/storage/push-subscriptions.js";
import { WebPushService } from "../src/push/web-push-service.js";

const config = { vapidPublicKey: "pub", vapidPrivateKey: "priv", subject: "mailto:a@b.c" };

describe("WebPushService", () => {
  let db: Database.Database;
  let store: PushSubscriptionStore;
  beforeEach(() => { db = new Database(":memory:"); store = new PushSubscriptionStore(db); });
  afterEach(() => db.close());

  it("is disabled without config and reports null public key", () => {
    const svc = new WebPushService(store, undefined);
    expect(svc.enabled).toBe(false);
    expect(svc.publicKey()).toBeNull();
  });

  it("sends to all subscriptions of a token", async () => {
    store.upsert({ tokenName: "Z", endpoint: "e1", p256dh: "k1", auth: "a1" });
    store.upsert({ tokenName: "Z", endpoint: "e2", p256dh: "k2", auth: "a2" });
    const sender = { sendNotification: vi.fn().mockResolvedValue({ statusCode: 201 }) };
    const svc = new WebPushService(store, config, { sender });
    await svc.sendToToken("Z", { title: "t", body: "b" });
    expect(sender.sendNotification).toHaveBeenCalledTimes(2);
  });

  it("prunes subscriptions that return 410/404", async () => {
    store.upsert({ tokenName: "Z", endpoint: "dead", p256dh: "k", auth: "a" });
    const sender = { sendNotification: vi.fn().mockRejectedValue({ statusCode: 410 }) };
    const svc = new WebPushService(store, config, { sender });
    await svc.sendToToken("Z", { title: "t", body: "b" });
    expect(store.listByToken("Z")).toHaveLength(0);
  });

  it("no-op when disabled", async () => {
    const sender = { sendNotification: vi.fn() };
    const svc = new WebPushService(store, undefined, { sender });
    await svc.sendToToken("Z", { title: "t", body: "b" });
    expect(sender.sendNotification).not.toHaveBeenCalled();
  });
});
