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

    it("keeps both messages written within the same millisecond", () => {
      const ts = Date.now();
      messages.save({
        id: "msg-a", role: "assistant", content: "first",
        timestamp: ts, connectionId: "conn-1", sessionKey: "default",
      });
      messages.save({
        id: "msg-b", role: "assistant", content: "second",
        timestamp: ts, connectionId: "conn-1", sessionKey: "default",
      });
      const result = messages.getByChatKey("conn-1::default");
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.content).sort()).toEqual(["first", "second"]);
    });

    it("updates the same id in place without moving its row", () => {
      const rowidOf = (id: string) =>
        (db.prepare(`SELECT rowid FROM messages WHERE id = ?`).get(id) as { rowid: number }).rowid;

      messages.save({
        id: "msg-dup", role: "user", content: "original",
        timestamp: 1000, connectionId: "conn-1", sessionKey: "default",
      });
      const originalRowid = rowidOf("msg-dup");
      messages.save({
        id: "msg-later", role: "assistant", content: "later",
        timestamp: 2000, connectionId: "conn-1", sessionKey: "default",
      });
      messages.save({
        id: "msg-dup", role: "user", content: "edited",
        timestamp: 1000, connectionId: "conn-1", sessionKey: "default",
      });

      expect(rowidOf("msg-dup")).toBe(originalRowid);
      const result = messages.getByChatKey("conn-1::default");
      expect(result).toHaveLength(2);
      expect(result.find((m) => m.id === "msg-dup")!.content).toBe("edited");
    });

    it("assigns monotonically increasing seq to new messages", () => {
      messages.save({
        id: "m1", role: "user", content: "a",
        timestamp: 5000, connectionId: "c", sessionKey: "s",
      });
      messages.save({
        id: "m2", role: "assistant", content: "b",
        timestamp: 5000, connectionId: "c", sessionKey: "s",
      });
      const [first, second] = messages.getByChatKey("c::s");
      expect(typeof first.seq).toBe("number");
      expect(second.seq!).toBeGreaterThan(first.seq!);
    });

    it("preserves seq when an existing message is updated", () => {
      messages.save({
        id: "m1", role: "user", content: "a",
        timestamp: 1000, connectionId: "c", sessionKey: "s",
      });
      const originalSeq = messages.getByChatKey("c::s")[0].seq;
      messages.save({
        id: "m2", role: "assistant", content: "b",
        timestamp: 2000, connectionId: "c", sessionKey: "s",
      });
      messages.save({
        id: "m1", role: "user", content: "a-edited",
        timestamp: 1000, connectionId: "c", sessionKey: "s",
      });
      const rows = messages.getByChatKey("c::s");
      const m1 = rows.find((r) => r.id === "m1")!;
      expect(m1.seq).toBe(originalSeq);
      expect(m1.content).toBe("a-edited");
      expect(rows[0].id).toBe("m1");
    });

    it("returns the assigned seq from save and the original seq on conflict", () => {
      const first = messages.save({
        id: "m1", role: "user", content: "a",
        timestamp: 1000, connectionId: "c", sessionKey: "s",
      });
      messages.save({
        id: "m2", role: "assistant", content: "b",
        timestamp: 2000, connectionId: "c", sessionKey: "s",
      });
      const again = messages.save({
        id: "m1", role: "user", content: "a-edited",
        timestamp: 1000, connectionId: "c", sessionKey: "s",
      });
      expect(again).toBe(first);
    });

    it("orders by seq so same-timestamp messages stay stable", () => {
      const ts = 7000;
      for (const id of ["x1", "x2", "x3"]) {
        messages.save({
          id, role: "assistant", content: id,
          timestamp: ts, connectionId: "c", sessionKey: "s",
        });
      }
      expect(messages.getByChatKey("c::s").map((m) => m.id)).toEqual(["x1", "x2", "x3"]);
    });

    describe("incremental history", () => {
      beforeEach(() => {
        for (let i = 1; i <= 5; i++) {
          messages.save({
            id: `n${i}`, role: "assistant", content: `c${i}`,
            timestamp: 1000 + i, connectionId: "c", sessionKey: "s",
          });
        }
      });

      it("returns only messages after the given seq", () => {
        const all = messages.getByChatKey("c::s");
        const cursor = all[1].seq!;
        const { messages: got, hasMore } = messages.getByChatKeyAfterSeq("c::s", cursor, 200);
        expect(got.map((m) => m.id)).toEqual(["n3", "n4", "n5"]);
        expect(hasMore).toBe(false);
      });

      it("caps at limit and reports hasMore", () => {
        const { messages: got, hasMore } = messages.getByChatKeyAfterSeq("c::s", 0, 2);
        expect(got).toHaveLength(2);
        expect(hasMore).toBe(true);
      });

      it("returns empty and hasMore=false when already caught up", () => {
        const all = messages.getByChatKey("c::s");
        const { messages: got, hasMore } = messages.getByChatKeyAfterSeq("c::s", all[4].seq!, 200);
        expect(got).toEqual([]);
        expect(hasMore).toBe(false);
      });
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

  it("backfills seq for a pre-existing database ordered by timestamp", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, timestamp INTEGER NOT NULL,
        connection_id TEXT, session_key TEXT, extra TEXT
      );
    `);
    const ins = legacy.prepare(
      `INSERT INTO messages (id, chat_key, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)`
    );
    ins.run("old-b", "c::s", "second", 2000);
    ins.run("old-a", "c::s", "first", 1000);

    initSchema(legacy);

    const rows = new MessageStore(legacy).getByChatKey("c::s");
    expect(rows.map((r) => r.id)).toEqual(["old-a", "old-b"]);
    expect(rows[0].seq!).toBeLessThan(rows[1].seq!);
    legacy.close();
  });

  describe("ConfigStore", () => {
    it("should save and load config", () => {
      const cfg = {
        bridges: [],
        tokens: [],
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
            workspacePath: dir,
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
      expect(loaded.bridges[0]?.workspacePath).toBe(dir);
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
            workspacePath: path.join(dir, "next-workspace"),
          },
        ],
      };
      fileStore.save(next);
      const raw = JSON.parse(await readFile(filePath, "utf8"));
      expect(raw.bridges[0].id).toBe("b2");
      expect(raw.bridges[0].workspacePath).toBe(path.join(dir, "next-workspace"));

      await rm(dir, { recursive: true, force: true });
    });

    it("keeps old bridge configs compatible when workspacePath is absent", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cc-pet-cfg-"));
      const filePath = path.join(dir, "app.json");
      const fileCfg = {
        bridges: [
          {
            id: "legacy",
            name: "legacy-bridge",
            host: "127.0.0.1",
            port: 9810,
            token: "secret",
            enabled: true,
          },
        ],
        tokens: [],
        pet: { opacity: 1, size: 120 },
        server: { port: 3000, dataDir: "./data" },
      };
      await writeFile(filePath, JSON.stringify(fileCfg), "utf8");

      const fileStore = new ConfigStore(db, { configFilePath: filePath });
      const loaded = fileStore.load();

      expect(loaded.bridges[0]).toEqual({
        id: "legacy",
        name: "legacy-bridge",
        host: "127.0.0.1",
        port: 9810,
        token: "secret",
        enabled: true,
      });

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
