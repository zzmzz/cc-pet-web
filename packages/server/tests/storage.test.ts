import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../src/storage/db.js";
import { MessageStore } from "../src/storage/messages.js";
import { SessionStore } from "../src/storage/sessions.js";
import { ConfigStore } from "../src/storage/config.js";

describe("Storage", () => {
  let db: Database.Database;
  let messages: MessageStore;
  let sessions: SessionStore;
  let config: ConfigStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    messages = new MessageStore(db);
    sessions = new SessionStore(db);
    config = new ConfigStore(db);
  });

  afterEach(() => db.close());

  describe("MessageStore", () => {
    it("should save and retrieve messages", () => {
      messages.save({
        id: "msg-1", role: "user", content: "hello",
        timestamp: Date.now(), connectionId: "conn-1", sessionKey: "default",
      });
      const result = messages.getByChatKey("conn-1::default");
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("hello");
    });

    it("should delete messages by chatKey", () => {
      messages.save({
        id: "msg-1", role: "user", content: "hello",
        timestamp: Date.now(), connectionId: "conn-1", sessionKey: "default",
      });
      messages.deleteByChatKey("conn-1::default");
      expect(messages.getByChatKey("conn-1::default")).toHaveLength(0);
    });
  });

  describe("SessionStore", () => {
    it("should create and list sessions", () => {
      sessions.create({ key: "s1", connectionId: "conn-1", createdAt: Date.now(), lastActiveAt: Date.now() });
      const list = sessions.listByConnection("conn-1");
      expect(list).toHaveLength(1);
      expect(list[0].key).toBe("s1");
    });

    it("should delete a session", () => {
      sessions.create({ key: "s1", connectionId: "conn-1", createdAt: Date.now(), lastActiveAt: Date.now() });
      sessions.delete("conn-1", "s1");
      expect(sessions.listByConnection("conn-1")).toHaveLength(0);
    });

    it("should update label", () => {
      sessions.create({ key: "s1", connectionId: "conn-1", createdAt: Date.now(), lastActiveAt: Date.now() });
      sessions.updateLabel("conn-1", "s1", "My Session");
      const list = sessions.listByConnection("conn-1");
      expect(list[0].label).toBe("My Session");
    });

    it("listByConnection orders by last_active_at descending", () => {
      const tOld = 1_700_000_000_000;
      const tNew = tOld + 60_000;
      sessions.create({ key: "older", connectionId: "conn-1", createdAt: tOld, lastActiveAt: tOld });
      sessions.create({ key: "newer", connectionId: "conn-1", createdAt: tNew, lastActiveAt: tNew });
      const keys = sessions.listByConnection("conn-1").map((s) => s.key);
      expect(keys).toEqual(["newer", "older"]);
    });

    it("touchActive updates last_active_at and affects list order", () => {
      const base = 1_700_000_000_000;
      sessions.create({ key: "a", connectionId: "conn-1", createdAt: base, lastActiveAt: base + 10_000 });
      sessions.create({ key: "b", connectionId: "conn-1", createdAt: base, lastActiveAt: base });
      expect(sessions.listByConnection("conn-1").map((s) => s.key)).toEqual(["a", "b"]);

      const touched = base + 50_000;
      const spy = vi.spyOn(Date, "now").mockReturnValue(touched);
      try {
        sessions.touchActive("conn-1", "b");
      } finally {
        spy.mockRestore();
      }

      const after = sessions.listByConnection("conn-1");
      expect(after.map((s) => s.key)).toEqual(["b", "a"]);
      expect(after.find((s) => s.key === "b")?.lastActiveAt).toBe(touched);
    });
  });

  describe("ConfigStore", () => {
    it("should save and load config", () => {
      const cfg = {
        bridges: [],
        tokens: [],
        corsOrigins: [],
        pet: { opacity: 1, size: 120 },
        server: { port: 3000, dataDir: "./data" },
      };
      config.save(cfg);
      const loaded = config.load();
      expect(loaded).toEqual(cfg);
    });

    it("loads bridges from local config file when configFilePath exists", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cc-pet-cfg-"));
      const filePath = path.join(dir, "app.json");
      const fileCfg = {
        bridges: [
          {
            id: "b1",
            name: "bridge-one",
            host: "127.0.0.1",
            port: 9810,
            token: "secret",
            enabled: true,
          },
        ],
        pet: { opacity: 0.5, size: 100 },
        server: { port: 3000, dataDir: "./data" },
      };
      await writeFile(filePath, JSON.stringify(fileCfg), "utf8");

      const fileStore = new ConfigStore(db, { configFilePath: filePath });
      const loaded = fileStore.load();
      expect(loaded.bridges).toHaveLength(1);
      expect(loaded.bridges[0]?.id).toBe("b1");
      expect(loaded.pet.opacity).toBe(0.5);

      const next = {
        ...loaded,
        bridges: [
          {
            id: "b2",
            name: "bridge-two",
            host: "127.0.0.1",
            port: 9811,
            token: "",
            enabled: true,
          },
        ],
      };
      fileStore.save(next);
      const raw = JSON.parse(await readFile(filePath, "utf8"));
      expect(raw.bridges[0].id).toBe("b2");

      await rm(dir, { recursive: true, force: true });
    });

    it("keeps token petImages when idle path is provided", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cc-pet-cfg-"));
      const filePath = path.join(dir, "app.json");
      const fileCfg = {
        bridges: [],
        tokens: [
          {
            token: "t1",
            name: "u1",
            bridgeIds: [],
            petImages: {
              idle: "/tmp/pet/idle.png",
              talking: "/tmp/pet/talking.png",
            },
          },
        ],
        pet: { opacity: 1, size: 120 },
        server: { port: 3000, dataDir: "./data" },
      };
      await writeFile(filePath, JSON.stringify(fileCfg), "utf8");

      const fileStore = new ConfigStore(db, { configFilePath: filePath });
      const loaded = fileStore.load();
      expect(loaded.tokens[0]?.petImages).toEqual({
        idle: "/tmp/pet/idle.png",
        talking: "/tmp/pet/talking.png",
      });

      await rm(dir, { recursive: true, force: true });
    });

    it("drops token petImages when idle path is missing", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cc-pet-cfg-"));
      const filePath = path.join(dir, "app.json");
      const fileCfg = {
        bridges: [],
        tokens: [
          {
            token: "t1",
            name: "u1",
            bridgeIds: [],
            petImages: {
              talking: "/tmp/pet/talking.png",
            },
          },
        ],
        pet: { opacity: 1, size: 120 },
        server: { port: 3000, dataDir: "./data" },
      };
      await writeFile(filePath, JSON.stringify(fileCfg), "utf8");

      const fileStore = new ConfigStore(db, { configFilePath: filePath });
      const loaded = fileStore.load();
      expect(loaded.tokens[0]?.petImages).toBeUndefined();

      await rm(dir, { recursive: true, force: true });
    });
  });
});
