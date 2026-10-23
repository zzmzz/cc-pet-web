import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { registerAssistantRoutes } from "../src/api/assistant.js";
import type { AuthIdentity } from "../src/auth/token-auth.js";

const ASSISTANT: AuthIdentity = { tokenName: "A", bridgeIds: new Set(), ui: "assistant" };
const PLAIN: AuthIdentity = { tokenName: "B", bridgeIds: new Set() };

function pad(n: number) { return String(n).padStart(2, "0"); }
function iso(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const hoursAgo = (h: number) => iso(new Date(Date.now() - h * 3600 * 1000));

const SCHEMA = `
CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', date TEXT, time TEXT, deadline INTEGER NOT NULL DEFAULT 0, people TEXT NOT NULL DEFAULT '[]', sources TEXT NOT NULL DEFAULT '[]', draft TEXT, status TEXT NOT NULL DEFAULT 'open', closed_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal');
CREATE TABLE actions(id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, action TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL);
PRAGMA user_version = 3;
`;

describe("assistant API", () => {
  let dir: string;
  let dbPath: string;
  let app: FastifyInstance;
  let identity: AuthIdentity | null;

  async function build(p: string) {
    const a = Fastify();
    registerAssistantRoutes(a, { dbPath: p, getAuthIdentity: () => identity });
    await a.ready();
    return a;
  }

  beforeEach(async () => {
    identity = ASSISTANT;
    dir = await mkdtemp(path.join(tmpdir(), "assistant-api-"));
    dbPath = path.join(dir, "qiulai.db");
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    const ins = db.prepare(
      "INSERT INTO items (kind, title, detail, date, time, deadline, people, status, closed_reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    const old = "2026-10-01T08:00:00";
    ins.run("todo", "整理示例周报", "细节甲", "2026-10-25", "10:00", 1, '["小甲","小乙"]', "open", null, old, old);
    ins.run("waiting", "等示例回复", "", null, null, 0, "not json", "open", null, old, old);
    ins.run("todo", "刚做完的事", "", null, null, 0, "[]", "done", "已完成", old, hoursAgo(2));
    ins.run("todo", "刚放弃的事", "", null, null, 0, "[]", "dismissed", "不用了", old, hoursAgo(1));
    ins.run("todo", "很早做完的事", "", null, null, 0, "[]", "done", "已完成", old, hoursAgo(30));
    db.prepare("UPDATE items SET priority = 'high' WHERE id = 1").run();
    db.prepare("UPDATE items SET priority = 'urgent' WHERE id = 3").run();
    db.close();
    app = await build(dbPath);
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const get = () => app.inject({ method: "GET", url: "/api/assistant/board" });
  const post = (id: string | number, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/assistant/items/${id}/status`, payload: payload as object });

  it("returns 401 without identity", async () => {
    identity = null;
    expect((await get()).statusCode).toBe(401);
    expect((await post(1, { status: "done" })).statusCode).toBe(401);
  });

  it("returns 403 for non-assistant tokens", async () => {
    identity = PLAIN;
    expect((await get()).statusCode).toBe(403);
    expect((await post(1, { status: "done" })).statusCode).toBe(403);
  });

  it("returns 503 when the database file is missing", async () => {
    const a = await build(path.join(dir, "nope", "qiulai.db"));
    try {
      const res = await a.inject({ method: "GET", url: "/api/assistant/board" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "助手数据还没准备好" });
    } finally {
      await a.close();
    }
  });

  it("returns open items and items closed in the last 24h", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(["整理示例周报", "等示例回复"]);
    expect(body.items[0]).toMatchObject({
      id: 1, kind: "todo", detail: "细节甲", date: "2026-10-25", time: "10:00",
      deadline: true, people: ["小甲", "小乙"], status: "open", closedReason: null,
    });
    expect(body.items[1].people).toEqual([]);
    expect(body.items[1].deadline).toBe(false);
    expect(body.closedRecent.map((i: { title: string }) => i.title)).toEqual(["刚放弃的事", "刚做完的事"]);
    expect(body.closedRecent[0].closedReason).toBe("不用了");
    expect(typeof body.generatedAt).toBe("string");
    expect(body.plannedAt).toBeNull();
  });

  it("returns each item's priority, treating unknown values as normal", async () => {
    const body = (await get()).json();
    expect(body.items.map((i: { priority: string }) => i.priority)).toEqual(["high", "normal"]);
    expect(body.closedRecent.map((i: { priority: string }) => i.priority)).toEqual(["normal", "normal"]);
    expect((await post(1, { status: "done" })).json().priority).toBe("high");
  });

  it("treats every item as normal when the database has no priority column", async () => {
    const oldPath = path.join(dir, "old.db");
    const db = new Database(oldPath);
    db.exec(SCHEMA.replace(", priority TEXT NOT NULL DEFAULT 'normal'", "").replace("user_version = 3", "user_version = 2"));
    const at = "2026-10-01T08:00:00";
    expect((db.pragma("table_info(items)") as { name: string }[]).some((c) => c.name === "priority")).toBe(false);
    db.prepare("INSERT INTO items (kind, title, created_at, updated_at) VALUES ('todo', '旧库里的事', ?, ?)").run(at, at);
    db.close();
    const a = await build(oldPath);
    try {
      const res = await a.inject({ method: "GET", url: "/api/assistant/board" });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([expect.objectContaining({ title: "旧库里的事", priority: "normal" })]);
      const res2 = await a.inject({ method: "POST", url: "/api/assistant/items/1/status", payload: { status: "done" } });
      expect(res2.json()).toMatchObject({ status: "done", priority: "normal" });
    } finally {
      await a.close();
    }
  });

  it("reads plannedAt from the sibling file", async () => {
    await writeFile(path.join(dir, "last_planned_at"), "2026-10-23T09:05:00\n", "utf8");
    expect((await get()).json().plannedAt).toBe("2026-10-23T09:05:00");
  });

  it("updates status, writes an action row, and clears the reason on reopen", async () => {
    const res = await post(1, { status: "done" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 1, status: "done", closedReason: "你在页面上标了做完" });
    expect(res.json().updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

    const res2 = await post(1, { status: "dismissed" });
    expect(res2.json().closedReason).toBe("你在页面上标了不用了");

    const res3 = await post(1, { status: "open" });
    expect(res3.json()).toMatchObject({ status: "open", closedReason: null });

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT item_id, action, source FROM actions ORDER BY id").all();
    db.close();
    expect(rows).toEqual([
      { item_id: 1, action: "done", source: "web" },
      { item_id: 1, action: "dismissed", source: "web" },
      { item_id: 1, action: "open", source: "web" },
    ]);
  });

  it("rejects invalid id or status with 400", async () => {
    expect((await post("abc", { status: "done" })).statusCode).toBe(400);
    expect((await post("0", { status: "done" })).statusCode).toBe(400);
    expect((await post("-3", { status: "done" })).statusCode).toBe(400);
    expect((await post("1.5", { status: "done" })).statusCode).toBe(400);
    expect((await post(1, { status: "bogus" })).statusCode).toBe(400);
    expect((await post(1, {})).statusCode).toBe(400);
  });

  it("returns 404 for a missing item and writes no action", async () => {
    expect((await post(999, { status: "done" })).statusCode).toBe(404);
    const db = new Database(dbPath, { readonly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n;
    db.close();
    expect(n).toBe(0);
  });
});
