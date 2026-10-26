import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthIdentity } from "../auth/token-auth.js";

export interface AssistantRoutesDeps {
  /** 助手数据库路径；库由外部后台建表和迁移，这里只读写 */
  dbPath: string;
  /** 成品文件只能从这个目录下面读（环境变量 ASSISTANT_OUTPUT_ROOT）；没配或为空时成品文件接口一律 404 */
  outputRoot?: string;
  /**
   * 后台登记的是宿主上的路径，容器里看到的可能是另一个挂载点。
   * 格式 "<宿主前缀>=<容器前缀>"（环境变量 ASSISTANT_PATH_MAP）；没配就原样使用。
   */
  pathMap?: string;
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

type DeliverableStatus = "seen" | "used" | "dismissed";
const DELIVERABLE_STATUSES: readonly string[] = ["seen", "used", "dismissed"];
/** 成品列表只看最近这么久登记的；还没看过（status = 'new'）的不受这个限制 */
const DELIVERABLE_WINDOW_MS = 3 * 24 * 3600 * 1000;
/** 「用了」的成品留这么久；「不用了」的立刻不再返回 */
const DELIVERABLE_USED_WINDOW_MS = 24 * 3600 * 1000;
/** 文本和图片直接在页面里显示，其余一律下载 */
const INLINE_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
/** 下载时带上的类型，好让手机选对打开方式；不认识的是 application/octet-stream */
const DOWNLOAD_TYPES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".wps": "application/vnd.ms-works",
  ".et": "application/vnd.ms-excel",
  ".dps": "application/vnd.ms-powerpoint",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
};

export interface PathMap {
  host: string;
  container: string;
}

/** 解析 "<宿主前缀>=<容器前缀>"；格式不对或任一边为空就当没配 */
export function parsePathMap(raw: string | undefined): PathMap | null {
  if (!raw) return null;
  const i = raw.indexOf("=");
  if (i < 0) return null;
  const host = raw.slice(0, i).trim().replace(/\/+$/, "");
  const container = raw.slice(i + 1).trim().replace(/\/+$/, "");
  if (!host || !container) return null;
  return { host, container };
}

/** 后台在宿主上登记的路径，换成容器里看到的路径；只认整段目录前缀 */
export function toContainerPath(p: string, map: PathMap | null): string {
  if (!map) return p;
  if (p === map.host) return map.container;
  return p.startsWith(map.host + "/") ? map.container + p.slice(map.host.length) : p;
}

interface DeliverableRow {
  id: number;
  item_id: number | null;
  session_key: string | null;
  title: string;
  path: string;
  summary: string;
  status: string;
  created_at: string;
  /** 第 6 版库才有：成品的主题 */
  topic?: string | null;
}

interface ThreadRow {
  session_key: string;
  item_id: number | null;
  title: string;
  status: string;
  progress: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** 第 5 版库才有：派出这个子会话的会话 key */
  parent?: string | null;
}

const DELIVERABLE_COLUMNS = "id, item_id, session_key, title, path, summary, status, created_at";

function toDeliverable(r: DeliverableRow) {
  return {
    id: r.id,
    itemId: r.item_id,
    sessionKey: r.session_key,
    title: r.title,
    path: r.path,
    summary: r.summary,
    status: r.status,
    topic: r.topic ?? null,
    createdAt: r.created_at,
  };
}

/** topic 列是第 6 版库才加的；旧库不选它 */
function deliverableColumns(db: Database.Database): string {
  const cols = db.pragma("table_info(deliverables)") as { name: string }[];
  return cols.some((c) => c.name === "topic") ? `${DELIVERABLE_COLUMNS}, topic` : DELIVERABLE_COLUMNS;
}

function toThread(r: ThreadRow) {
  return {
    sessionKey: r.session_key,
    itemId: r.item_id,
    title: r.title,
    status: r.status,
    progress: r.progress,
    parent: r.parent ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** threads 和 deliverables 是后台第 4 版库才有的；旧库当没有 */
function hasV4Tables(db: Database.Database): boolean {
  return (db.pragma("user_version", { simple: true }) as number) >= 4;
}

/** parent 列是第 5 版库才加的；按列是否存在判断，旧库不选它 */
function threadColumns(db: Database.Database): string {
  const base = "session_key, item_id, title, status, progress, created_by, created_at, updated_at";
  const cols = db.pragma("table_info(threads)") as { name: string }[];
  return cols.some((c) => c.name === "parent") ? `${base}, parent` : base;
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  // 只挡真正往上走的 ".."，根目录里叫 "..notes.md" 的文件照常放行
  return rel.length > 0 && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
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
  const outputRoot = deps.outputRoot ? path.resolve(deps.outputRoot) : null;
  const pathMap = parsePathMap(deps.pathMap);

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
      let deliverables: ReturnType<typeof toDeliverable>[] = [];
      let threads: ReturnType<typeof toThread>[] = [];
      if (hasV4Tables(db)) {
        const since = localIso(new Date(now.getTime() - DELIVERABLE_WINDOW_MS));
        const usedSince = localIso(new Date(now.getTime() - DELIVERABLE_USED_WINDOW_MS));
        deliverables = (
          db
            .prepare(
              `SELECT ${deliverableColumns(db)} FROM deliverables WHERE (status IN ('new', 'seen') AND created_at >= ?) OR (status = 'used' AND updated_at >= ?) ORDER BY created_at DESC, id DESC`,
            )
            .all(since, usedSince) as DeliverableRow[]
        ).map(toDeliverable);
        threads = (
          db
            .prepare(`SELECT ${threadColumns(db)} FROM threads ORDER BY updated_at DESC`)
            .all() as ThreadRow[]
        ).map(toThread);
      }
      return {
        items: open.map(toItem),
        closedRecent: closed.map(toItem),
        deliverables,
        threads,
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

  app.post<{ Params: { id: string }; Body: { status?: unknown } }>(
    "/api/assistant/deliverables/:id/status",
    async (req, reply) => {
      if (rejectUnlessAssistant(req, reply)) return reply;
      if (!/^[1-9]\d*$/.test(req.params.id)) return reply.code(400).send({ error: "Invalid id" });
      const id = Number(req.params.id);
      const status = req.body?.status;
      if (typeof status !== "string" || !DELIVERABLE_STATUSES.includes(status)) {
        return reply.code(400).send({ error: "Invalid status" });
      }
      const next = status as DeliverableStatus;
      const at = localIso(new Date());
      const db = new Database(dbPath, { fileMustExist: true });
      try {
        db.pragma("busy_timeout = 5000");
        if (!hasV4Tables(db)) return reply.code(404).send({ error: "成品不存在" });
        const row = db.transaction((): DeliverableRow | undefined => {
          const info = db.prepare("UPDATE deliverables SET status = ?, updated_at = ? WHERE id = ?").run(next, at, id);
          if (info.changes === 0) return undefined;
          const r = db.prepare(`SELECT ${deliverableColumns(db)} FROM deliverables WHERE id = ?`).get(id) as DeliverableRow;
          // actions.item_id 不能为空；没挂事项的成品只改状态
          if (r.item_id != null) {
            db.prepare("INSERT INTO actions (item_id, action, source, at) VALUES (?, ?, 'web', ?)").run(
              r.item_id,
              `deliverable_${next}`,
              at,
            );
          }
          return r;
        })();
        if (!row) return reply.code(404).send({ error: "成品不存在" });
        return toDeliverable(row);
      } finally {
        db.close();
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/assistant/deliverables/:id/file", async (req, reply) => {
    if (rejectUnlessAssistant(req, reply)) return reply;
    if (!/^[1-9]\d*$/.test(req.params.id)) return reply.code(400).send({ error: "Invalid id" });
    if (!outputRoot) return reply.code(404).send({ error: "没有配置成品目录" });
    const id = Number(req.params.id);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let stored: string | undefined;
    try {
      db.pragma("busy_timeout = 5000");
      if (hasV4Tables(db)) {
        stored = (db.prepare("SELECT path FROM deliverables WHERE id = ?").get(id) as { path: string } | undefined)?.path;
      }
    } finally {
      db.close();
    }
    if (!stored) return reply.code(404).send({ error: "成品不存在" });

    // 先按字面路径判断，再按解开链接后的真实路径判断，两道都得落在产出目录里
    const filePath = path.resolve(toContainerPath(stored, pathMap));
    if (!isInside(outputRoot, filePath)) return reply.code(403).send({ error: "Forbidden" });
    let real: string;
    let realRoot: string;
    try {
      real = await fs.promises.realpath(filePath);
      realRoot = await fs.promises.realpath(outputRoot);
    } catch {
      return reply.code(404).send({ error: "文件不存在" });
    }
    if (!isInside(realRoot, real)) return reply.code(403).send({ error: "Forbidden" });
    const stat = await fs.promises.stat(real);
    if (!stat.isFile()) return reply.code(404).send({ error: "文件不存在" });

    reply.header("Content-Length", stat.size).header("X-Content-Type-Options", "nosniff");
    const ext = path.extname(real).toLowerCase();
    const name = path.basename(filePath);
    // 老浏览器只认 filename，给个 ASCII 兜底；真名放 filename*
    const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const filename = `filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    const inlineType = INLINE_TYPES[ext];
    if (inlineType) {
      if (inlineType.startsWith("image/")) reply.header("Content-Disposition", `inline; ${filename}`);
      return reply.type(inlineType).send(fs.createReadStream(real));
    }
    return reply
      .type(DOWNLOAD_TYPES[ext] ?? "application/octet-stream")
      .header("Content-Disposition", `attachment; ${filename}`)
      .send(fs.createReadStream(real));
  });
}
