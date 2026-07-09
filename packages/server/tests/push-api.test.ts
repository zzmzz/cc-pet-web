import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { PushSubscriptionStore } from "../src/storage/push-subscriptions.js";
import { WebPushService } from "../src/push/web-push-service.js";
import { registerPushRoutes } from "../src/api/push.js";

const IDENTITY = { tokenName: "Z", bridgeIds: new Set<string>(["cc"]) };

describe("push API", () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let store: PushSubscriptionStore;
  beforeEach(async () => {
    db = new Database(":memory:");
    store = new PushSubscriptionStore(db);
    const webPush = new WebPushService(store, { vapidPublicKey: "PUB", vapidPrivateKey: "p", subject: "mailto:a@b.c" }, { sender: { sendNotification: async () => ({}) } });
    app = Fastify();
    registerPushRoutes(app, { store, webPush, getAuthIdentity: () => IDENTITY });
    await app.ready();
  });
  afterEach(async () => { await app.close(); db.close(); });

  it("returns the vapid public key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/push/vapid-public-key" });
    expect(res.json()).toEqual({ publicKey: "PUB" });
  });

  it("subscribes and unsubscribes for the auth token", async () => {
    const sub = { endpoint: "e1", keys: { p256dh: "k", auth: "a" } };
    const r1 = await app.inject({ method: "POST", url: "/api/push/subscribe", payload: sub });
    expect(r1.statusCode).toBe(200);
    expect(store.listByToken("Z")).toHaveLength(1);
    const r2 = await app.inject({ method: "POST", url: "/api/push/unsubscribe", payload: { endpoint: "e1" } });
    expect(r2.statusCode).toBe(200);
    expect(store.listByToken("Z")).toHaveLength(0);
  });

  it("rejects malformed subscription", async () => {
    const res = await app.inject({ method: "POST", url: "/api/push/subscribe", payload: { endpoint: "e" } });
    expect(res.statusCode).toBe(400);
  });
});
