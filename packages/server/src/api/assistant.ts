import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthIdentity } from "../auth/token-auth.js";

export interface AssistantRoutesDeps {
  /** 助手数据库路径；库由外部后台建表和迁移，这里只读写 */
  dbPath: string;
  getAuthIdentity: (req: FastifyRequest) => AuthIdentity | null;
}

type ItemStatus = "open" | "done" | "dismissed";
type Priority = "high" | "normal" | "low";
const PRIORITIES: readonly string[] = ["high", "normal", "low"];
const STATUSES: readonly string[] = ["open", "done", "dismissed"];

const CLOSED_REASON: Record<ItemStatus, string | null> = {
  open: null,
  done: "你在页面上标了做完",
  dismissed: "你在页面上标了不用了",
};

interface ItemRow {
  id: number;
  kind: string;
  title: string;
  detail: string;
  date: string | null;
  time: string | null;
  deadline: number;
  people: string;
  status: string;
  closed_reason: string | null;
  created_at: string;
  updated_at: string;
  /** 旧库没有这一列 */
  priority?: string | null;
}

const BASE_COLUMNS =
  "id, kind, title, detail, date, time, deadline, people, status, closed_reason, created_at, updated_at";

/** 优先级列是后台第 3 版库才加的；旧库照样能读，全当 normal */
function itemColumns(db: Database.Database): string {
  const cols = db.pragma("table_info(items)") as { name: string }[];
  return cols.some((c) => c.name === "priority") ? `${BASE_COLUMNS}, priority` : BASE_COLUMNS;
}

function toPriority(raw: string | null | undefined): Priority {
  return typeof raw === "string" && PRIORITIES.includes(raw) ? (raw as Priority) : "normal";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 本地时间、秒精度、不带时区，和后台写入的格式一致，如 2026-10-23T09:05:00 */
function localIso(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function parsePeople(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function toItem(r: ItemRow) {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    date: r.date,
    time: r.time,
    deadline: r.deadline === 1,
    people: parsePeople(r.people),
    status: r.status,
    closedReason: r.closed_reason,
    priority: toPriority(r.priority),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function readPlannedAt(dbPath: string): string | null {
  try {
    const text = fs.readFileSync(path.join(path.dirname(dbPath), "last_planned_at"), "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function registerAssistantRoutes(app: FastifyInstance, deps: AssistantRoutesDeps): void {
  const { dbPath, getAuthIdentity } = deps;

  /** 返回 true 表示已回复错误，调用方直接结束 */
  function rejectUnlessAssistant(req: FastifyRequest, reply: FastifyReply): boolean {
    const auth = getAuthIdentity(req);
    if (!auth) {
      void reply.code(401).send({ error: "Unauthorized" });
      return true;
    }
    if (auth.ui !== "assistant") {
      void reply.code(403).send({ error: "Forbidden" });
      return true;
    }
    if (!fs.existsSync(dbPath)) {
      void reply.code(503).send({ error: "助手数据还没准备好" });
      return true;
    }
    return false;
  }

  app.get("/api/assistant/board", async (req, reply) => {
    if (rejectUnlessAssistant(req, reply)) return reply;
    const now = new Date();
    const cutoff = localIso(new Date(now.getTime() - 24 * 3600 * 1000));
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma("busy_timeout = 5000");
      const cols = itemColumns(db);
      const open = db
        .prepare(`SELECT ${cols} FROM items WHERE status = 'open' ORDER BY id`)
        .all() as ItemRow[];
      const closed = db
        .prepare(
          `SELECT ${cols} FROM items WHERE status IN ('done', 'dismissed') AND updated_at >= ? ORDER BY updated_at DESC`,
        )
        .all(cutoff) as ItemRow[];
      return {
        items: open.map(toItem),
        closedRecent: closed.map(toItem),
        plannedAt: readPlannedAt(dbPath),
        generatedAt: now.toISOString(),
      };
    } finally {
      db.close();
    }
  });

  app.post<{ Params: { id: string }; Body: { status?: unknown } }>(
    "/api/assistant/items/:id/status",
    async (req, reply) => {
      if (rejectUnlessAssistant(req, reply)) return reply;
      if (!/^[1-9]\d*$/.test(req.params.id)) return reply.code(400).send({ error: "Invalid id" });
      const id = Number(req.params.id);
      const status = req.body?.status;
      if (typeof status !== "string" || !STATUSES.includes(status)) {
        return reply.code(400).send({ error: "Invalid status" });
      }
      const next = status as ItemStatus;
      const at = localIso(new Date());
      const db = new Database(dbPath, { fileMustExist: true });
      try {
        db.pragma("busy_timeout = 5000");
        const row = db.transaction((): ItemRow | undefined => {
          const info = db
            .prepare("UPDATE items SET status = ?, closed_reason = ?, updated_at = ? WHERE id = ?")
            .run(next, CLOSED_REASON[next], at, id);
          if (info.changes === 0) return undefined;
          db.prepare("INSERT INTO actions (item_id, action, source, at) VALUES (?, ?, 'web', ?)").run(id, next, at);
          return db.prepare(`SELECT ${itemColumns(db)} FROM items WHERE id = ?`).get(id) as ItemRow;
        })();
        if (!row) return reply.code(404).send({ error: "事项不存在" });
        return toItem(row);
      } finally {
        db.close();
      }
    },
  );
}
