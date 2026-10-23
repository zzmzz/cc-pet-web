import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { parsePathMap, registerAssistantRoutes, toContainerPath } from "../src/api/assistant.js";
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

const SCHEMA_V4 = SCHEMA.replace("PRAGMA user_version = 3;", `
CREATE TABLE threads(session_key TEXT PRIMARY KEY, item_id INTEGER, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', progress TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE deliverables(id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, session_key TEXT, title TEXT NOT NULL, path TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
PRAGMA user_version = 4;
`);

describe("assistant API: deliverables and threads", () => {
  let dir: string;
  let outRoot: string;
  let dbPath: string;
  let app: FastifyInstance;
  let identity: AuthIdentity | null;

  async function build(p: string, opts: { outputRoot?: string; pathMap?: string } = { outputRoot: outRoot }) {
    const a = Fastify();
    registerAssistantRoutes(a, { dbPath: p, ...opts, getAuthIdentity: () => identity });
    await a.ready();
    return a;
  }

  beforeEach(async () => {
    identity = ASSISTANT;
    dir = await mkdtemp(path.join(tmpdir(), "assistant-deliv-"));
    outRoot = path.join(dir, "out");
    await mkdir(outRoot, { recursive: true });
    await writeFile(path.join(outRoot, "周报草稿.md"), "# 示例周报\n内容甲\n", "utf8");
    await writeFile(path.join(outRoot, "数据.xlsx"), Buffer.from([1, 2, 3, 4]));
    await writeFile(path.join(dir, "secret.txt"), "不该被读到", "utf8");
    dbPath = path.join(dir, "qiulai.db");
    const db = new Database(dbPath);
    db.exec(SCHEMA_V4);
    const old = "2026-10-01T08:00:00";
    db.prepare("INSERT INTO items (kind, title, created_at, updated_at) VALUES ('todo', '示例事项', ?, ?)").run(old, old);
    const ins = db.prepare(
      "INSERT INTO deliverables (item_id, session_key, title, path, summary, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    ins.run(1, "item-1", "周报草稿", path.join(outRoot, "周报草稿.md"), "按上周记录整理", "new", hoursAgo(5), hoursAgo(5));
    ins.run(null, null, "数据表", path.join(outRoot, "数据.xlsx"), "", "seen", hoursAgo(1), hoursAgo(1));
    ins.run(1, "item-1", "很早的成品", path.join(outRoot, "周报草稿.md"), "", "used", hoursAgo(24 * 4), hoursAgo(24 * 4));
    ins.run(1, null, "越界的成品", path.join(dir, "secret.txt"), "", "new", hoursAgo(1.5), hoursAgo(1.5));
    ins.run(1, null, "不见了的成品", path.join(outRoot, "没了.md"), "", "new", hoursAgo(2), hoursAgo(2));
    ins.run(1, null, "绕出去的成品", `${outRoot}/../secret.txt`, "", "new", hoursAgo(2.5), hoursAgo(2.5));
    const th = db.prepare(
      "INSERT INTO threads (session_key, item_id, title, status, progress, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    th.run("item-1", 1, "示例事项", "running", "查完一半", "planner", old, hoursAgo(1));
    th.run("task-2", null, "临时活", "stuck", "", "assistant", old, hoursAgo(2));
    db.close();
    app = await build(dbPath);
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const board = () => app.inject({ method: "GET", url: "/api/assistant/board" });
  const setStatus = (id: string | number, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/assistant/deliverables/${id}/status`, payload: payload as object });
  const file = (id: string | number) => app.inject({ method: "GET", url: `/api/assistant/deliverables/${id}/file` });

  it("keeps an older deliverable visible while it is still new", async () => {
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO deliverables (title, path, status, created_at, updated_at) VALUES ('重新登记的草稿', ?, 'new', ?, ?)",
    ).run(path.join(outRoot, "周报草稿.md"), hoursAgo(24 * 10), hoursAgo(1));
    db.close();
    const titles = (await board()).json().deliverables.map((d: { title: string }) => d.title);
    expect(titles.at(-1)).toBe("重新登记的草稿");
    expect(titles).not.toContain("很早的成品");
  });

  it("returns deliverables from the last 3 days, newest first, and all threads", async () => {
    const old = "2026-10-01T08:00:00";
    const body = (await board()).json();
    expect(body.deliverables.map((d: { title: string }) => d.title)).toEqual([
      "数据表", "越界的成品", "不见了的成品", "绕出去的成品", "周报草稿",
    ]);
    const d = body.deliverables.find((x: { title: string }) => x.title === "周报草稿");
    expect(d).toEqual({
      id: 1, itemId: 1, sessionKey: "item-1", title: "周报草稿", path: path.join(outRoot, "周报草稿.md"),
      summary: "按上周记录整理", status: "new", createdAt: hoursAgo(5),
    });
    expect(body.threads).toEqual(expect.arrayContaining([
      {
        sessionKey: "item-1", itemId: 1, title: "示例事项", status: "running", progress: "查完一半",
        parent: null, createdAt: old, updatedAt: hoursAgo(1),
      },
      {
        sessionKey: "task-2", itemId: null, title: "临时活", status: "stuck", progress: "",
        parent: null, createdAt: old, updatedAt: hoursAgo(2),
      },
    ]));
    expect(body.threads).toHaveLength(2);
  });

  it("returns each thread's parent once the database is at version 5", async () => {
    const db = new Database(dbPath);
    db.exec("ALTER TABLE threads ADD COLUMN parent TEXT; PRAGMA user_version = 5;");
    db.prepare("UPDATE threads SET parent = 'demo:resident:resident' WHERE session_key = 'task-2'").run();
    db.close();
    const threads = (await board()).json().threads as { sessionKey: string; parent: string | null }[];
    expect(Object.fromEntries(threads.map((t) => [t.sessionKey, t.parent]))).toEqual({
      "item-1": null,
      "task-2": "demo:resident:resident",
    });
  });

  it("returns empty arrays for an older database without the new tables", async () => {
    const oldPath = path.join(dir, "v3.db");
    const db = new Database(oldPath);
    db.exec(SCHEMA);
    db.close();
    const a = await build(oldPath);
    try {
      const body = (await a.inject({ method: "GET", url: "/api/assistant/board" })).json();
      expect(body.deliverables).toEqual([]);
      expect(body.threads).toEqual([]);
      const res = await a.inject({ method: "POST", url: "/api/assistant/deliverables/1/status", payload: { status: "seen" } });
      expect(res.statusCode).toBe(404);
    } finally {
      await a.close();
    }
  });

  it("updates deliverable status and logs an action for its item", async () => {
    const res = await setStatus(1, { status: "used" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 1, status: "used", itemId: 1 });
    expect((await setStatus(1, { status: "seen" })).json().status).toBe("seen");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT item_id, action, source FROM actions ORDER BY id").all();
    const d = db.prepare("SELECT status, updated_at FROM deliverables WHERE id = 1").get() as { status: string; updated_at: string };
    db.close();
    expect(rows).toEqual([
      { item_id: 1, action: "deliverable_used", source: "web" },
      { item_id: 1, action: "deliverable_seen", source: "web" },
    ]);
    expect(d.status).toBe("seen");
    expect(d.updated_at).not.toBe(hoursAgo(5));
  });

  it("updates a deliverable that has no item without writing an action", async () => {
    const res = await setStatus(2, { status: "dismissed" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("dismissed");
    const db = new Database(dbPath, { readonly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n;
    db.close();
    expect(n).toBe(0);
  });

  it("validates deliverable status requests", async () => {
    expect((await setStatus("x", { status: "seen" })).statusCode).toBe(400);
    expect((await setStatus(1, { status: "new" })).statusCode).toBe(400);
    expect((await setStatus(1, {})).statusCode).toBe(400);
    expect((await setStatus(999, { status: "seen" })).statusCode).toBe(404);
    identity = PLAIN;
    expect((await setStatus(1, { status: "seen" })).statusCode).toBe(403);
    expect((await file(1)).statusCode).toBe(403);
    identity = null;
    expect((await setStatus(1, { status: "seen" })).statusCode).toBe(401);
    expect((await file(1)).statusCode).toBe(401);
  });

  it("serves md as text and other files as attachments", async () => {
    const md = await file(1);
    expect(md.statusCode).toBe(200);
    expect(md.headers["content-type"]).toMatch(/^text\/markdown; charset=utf-8/);
    expect(md.body).toBe("# 示例周报\n内容甲\n");
    expect(md.headers["content-disposition"]).toBeUndefined();
    expect(md.headers["content-length"]).toBe(String(Buffer.byteLength("# 示例周报\n内容甲\n")));
    expect(md.headers["x-content-type-options"]).toBe("nosniff");

    const bin = await file(2);
    expect(bin.statusCode).toBe(200);
    expect(bin.headers["content-type"]).toBe("application/octet-stream");
    expect(bin.headers["content-disposition"]).toContain("attachment;");
    expect(bin.headers["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent("数据.xlsx")}`);
    expect(bin.rawPayload).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(bin.headers["content-length"]).toBe("4");
    expect(bin.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("allows a file whose name merely starts with two dots", async () => {
    await writeFile(path.join(outRoot, "..notes.md"), "笔记", "utf8");
    const db = new Database(dbPath);
    db.prepare("INSERT INTO deliverables (title, path, created_at, updated_at) VALUES ('点开头', ?, ?, ?)")
      .run(path.join(outRoot, "..notes.md"), hoursAgo(1), hoursAgo(1));
    db.close();
    const res = await file(7);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("笔记");
  });

  it("404s every file when no output root is configured", async () => {
    for (const opts of [{}, { outputRoot: "" }]) {
      const a = await build(dbPath, opts);
      try {
        const res = await a.inject({ method: "GET", url: "/api/assistant/deliverables/1/file" });
        expect(res.statusCode).toBe(404);
      } finally {
        await a.close();
      }
    }
  });

  it("maps host paths through the configured prefix before reading", async () => {
    const db = new Database(dbPath);
    db.prepare("INSERT INTO deliverables (title, path, created_at, updated_at) VALUES ('宿主路径', ?, ?, ?)")
      .run("/srv/work/out/周报草稿.md", hoursAgo(1), hoursAgo(1));
    db.close();
    const unmapped = await file(7);
    expect(unmapped.statusCode).toBe(403);
    const a = await build(dbPath, { outputRoot: outRoot, pathMap: `/srv/work/=${dir}/` });
    try {
      const res = await a.inject({ method: "GET", url: "/api/assistant/deliverables/7/file" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("# 示例周报\n内容甲\n");
    } finally {
      await a.close();
    }
  });

  it("refuses files outside the output root and 404s missing ones", async () => {
    expect((await file(4)).statusCode).toBe(403);
    expect((await file(6)).statusCode).toBe(403);
    expect((await file(5)).statusCode).toBe(404);
    expect((await file(999)).statusCode).toBe(404);
    expect((await file("abc")).statusCode).toBe(400);
  });

  it("refuses a symlink inside the root that points outside", async () => {
    await symlink(path.join(dir, "secret.txt"), path.join(outRoot, "link.txt"));
    const db = new Database(dbPath);
    db.prepare("INSERT INTO deliverables (title, path, created_at, updated_at) VALUES ('链接', ?, ?, ?)")
      .run(path.join(outRoot, "link.txt"), hoursAgo(1), hoursAgo(1));
    db.close();
    expect((await file(7)).statusCode).toBe(403);
  });
});

describe("toContainerPath", () => {
  it("maps only whole-directory host prefixes", () => {
    const map = parsePathMap("/srv/work/=/data/work/");
    expect(map).toEqual({ host: "/srv/work", container: "/data/work" });
    expect(toContainerPath("/srv/work/out/a.md", map)).toBe("/data/work/out/a.md");
    expect(toContainerPath("/data/work/out/a.md", map)).toBe("/data/work/out/a.md");
    expect(toContainerPath("/srv/workX/a.md", map)).toBe("/srv/workX/a.md");
    expect(toContainerPath("/srv/work", map)).toBe("/data/work");
  });

  it("leaves paths alone when the map is unset or malformed", () => {
    for (const raw of [undefined, "", "/srv/work", "=/data/out", "/srv/work=", "/=/data/out"]) {
      const map = parsePathMap(raw);
      expect(map, String(raw)).toBeNull();
      expect(toContainerPath("/srv/work/a.md", map)).toBe("/srv/work/a.md");
    }
  });
});
