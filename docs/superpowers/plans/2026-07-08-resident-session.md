# 常驻 Session + 主动提醒（含 PWA Web Push）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 cc-pet-web 每个登录 token 一个绑定到指定 bridge 的常驻 session（永不清理、UI 置顶），cron（cc-connect 侧）触发的回复回流后以「未读徒标 + 宠物动效」提醒，关页面时以 PWA Web Push 系统通知提醒。

**Architecture:** 常驻 session 由 config 声明（per token）；服务端 `ResidentRegistry` 在启动时把它 bootstrap 进 `sessions` 表并标记 `is_resident=1`，清理任务跳过它。常驻 session 收到 assistant 消息时服务端累加 `unread_count` 并广播 `RESIDENT_UNREAD`；若该消息是「主动消息」（近期无本地用户发送，即 cron 触发），再经 `WebPushService` 推送给该 token 的订阅端。前端置顶常驻 session、以服务端计数驱动其徒标、并提供后台推送订阅开关 + 自定义 Service Worker 处理 push。

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React + Zustand, vite-plugin-pwa (injectManifest), web-push (VAPID), vitest。pnpm monorepo：`@cc-pet/shared` / `@cc-pet/server` / `@cc-pet/web`。

## Global Constraints

- 语言：所有面向用户的文案用中文（与现有 UI 一致）。
- 运行时：Node >= 18（推荐 22）；ESM 模块，import 路径带 `.js` 后缀。
- 测试：vitest。服务端测试用 `new Database(":memory:")` + `initSchema(db)`（见 `packages/server/tests/storage.test.ts`）。
- 提交：每个 Task 末尾 commit，message 用 `feat:` / `test:` 前缀，简洁中文或英文均可。
- **不修改第三方源码**：cc-connect 不在本仓库，cron 配置为运维手册（见 spec §9），本计划不含 cc-connect 代码改动。
- 配置为文件优先：生产读 `cc-pet.config.json`（`ConfigStore.load()`），未知字段会被 `normalize*` 丢弃 —— **新增配置字段必须在 `storage/config.ts` 的 normalize 里显式解析**。
- 常驻 session 默认 key：`resident`。主动消息判定窗口：5 分钟。
- 类型契约：`ResidentSessionConfig = { bridgeId: string; key: string; label?: string }`；`WebPushConfig = { vapidPublicKey: string; vapidPrivateKey: string; subject: string }`。
- 依赖 spec：`docs/superpowers/specs/2026-07-08-resident-session-design.md`（P0 回流验证已通过）。

---

## 文件结构

**新建（server）**
- `packages/server/src/resident/registry.ts` — 解析 config → 常驻集合、`isResident`、`ownerToken`、`bootstrap`
- `packages/server/src/resident/proactive-detector.ts` — `markUserSend` / `isProactive`
- `packages/server/src/resident/incoming.ts` — 常驻消息入站纯逻辑（增未读、判定是否推送），便于测试
- `packages/server/src/storage/push-subscriptions.ts` — 订阅 CRUD
- `packages/server/src/push/web-push-service.ts` — 封装 web-push
- `packages/server/src/api/push.ts` — 推送订阅 REST 路由
- 对应 `*.test.ts`

**新建（web）**
- `packages/web/src/lib/push.ts` — 订阅/退订、VAPID key 转换
- `packages/web/src/sw.ts` — 自定义 Service Worker（precache + push + notificationclick）

**修改**
- `packages/shared/src/types/config.ts` — `TokenConfig.residentSession`、`AppConfig.webPush`、新类型
- `packages/shared/src/types/session.ts` — `Session.isResident`、`Session.unreadCount`
- `packages/shared/src/constants/events.ts` — `RESIDENT_UNREAD`
- `packages/server/src/storage/db.ts` — `ensureColumn` 迁移 + `sessions` 加 `is_resident`/`unread_count`
- `packages/server/src/storage/sessions.ts` — resident/unread 方法 + listByConnection 返回新字段
- `packages/server/src/cleanup/sessions-cleanup.ts` — 清理排除常驻
- `packages/server/src/api/sessions.ts` — 已读清零端点
- `packages/server/src/index.ts` — 装配 registry / detector / webPush / 未读广播 / 推送
- `packages/server/package.json` — 加 `web-push` 依赖
- `packages/web/src/lib/store/session.ts` — `residentChatKeys`、`incrementUnread` 对常驻 no-op、`setUnread`
- `packages/web/src/App.tsx` — 处理 `RESIDENT_UNREAD`、hydrate 后播种未读
- `packages/web/src/components/SessionDropdown.tsx` — 置顶 + 📌 标记
- `packages/web/src/components/SettingsPanel.tsx` — 后台推送开关
- `packages/web/vite.config.ts` — PWA 切 `injectManifest`

---

# 阶段 P1：常驻 Session（config / 存储 / 置顶 / 豁免清理 / 未读 + 动效）

## Task 1: Shared 类型与事件常量

**Files:**
- Modify: `packages/shared/src/types/config.ts`
- Modify: `packages/shared/src/types/session.ts`
- Modify: `packages/shared/src/constants/events.ts`
- Test: `packages/shared/src/constants/events.test.ts` (create)

**Interfaces:**
- Produces: `ResidentSessionConfig`, `WebPushConfig`, `TokenConfig.residentSession?`, `AppConfig.webPush?`, `Session.isResident?`, `Session.unreadCount?`, `WS_EVENTS.RESIDENT_UNREAD = "resident:unread"`

- [ ] **Step 1: 写失败测试**

Create `packages/shared/src/constants/events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { WS_EVENTS } from "./events.js";

describe("WS_EVENTS", () => {
  it("includes the resident unread event", () => {
    expect(WS_EVENTS.RESIDENT_UNREAD).toBe("resident:unread");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/shared exec vitest run src/constants/events.test.ts`
Expected: FAIL —`RESIDENT_UNREAD` is undefined。

- [ ] **Step 3: 实现类型与常量**

在 `packages/shared/src/constants/events.ts` 的 `WS_EVENTS` 对象里，`BRIDGE_AUDIO` 一行后加：

```ts
  BRIDGE_AUDIO: "bridge:audio",
  /** Server → dashboard: resident session unread count changed (server-driven). */
  RESIDENT_UNREAD: "resident:unread",
```

在 `packages/shared/src/types/config.ts`：`TokenConfig` 增加字段，并新增两个类型与 `AppConfig.webPush`：

```ts
export interface ResidentSessionConfig {
  bridgeId: string;
  key: string;
  label?: string;
}

export interface WebPushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  subject: string;
}
```

`AppConfig` 增加可选字段：

```ts
export interface AppConfig {
  bridges: BridgeConfig[];
  tokens: TokenConfig[];
  pet: PetConfig;
  server: ServerConfig;
  webPush?: WebPushConfig;
}
```

`TokenConfig` 增加：

```ts
export interface TokenConfig {
  token: string;
  name: string;
  bridgeIds: string[];
  petImages?: TokenPetImages;
  residentSession?: ResidentSessionConfig;
}
```

在 `packages/shared/src/types/session.ts` 的 `Session` 接口增加两字段：

```ts
export interface Session {
  key: string;
  connectionId: string;
  label?: string;
  createdAt: number;
  lastActiveAt: number;
  /** True when this session is a config-declared resident session. */
  isResident?: boolean;
  /** Server-persisted unread count (resident sessions only). */
  unreadCount?: number;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/shared exec vitest run src/constants/events.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src
git commit -m "feat(shared): add resident-session + webpush types and RESIDENT_UNREAD event"
```

---

## Task 2: Config 解析 residentSession 与 webPush

**Files:**
- Modify: `packages/server/src/storage/config.ts`
- Test: `packages/server/tests/config-resident.test.ts` (create)

**Interfaces:**
- Consumes: `ResidentSessionConfig`, `WebPushConfig`, `TokenConfig`, `AppConfig` (Task 1)
- Produces: `ConfigStore.load()` 现在会保留合法的 `token.residentSession` 与根级 `webPush`

- [ ] **Step 1: 写失败测试**

Create `packages/server/tests/config-resident.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { ConfigStore } from "../src/storage/config.js";

describe("ConfigStore resident + webPush parsing", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cc-pet-cfg-"));
    db = new Database(":memory:");
    initSchema(db);
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("parses residentSession on a token and root webPush", async () => {
    const file = path.join(dir, "cc-pet.config.json");
    await writeFile(
      file,
      JSON.stringify({
        bridges: [{ id: "cc", host: "h", port: 1, token: "t" }],
        tokens: [
          {
            token: "tok",
            name: "Z",
            bridgeIds: ["cc"],
            residentSession: { bridgeId: "cc", key: "resident", label: "第二大脑" },
          },
        ],
        webPush: { vapidPublicKey: "pub", vapidPrivateKey: "priv", subject: "mailto:a@b.c" },
      }),
      "utf8",
    );
    const store = new ConfigStore(db, { configFilePath: file });
    const cfg = store.load();
    expect(cfg.tokens[0].residentSession).toEqual({
      bridgeId: "cc",
      key: "resident",
      label: "第二大脑",
    });
    expect(cfg.webPush).toEqual({
      vapidPublicKey: "pub",
      vapidPrivateKey: "priv",
      subject: "mailto:a@b.c",
    });
  });

  it("drops malformed residentSession and webPush", async () => {
    const file = path.join(dir, "cc-pet.config.json");
    await writeFile(
      file,
      JSON.stringify({
        tokens: [{ token: "tok", name: "Z", bridgeIds: ["cc"], residentSession: { key: 5 } }],
        webPush: { vapidPublicKey: "" },
      }),
      "utf8",
    );
    const store = new ConfigStore(db, { configFilePath: file });
    const cfg = store.load();
    expect(cfg.tokens[0].residentSession).toBeUndefined();
    expect(cfg.webPush).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/config-resident.test.ts`
Expected: FAIL — `residentSession`/`webPush` 为 undefined（当前被 normalize 丢弃）。

- [ ] **Step 3: 实现解析**

在 `packages/server/src/storage/config.ts` 顶部 import 增加类型：

```ts
import type { AppConfig, BridgeConfig, TokenConfig, TokenPetImages, ResidentSessionConfig, WebPushConfig } from "@cc-pet/shared";
```

新增两个 normalize 辅助函数（放在 `normalizeToken` 之前）：

```ts
function normalizeResidentSession(v: unknown): ResidentSessionConfig | undefined {
  if (!v || typeof v !== "object") return undefined;
  const x = v as Record<string, unknown>;
  if (typeof x.bridgeId !== "string" || x.bridgeId.trim().length === 0) return undefined;
  if (typeof x.key !== "string" || x.key.trim().length === 0) return undefined;
  const label = typeof x.label === "string" && x.label.trim().length > 0 ? x.label.trim() : undefined;
  return { bridgeId: x.bridgeId.trim(), key: x.key.trim(), label };
}

function normalizeWebPush(v: unknown): WebPushConfig | undefined {
  if (!v || typeof v !== "object") return undefined;
  const x = v as Record<string, unknown>;
  const pub = typeof x.vapidPublicKey === "string" ? x.vapidPublicKey.trim() : "";
  const priv = typeof x.vapidPrivateKey === "string" ? x.vapidPrivateKey.trim() : "";
  const subject = typeof x.subject === "string" ? x.subject.trim() : "";
  if (!pub || !priv || !subject) return undefined;
  return { vapidPublicKey: pub, vapidPrivateKey: priv, subject };
}
```

在 `normalizeToken` 的 `return { ... }` 里加入 `residentSession`：

```ts
  return {
    token: x.token,
    name: typeof x.name === "string" && x.name.trim().length > 0 ? x.name : "token",
    bridgeIds,
    petImages,
    residentSession: normalizeResidentSession(x.residentSession),
  };
```

在 `normalizeAppConfig` 的最终 `return` 前解析 webPush，并把它加入返回值：

```ts
  const webPush = normalizeWebPush(o.webPush);
  return { bridges, tokens, pet, server, webPush };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/config-resident.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/storage/config.ts packages/server/tests/config-resident.test.ts
git commit -m "feat(server): parse token.residentSession and root webPush config"
```

---

## Task 3: DB 迁移 — sessions 加 is_resident / unread_count 列

**Files:**
- Modify: `packages/server/src/storage/db.ts`
- Test: `packages/server/tests/db-migrate.test.ts` (create)

**Interfaces:**
- Produces: `sessions` 表含 `is_resident INTEGER DEFAULT 0`、`unread_count INTEGER DEFAULT 0`；对旧库幂等补列。

- [ ] **Step 1: 写失败测试**

Create `packages/server/tests/db-migrate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";

describe("sessions schema migration", () => {
  it("has is_resident and unread_count columns on a fresh db", () => {
    const db = new Database(":memory:");
    initSchema(db);
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("is_resident");
    expect(cols).toContain("unread_count");
    db.close();
  });

  it("adds columns to a pre-existing sessions table without them", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (
      connection_id TEXT NOT NULL, key TEXT NOT NULL, label TEXT,
      created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
      PRIMARY KEY (connection_id, key));`);
    initSchema(db);
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("is_resident");
    expect(cols).toContain("unread_count");
    db.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/db-migrate.test.ts`
Expected: FAIL — 列不存在。

- [ ] **Step 3: 实现迁移**

在 `packages/server/src/storage/db.ts` 新增幂等补列辅助函数（放在 `initSchema` 之后）：

```ts
/** Add a column if the table lacks it. ALTER TABLE ADD COLUMN is idempotent-safe only via this guard. */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
```

在 `initSchema` 里，`db.exec(\`...\`)` 建表块之后、`initFts(db)` 之前插入：

```ts
  ensureColumn(db, "sessions", "is_resident", "is_resident INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "sessions", "unread_count", "unread_count INTEGER NOT NULL DEFAULT 0");

  initFts(db);
```

（注意：把原来的 `initFts(db);` 调用替换为上面这段，避免重复调用。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/db-migrate.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/storage/db.ts packages/server/tests/db-migrate.test.ts
git commit -m "feat(server): add is_resident/unread_count columns with idempotent migration"
```

---

## Task 4: SessionStore — resident 标记与 unread 计数

**Files:**
- Modify: `packages/server/src/storage/sessions.ts`
- Test: `packages/server/tests/sessions-resident.test.ts` (create)

**Interfaces:**
- Consumes: `Session` (Task 1), 迁移列 (Task 3)
- Produces:
  - `SessionStore.markResident(connectionId: string, key: string, label?: string): void`
  - `SessionStore.incrementUnread(connectionId: string, key: string): number`
  - `SessionStore.clearUnread(connectionId: string, key: string): void`
  - `SessionStore.getUnread(connectionId: string, key: string): number`
  - `listByConnection` 返回的 `Session` 携带 `isResident` 与 `unreadCount`

- [ ] **Step 1: 写失败测试**

Create `packages/server/tests/sessions-resident.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { SessionStore } from "../src/storage/sessions.js";

describe("SessionStore resident + unread", () => {
  let db: Database.Database;
  let store: SessionStore;
  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new SessionStore(db);
  });
  afterEach(() => db.close());

  it("marks a session resident and lists it with isResident", () => {
    store.markResident("cc", "resident", "第二大脑");
    const list = store.listByConnection("cc");
    expect(list).toHaveLength(1);
    expect(list[0].isResident).toBe(true);
    expect(list[0].label).toBe("第二大脑");
    expect(list[0].unreadCount).toBe(0);
  });

  it("markResident is idempotent and preserves unread + created_at", () => {
    store.markResident("cc", "resident", "L1");
    store.incrementUnread("cc", "resident");
    const before = store.listByConnection("cc")[0];
    store.markResident("cc", "resident", "L2");
    const after = store.listByConnection("cc")[0];
    expect(after.unreadCount).toBe(1);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.label).toBe("L2");
  });

  it("increments and clears unread", () => {
    store.markResident("cc", "resident");
    expect(store.incrementUnread("cc", "resident")).toBe(1);
    expect(store.incrementUnread("cc", "resident")).toBe(2);
    expect(store.getUnread("cc", "resident")).toBe(2);
    store.clearUnread("cc", "resident");
    expect(store.getUnread("cc", "resident")).toBe(0);
  });

  it("non-resident sessions report isResident false", () => {
    const now = Date.now();
    store.create({ key: "s1", connectionId: "cc", createdAt: now, lastActiveAt: now });
    expect(store.listByConnection("cc")[0].isResident).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/sessions-resident.test.ts`
Expected: FAIL — 方法不存在 / 字段缺失。

- [ ] **Step 3: 实现**

在 `packages/server/src/storage/sessions.ts` 的 `listByConnection` 中，`rows.map` 增加两字段：

```ts
    return rows.map((r) => ({
      key: r.key,
      connectionId: r.connection_id,
      label: deriveSessionLabel(r.label, r.first_user_content),
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      isResident: (r.is_resident ?? 0) === 1,
      unreadCount: r.unread_count ?? 0,
    }));
```

在 `SessionStore` 类内新增方法：

```ts
  markResident(connectionId: string, key: string, label?: string): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO sessions (connection_id, key, label, created_at, last_active_at, is_resident, unread_count)
       VALUES (?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(connection_id, key) DO UPDATE SET
         is_resident = 1,
         label = COALESCE(excluded.label, sessions.label)`
    ).run(connectionId, key, label ?? null, now, now);
  }

  incrementUnread(connectionId: string, key: string): number {
    this.db.prepare(
      `UPDATE sessions SET unread_count = unread_count + 1 WHERE connection_id = ? AND key = ?`
    ).run(connectionId, key);
    return this.getUnread(connectionId, key);
  }

  clearUnread(connectionId: string, key: string): void {
    this.db.prepare(
      `UPDATE sessions SET unread_count = 0 WHERE connection_id = ? AND key = ?`
    ).run(connectionId, key);
  }

  getUnread(connectionId: string, key: string): number {
    const row = this.db.prepare(
      `SELECT unread_count FROM sessions WHERE connection_id = ? AND key = ?`
    ).get(connectionId, key) as { unread_count?: number } | undefined;
    return row?.unread_count ?? 0;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/sessions-resident.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/storage/sessions.ts packages/server/tests/sessions-resident.test.ts
git commit -m "feat(server): SessionStore resident marking and unread counter"
```

---

## Task 5: ResidentRegistry

**Files:**
- Create: `packages/server/src/resident/registry.ts`
- Test: `packages/server/tests/resident-registry.test.ts` (create)

**Interfaces:**
- Consumes: `AppConfig` (Task 1), `SessionStore.markResident` (Task 4)
- Produces:
  - `type ResidentPair = { connectionId: string; key: string; label?: string; tokenName: string }`
  - `class ResidentRegistry`
    - `constructor(config: AppConfig, logger?: { warn(o: unknown, m: string): void })`
    - `pairs(): ResidentPair[]`
    - `isResident(connectionId: string, key: string): boolean`
    - `ownerToken(connectionId: string, key: string): string | undefined`
    - `bootstrap(store: { markResident(c: string, k: string, l?: string): void }): void`

- [ ] **Step 1: 写失败测试**

Create `packages/server/tests/resident-registry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ResidentRegistry } from "../src/resident/registry.js";
import type { AppConfig } from "@cc-pet/shared";

function cfg(partial: Partial<AppConfig>): AppConfig {
  return { bridges: [], tokens: [], pet: { opacity: 1, size: 1 }, server: { port: 0, dataDir: "." }, ...partial };
}

describe("ResidentRegistry", () => {
  it("collects valid resident pairs and answers isResident/ownerToken", () => {
    const reg = new ResidentRegistry(
      cfg({
        tokens: [
          { token: "t1", name: "Ziiimo", bridgeIds: ["cc", "oc"], residentSession: { bridgeId: "cc", key: "resident", label: "脑" } },
          { token: "t2", name: "Yu", bridgeIds: ["yu"], residentSession: { bridgeId: "yu", key: "resident" } },
        ],
      }),
    );
    expect(reg.pairs()).toHaveLength(2);
    expect(reg.isResident("cc", "resident")).toBe(true);
    expect(reg.isResident("cc", "other")).toBe(false);
    expect(reg.ownerToken("yu", "resident")).toBe("Yu");
  });

  it("skips residentSession whose bridgeId is not in the token bridgeIds", () => {
    const warn = vi.fn();
    const reg = new ResidentRegistry(
      cfg({ tokens: [{ token: "t", name: "Z", bridgeIds: ["cc"], residentSession: { bridgeId: "zzz", key: "resident" } }] }),
      { warn },
    );
    expect(reg.pairs()).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("bootstrap marks each pair resident on the store", () => {
    const reg = new ResidentRegistry(
      cfg({ tokens: [{ token: "t", name: "Z", bridgeIds: ["cc"], residentSession: { bridgeId: "cc", key: "resident", label: "脑" } }] }),
    );
    const markResident = vi.fn();
    reg.bootstrap({ markResident });
    expect(markResident).toHaveBeenCalledWith("cc", "resident", "脑");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/resident-registry.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

Create `packages/server/src/resident/registry.ts`:

```ts
import type { AppConfig } from "@cc-pet/shared";

export interface ResidentPair {
  connectionId: string;
  key: string;
  label?: string;
  tokenName: string;
}

interface RegistryLogger {
  warn(obj: unknown, msg: string): void;
}

interface ResidentMarker {
  markResident(connectionId: string, key: string, label?: string): void;
}

export class ResidentRegistry {
  private readonly _pairs: ResidentPair[] = [];
  private readonly byChatKey = new Map<string, ResidentPair>();

  constructor(config: AppConfig, logger?: RegistryLogger) {
    for (const token of config.tokens) {
      const rs = token.residentSession;
      if (!rs) continue;
      if (!token.bridgeIds.includes(rs.bridgeId)) {
        logger?.warn(
          { tokenName: token.name, bridgeId: rs.bridgeId, bridgeIds: token.bridgeIds },
          "Ignoring residentSession: bridgeId not in token bridgeIds",
        );
        continue;
      }
      const pair: ResidentPair = {
        connectionId: rs.bridgeId,
        key: rs.key,
        label: rs.label,
        tokenName: token.name,
      };
      this._pairs.push(pair);
      this.byChatKey.set(`${pair.connectionId}::${pair.key}`, pair);
    }
  }

  pairs(): ResidentPair[] {
    return [...this._pairs];
  }

  isResident(connectionId: string, key: string): boolean {
    return this.byChatKey.has(`${connectionId}::${key}`);
  }

  ownerToken(connectionId: string, key: string): string | undefined {
    return this.byChatKey.get(`${connectionId}::${key}`)?.tokenName;
  }

  bootstrap(store: ResidentMarker): void {
    for (const p of this._pairs) {
      store.markResident(p.connectionId, p.key, p.label);
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/resident-registry.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/resident/registry.ts packages/server/tests/resident-registry.test.ts
git commit -m "feat(server): ResidentRegistry (parse/validate/bootstrap resident sessions)"
```

---

## Task 6: SessionsCleanup 排除常驻

**Files:**
- Modify: `packages/server/src/cleanup/sessions-cleanup.ts`
- Test: `packages/server/tests/sessions-cleanup-resident.test.ts` (create)

**Interfaces:**
- Consumes: 迁移列 `is_resident` (Task 3)
- Produces: `cleanupInactiveSessions` 不删除 `is_resident = 1` 的 session

- [ ] **Step 1: 写失败测试**

Create `packages/server/tests/sessions-cleanup-resident.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { SessionStore } from "../src/storage/sessions.js";
import { SessionsCleanup } from "../src/cleanup/sessions-cleanup.js";

describe("SessionsCleanup excludes resident", () => {
  let db: Database.Database;
  let store: SessionStore;
  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new SessionStore(db);
  });
  afterEach(() => db.close());

  it("keeps resident sessions even when long inactive; deletes stale normal ones", () => {
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    store.markResident("cc", "resident");
    db.prepare("UPDATE sessions SET last_active_at = ? WHERE connection_id='cc' AND key='resident'").run(old);
    store.create({ key: "stale", connectionId: "cc", createdAt: old, lastActiveAt: old });

    const cleanup = new SessionsCleanup(store, db);
    const deleted = cleanup.cleanupInactiveSessions(10);

    expect(deleted).toBe(1);
    const keys = store.listByConnection("cc").map((s) => s.key);
    expect(keys).toContain("resident");
    expect(keys).not.toContain("stale");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/sessions-cleanup-resident.test.ts`
Expected: FAIL — 常驻 session 被删（deleted=2 或 keys 不含 resident）。

- [ ] **Step 3: 实现**

在 `packages/server/src/cleanup/sessions-cleanup.ts` 的 `cleanupInactiveSessions` 里，修改查询加入 `is_resident` 过滤：

```ts
    const sessionsToDelete = this.db.prepare(`
      SELECT connection_id, key
      FROM sessions
      WHERE last_active_at < ?
        AND (is_resident IS NULL OR is_resident = 0)
    `).all(thresholdTime) as { connection_id: string; key: string }[];
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/sessions-cleanup-resident.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/cleanup/sessions-cleanup.ts packages/server/tests/sessions-cleanup-resident.test.ts
git commit -m "feat(server): exclude resident sessions from inactivity cleanup"
```

---

## Task 7: 常驻消息入站逻辑 + 已读清零 API

**Files:**
- Create: `packages/server/src/resident/incoming.ts`
- Modify: `packages/server/src/api/sessions.ts`
- Test: `packages/server/tests/resident-incoming.test.ts` (create)
- Test: `packages/server/tests/sessions-read-api.test.ts` (create)

**Interfaces:**
- Consumes: `ResidentRegistry` (Task 5), `SessionStore` (Task 4)
- Produces:
  - `interface ResidentInboundDeps { registry: ResidentRegistry; sessionStore: SessionStore }`
  - `interface ResidentInboundResult { unreadCount: number; ownerToken?: string }`
  - `onResidentAssistantMessage(deps: ResidentInboundDeps, connectionId: string, sessionKey: string): ResidentInboundResult | null` — 非常驻返回 `null`；常驻则 `incrementUnread` 并返回新计数 + ownerToken
  - `DELETE`-less 新端点 `POST /api/sessions/:connectionId/:key/read` → `store.clearUnread` → `{ ok: true }`

- [ ] **Step 1: 写失败测试（入站逻辑）**

Create `packages/server/tests/resident-incoming.test.ts`:

```ts
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
    const r = onResidentAssistantMessage(deps, "cc", "resident");
    expect(r).toEqual({ unreadCount: 1, ownerToken: "Z" });
    expect(onResidentAssistantMessage(deps, "cc", "resident")?.unreadCount).toBe(2);
  });

  it("returns null for non-resident session", () => {
    const deps = makeDeps(db);
    expect(onResidentAssistantMessage(deps, "cc", "other")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/resident-incoming.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现入站逻辑**

Create `packages/server/src/resident/incoming.ts`:

```ts
import type { SessionStore } from "../storage/sessions.js";
import type { ResidentRegistry } from "./registry.js";

export interface ResidentInboundDeps {
  registry: ResidentRegistry;
  sessionStore: SessionStore;
}

export interface ResidentInboundResult {
  unreadCount: number;
  ownerToken?: string;
}

/**
 * Called for every assistant-side bridge message. If the (connectionId,
 * sessionKey) is a resident session, bumps its persisted unread counter and
 * returns the new count + owning token. Returns null for non-resident sessions.
 */
export function onResidentAssistantMessage(
  deps: ResidentInboundDeps,
  connectionId: string,
  sessionKey: string,
): ResidentInboundResult | null {
  if (!deps.registry.isResident(connectionId, sessionKey)) return null;
  const unreadCount = deps.sessionStore.incrementUnread(connectionId, sessionKey);
  return { unreadCount, ownerToken: deps.registry.ownerToken(connectionId, sessionKey) };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/resident-incoming.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试（已读 API）**

Create `packages/server/tests/sessions-read-api.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { SessionStore } from "../src/storage/sessions.js";
import { MessageStore } from "../src/storage/messages.js";
import { registerSessionRoutes } from "../src/api/sessions.js";

describe("POST /api/sessions/:connectionId/:key/read", () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let store: SessionStore;
  beforeEach(async () => {
    db = new Database(":memory:");
    initSchema(db);
    store = new SessionStore(db);
    app = Fastify();
    registerSessionRoutes(app, store, new MessageStore(db));
    await app.ready();
  });
  afterEach(async () => { await app.close(); db.close(); });

  it("clears unread count", async () => {
    store.markResident("cc", "resident");
    store.incrementUnread("cc", "resident");
    const res = await app.inject({ method: "POST", url: "/api/sessions/cc/resident/read" });
    expect(res.statusCode).toBe(200);
    expect(store.getUnread("cc", "resident")).toBe(0);
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/sessions-read-api.test.ts`
Expected: FAIL — 404（路由不存在）。

- [ ] **Step 7: 实现已读端点**

在 `packages/server/src/api/sessions.ts` 的 `registerSessionRoutes` 内、`DELETE` 路由之后加：

```ts
  app.post<{ Params: { connectionId: string; key: string } }>(
    "/api/sessions/:connectionId/:key/read",
    async (req) => {
      const { connectionId, key } = req.params;
      store.clearUnread(connectionId, key);
      return { ok: true };
    },
  );
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/sessions-read-api.test.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add packages/server/src/resident/incoming.ts packages/server/src/api/sessions.ts packages/server/tests/resident-incoming.test.ts packages/server/tests/sessions-read-api.test.ts
git commit -m "feat(server): resident inbound unread logic + session read endpoint"
```

---

## Task 8: 装配 P1 到 index.ts（bootstrap + 未读广播 + markUserSend）

**Files:**
- Modify: `packages/server/src/index.ts`
- Test: 手工（服务端集成，无 index 单测）

**Interfaces:**
- Consumes: `ResidentRegistry`, `ProactiveDetector`(下一步 P2 才用 — 本任务只装配 registry/detector 的 markUserSend 部分), `onResidentAssistantMessage`, `WS_EVENTS.RESIDENT_UNREAD`
- Produces: 运行时常驻 session bootstrap；常驻 assistant 消息累加未读并广播；dashboard 向常驻 session 发消息时记录 `markUserSend`

> 注：本任务先接入 P1 所需部分（registry + incoming + 未读广播 + detector.markUserSend）。detector 的 `isProactive` → push 在 Task 14 接。为避免重复改动，`ProactiveDetector` 在 Task 13 创建；本任务先用一个内联的最小 detector 占位会造成返工，故**本任务依赖顺序上排在 Task 13 之后执行**（见末尾执行顺序说明）。

- [ ] **Step 1: import 与实例化**

在 `packages/server/src/index.ts` 顶部 import 区加：

```ts
import { ResidentRegistry } from "./resident/registry.js";
import { onResidentAssistantMessage } from "./resident/incoming.js";
import { ProactiveDetector } from "./resident/proactive-detector.js";
```

在 `const initialConfig = configStore.load();` 之后、bridge 自动连接之前，加：

```ts
const residentRegistry = new ResidentRegistry(initialConfig, app.log);
residentRegistry.bootstrap(sessionStore);
const proactiveDetector = new ProactiveDetector();
```

（`app.log` 在 `const app = Fastify({...})` 之后才可用；把这两行放到 `bridgeManager.setLogger(app.log);` 之后即可。`residentRegistry` 的 `ResidentRegistry` 构造在 `app` 定义之后调用，`app.log` 有效。）

- [ ] **Step 2: 常驻 assistant 消息累加未读 + 广播**

在 `bridgeManager.on("message", ...)` 里，抽出一个本地 helper（放在 `switch (msg.type)` 之前）：

```ts
  const bumpResidentUnread = (): void => {
    if (!sessionKey) return;
    const r = onResidentAssistantMessage({ registry: residentRegistry, sessionStore }, connId, sessionKey);
    if (!r) return;
    hub.broadcast(WS_EVENTS.RESIDENT_UNREAD, {
      connectionId: connId,
      sessionKey,
      unreadCount: r.unreadCount,
    });
    // Push (proactive-only) is wired in Task 14.
  };
```

在会写入聊天记录的分支里调用它。具体在以下四处的 `messageStore.save({...})` 之后各加一行 `bumpResidentUnread();`：
1. `case "reply":` 的非 probe 分支（`replyCollector.onReply(...)` 之前）
2. `case "reply_stream":` 的 `bridgeReplyStreamDone(raw)` 且 `fullText` 分支（`hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DONE, ...)` 之前）
3. `case "file":` 的 `messageStore.save` 之后
4. `case "card":` 的非 probe 分支 `messageStore.save` 之后

- [ ] **Step 3: dashboard 发送到常驻 session 时 markUserSend**

在 `hub.onMessage` 的 `case WS_EVENTS.SEND_MESSAGE:` 里，`bridgeManager.send(...)` 之后加：

```ts
      if (residentRegistry.isResident(connectionId, sessionKey)) {
        proactiveDetector.markUserSend(connectionId, sessionKey);
      }
```

在 `registerSiriRoutes` 的发送路径同样标记：打开 `packages/server/src/api/siri.ts`，在 `bridgeManager.send(...)` 之后无法直接访问 detector —— 故把 `proactiveDetector` 作为可选依赖传入 siri。**为最小改动**：在 `index.ts` 里注册 siri 时传入一个回调。修改 `registerSiriRoutes` 的 `SiriDeps` 增加可选 `onUserSend?: (connectionId: string, sessionKey: string) => void`，并在 siri `send` 的 `bridgeManager.send` 后调用 `deps.onUserSend?.(connectionId, sessionKey)`。在 index.ts 注册处传：

```ts
registerSiriRoutes(app, {
  bridgeManager,
  messageStore,
  replyCollector,
  getAuthIdentity: getRequestAuthIdentity,
  getDefaultConnectionId: (bridgeIds) => [...bridgeIds][0],
  onUserSend: (connectionId, sessionKey) => {
    if (residentRegistry.isResident(connectionId, sessionKey)) {
      proactiveDetector.markUserSend(connectionId, sessionKey);
    }
  },
});
```

- [ ] **Step 4: 构建验证**

Run: `pnpm --filter @cc-pet/server exec tsc --noEmit`
Expected: 无类型错误。

- [ ] **Step 5: 手工运行验证**

Run: `pnpm --filter @cc-pet/server build && node packages/server/dist/index.js`（需本地 `cc-pet.config.json`，含一个 residentSession）
Expected: 日志出现 registry bootstrap（无 "Ignoring residentSession" 除非配置非法）；服务正常监听。Ctrl-C 结束。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/index.ts packages/server/src/api/siri.ts
git commit -m "feat(server): bootstrap resident sessions, broadcast unread, track user sends"
```

---

## Task 9: 前端常驻 session 置顶 + 服务端未读驱动 + 动效

**Files:**
- Modify: `packages/web/src/lib/store/session.ts`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/components/SessionDropdown.tsx`
- Test: `packages/web/src/lib/store/session-resident.test.ts` (create)

**Interfaces:**
- Consumes: `Session.isResident`/`unreadCount` (Task 1), `WS_EVENTS.RESIDENT_UNREAD`, `POST /api/sessions/:c/:k/read` (Task 7)
- Produces:
  - session store: `setUnread(chatKey: string, count: number)`；`incrementUnread` 对常驻 chatKey no-op；`setSessions` 维护 `residentChatKeys: Set<string>`
  - App.tsx 处理 `RESIDENT_UNREAD`（`setUnread` + 宠物 talking）
  - hydrate 后按 `unreadCount` 播种常驻未读
  - SessionDropdown 常驻置顶 + 📌

- [ ] **Step 1: 写失败测试（store）**

Create `packages/web/src/lib/store/session-resident.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeChatKey } from "@cc-pet/shared";
import { useSessionStore } from "./session.js";

describe("session store resident unread", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: {}, unread: {} } as never);
  });

  it("incrementUnread is a no-op for resident chat keys, setUnread is absolute", () => {
    const now = Date.now();
    useSessionStore.getState().setSessions("cc", [
      { key: "resident", connectionId: "cc", createdAt: now, lastActiveAt: now, isResident: true, unreadCount: 0 },
    ]);
    const ck = makeChatKey("cc", "resident");
    useSessionStore.getState().incrementUnread(ck);
    expect(useSessionStore.getState().unread[ck] ?? 0).toBe(0); // server drives
    useSessionStore.getState().setUnread(ck, 3);
    expect(useSessionStore.getState().unread[ck]).toBe(3);
  });

  it("incrementUnread still works for non-resident sessions", () => {
    const now = Date.now();
    useSessionStore.getState().setSessions("cc", [
      { key: "s1", connectionId: "cc", createdAt: now, lastActiveAt: now },
    ]);
    const ck = makeChatKey("cc", "s1");
    useSessionStore.getState().incrementUnread(ck);
    expect(useSessionStore.getState().unread[ck]).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/web exec vitest run src/lib/store/session-resident.test.ts`
Expected: FAIL — `setUnread` 不存在 / 常驻仍被 increment。

- [ ] **Step 3: 实现 store 改动**

在 `packages/web/src/lib/store/session.ts`：

在 `interface SessionState` 里加：

```ts
  /** chatKeys whose unread is server-driven (resident sessions); client increments are ignored. */
  residentChatKeys: Set<string>;
  setUnread: (chatKey: string, count: number) => void;
```

在 `create<SessionState>((set, get) => ({ ... }))` 初始值区加 `residentChatKeys: new Set(),`。

修改 `setSessions`，在写入后重算 residentChatKeys（跨所有连接）：

```ts
  setSessions: (connectionId, sessions) =>
    set((s) => {
      const nextSessions = { ...s.sessions, [connectionId]: sessions };
      const residentChatKeys = new Set<string>();
      for (const [cid, list] of Object.entries(nextSessions)) {
        for (const sess of list) {
          if (sess.isResident) residentChatKeys.add(makeChatKey(cid, sess.key));
        }
      }
      return { sessions: nextSessions, residentChatKeys };
    }),
```

修改 `incrementUnread` 开头，对常驻 no-op：

```ts
  incrementUnread: (chatKey) => {
    if (get().residentChatKeys.has(chatKey)) return; // server-driven via RESIDENT_UNREAD
    set((s) => ({ unread: { ...s.unread, [chatKey]: (s.unread[chatKey] ?? 0) + 1 } }));
    const processing = get().hasProcessingSessions();
    useUIStore.getState().setPetState(processing ? "thinking" : "talking");
  },
```

新增 `setUnread`（放在 `clearUnread` 附近）：

```ts
  setUnread: (chatKey, count) =>
    set((s) => ({ unread: { ...s.unread, [chatKey]: Math.max(0, count) } })),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/web exec vitest run src/lib/store/session-resident.test.ts`
Expected: PASS

- [ ] **Step 5: App.tsx 处理 RESIDENT_UNREAD + hydrate 播种**

在 `packages/web/src/App.tsx` 的 `switch (type)` 里新增一个 case（放在 `BRIDGE_ERROR` 之前）：

```ts
          case WS_EVENTS.RESIDENT_UNREAD: {
            const cid = (payload as { connectionId?: string }).connectionId;
            const sKey = (payload as { sessionKey?: string }).sessionKey;
            const count = (payload as { unreadCount?: number }).unreadCount ?? 0;
            if (!cid || !sKey) break;
            const ck = makeChatKey(cid, sKey);
            const active = useSessionStore.getState().activeSessionKey[cid] ?? "default";
            // If the user is currently viewing it, keep it read (and tell the server).
            if (active === sKey && (typeof document === "undefined" || !document.hidden)) {
              void getPlatform()
                .fetchApi(`/api/sessions/${encodeURIComponent(cid)}/${encodeURIComponent(sKey)}/read`, { method: "POST" })
                .catch(() => {});
              useSessionStore.getState().setUnread(ck, 0);
            } else {
              useSessionStore.getState().setUnread(ck, count);
              setPetStateSafely("talking");
            }
            break;
          }
```

在文件顶部**修改**现有 platform import 行（`import { setPlatform, type PlatformAPI } from "./lib/platform.js";`）为：

```ts
import { setPlatform, getPlatform, type PlatformAPI } from "./lib/platform.js";
```

**避免前台通知与 Web Push 重复**：常驻 session 的主动消息由服务端走 Web Push 推送，前台 `notification.ts` 不应再对常驻 session 弹通知。在 `trySendNotification` 函数体开头加守卫：

```ts
        const trySendNotification = (cid: string, sKey: string): void => {
          if (!cid || !sKey) return;
          if (useSessionStore.getState().residentChatKeys.has(makeChatKey(cid, sKey))) return; // resident → Web Push handles it
          if (shouldShowNotification(cid, sKey, isPageHidden)) {
            const ck = makeChatKey(cid, sKey);
            const content = getLastMessageContent(ck);
            sendTaskCompletionNotification(content, cid, sKey);
          }
        };
```

在 `packages/web/src/lib/hydrateFromServer.ts` 的 `hydrateSessionsAndHistory` 里，`useSessionStore.getState().setSessions(connectionId, sessions);` 之后加播种未读：

```ts
      for (const sess of sessions) {
        if (sess.isResident && (sess.unreadCount ?? 0) > 0) {
          useSessionStore.getState().setUnread(makeChatKey(connectionId, sess.key), sess.unreadCount ?? 0);
        }
      }
```

- [ ] **Step 6: SessionDropdown 置顶常驻 + 已读上报**

在 `packages/web/src/components/SessionDropdown.tsx`：

`sessionLabelText` 改为对常驻加 📌：

```ts
function sessionLabelText(s: Session): string {
  const base = s.label?.trim() || s.key.split(":").pop() || s.key;
  return s.isResident ? `📌 ${base}` : base;
}
```

`inactive` 排序让常驻优先（`.sort` 替换为）：

```ts
  const inactive = sessions
    .filter((s) => s.key !== activeKey)
    .sort((a, b) => {
      if (!!a.isResident !== !!b.isResident) return a.isResident ? -1 : 1;
      return (
        lastMessageOrCreatedAt(activeConnectionId, b, messagesByChat) -
        lastMessageOrCreatedAt(activeConnectionId, a, messagesByChat)
      );
    });
```

在 `switchSession` 里，切到会话已清 client 未读；对常驻额外上报服务端已读。替换 `switchSession`：

```ts
  const switchSession = (key: string) => {
    if (!activeConnectionId) return;
    setActiveSession(activeConnectionId, key);
    clearSessionUnread(activeConnectionId, key);
    const sess = sessions.find((s) => s.key === key);
    if (sess?.isResident) {
      void getPlatform()
        .fetchApi(`/api/sessions/${encodeURIComponent(activeConnectionId)}/${encodeURIComponent(key)}/read`, { method: "POST" })
        .catch((err) => console.error("mark resident read failed:", err));
    }
    setOpen(false);
    setShowAll(false);
    setConfirmDeleteId(null);
  };
```

- [ ] **Step 7: 前端全量测试 + 类型检查**

Run: `pnpm --filter @cc-pet/web exec vitest run && pnpm --filter @cc-pet/web exec tsc --noEmit`
Expected: PASS（若既有快照因 📌 变化，更新对应断言）。

- [ ] **Step 8: 提交**

```bash
git add packages/web/src
git commit -m "feat(web): pin resident session, server-driven unread badge + pet animation"
```

---

# 阶段 P2：PWA Web Push 全链路

## Task 10: web-push 依赖 + PushSubscriptionStore

**Files:**
- Modify: `packages/server/package.json`
- Create: `packages/server/src/storage/push-subscriptions.ts`
- Test: `packages/server/tests/push-subscriptions.test.ts` (create)

**Interfaces:**
- Consumes: 迁移基础设施 (Task 3 的 `ensureColumn` 不需要；本表新建)
- Produces:
  - `interface PushSubscriptionRecord { tokenName: string; endpoint: string; p256dh: string; auth: string }`
  - `class PushSubscriptionStore`
    - `constructor(db: Database.Database)`（构造时建表）
    - `upsert(rec: PushSubscriptionRecord): void`（按 endpoint upsert）
    - `listByToken(tokenName: string): PushSubscriptionRecord[]`
    - `deleteByEndpoint(endpoint: string): void`

- [ ] **Step 1: 加依赖**

Run:
```bash
cd /home/hy/code/cc-pet-web && pnpm --filter @cc-pet/server add web-push && pnpm --filter @cc-pet/server add -D @types/web-push
```
Expected: `web-push` 出现在 `packages/server/package.json` 的 dependencies。

- [ ] **Step 2: 写失败测试**

Create `packages/server/tests/push-subscriptions.test.ts`:

```ts
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/push-subscriptions.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 4: 实现**

Create `packages/server/src/storage/push-subscriptions.ts`:

```ts
import type Database from "better-sqlite3";

export interface PushSubscriptionRecord {
  tokenName: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushSubscriptionStore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        token_name TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_push_subs_token ON push_subscriptions(token_name);
    `);
  }

  upsert(rec: PushSubscriptionRecord): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO push_subscriptions (endpoint, token_name, p256dh, auth, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         token_name = excluded.token_name,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         last_used_at = excluded.last_used_at`
    ).run(rec.endpoint, rec.tokenName, rec.p256dh, rec.auth, now, now);
  }

  listByToken(tokenName: string): PushSubscriptionRecord[] {
    const rows = this.db.prepare(
      `SELECT token_name, endpoint, p256dh, auth FROM push_subscriptions WHERE token_name = ?`
    ).all(tokenName) as { token_name: string; endpoint: string; p256dh: string; auth: string }[];
    return rows.map((r) => ({ tokenName: r.token_name, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
  }

  deleteByEndpoint(endpoint: string): void {
    this.db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/push-subscriptions.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/server/package.json pnpm-lock.yaml packages/server/src/storage/push-subscriptions.ts packages/server/tests/push-subscriptions.test.ts
git commit -m "feat(server): add web-push dep and PushSubscriptionStore"
```

---

## Task 11: WebPushService

**Files:**
- Create: `packages/server/src/push/web-push-service.ts`
- Test: `packages/server/tests/web-push-service.test.ts` (create)

**Interfaces:**
- Consumes: `PushSubscriptionStore` (Task 10), `WebPushConfig` (Task 1)
- Produces:
  - `interface WebPushSender { sendNotification(sub: unknown, payload: string): Promise<{ statusCode?: number }> }` (注入点，便于测试；默认用 `web-push`)
  - `interface PushPayload { title: string; body: string; data?: Record<string, unknown> }`
  - `class WebPushService`
    - `constructor(store: PushSubscriptionStore, config: WebPushConfig | undefined, opts?: { sender?: WebPushSender; logger?: { warn(o: unknown, m: string): void } })`
    - `get enabled(): boolean`
    - `publicKey(): string | null`
    - `sendToToken(tokenName: string, payload: PushPayload): Promise<void>`（遍历订阅发送；对 404/410 调用 `store.deleteByEndpoint`）

- [ ] **Step 1: 写失败测试**

Create `packages/server/tests/web-push-service.test.ts`:

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/web-push-service.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

Create `packages/server/src/push/web-push-service.ts`:

```ts
import webpush from "web-push";
import type { WebPushConfig } from "@cc-pet/shared";
import type { PushSubscriptionStore } from "../storage/push-subscriptions.js";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface WebPushSender {
  sendNotification(sub: unknown, payload: string): Promise<{ statusCode?: number }>;
}

interface ServiceLogger {
  warn(obj: unknown, msg: string): void;
}

export class WebPushService {
  private readonly sender: WebPushSender;
  private readonly config?: WebPushConfig;
  private readonly log?: ServiceLogger;

  constructor(
    private store: PushSubscriptionStore,
    config: WebPushConfig | undefined,
    opts?: { sender?: WebPushSender; logger?: ServiceLogger },
  ) {
    this.config = config;
    this.log = opts?.logger;
    if (config && !opts?.sender) {
      webpush.setVapidDetails(config.subject, config.vapidPublicKey, config.vapidPrivateKey);
    }
    this.sender = opts?.sender ?? {
      sendNotification: (sub, payload) =>
        webpush.sendNotification(sub as webpush.PushSubscription, payload) as Promise<{ statusCode?: number }>,
    };
  }

  get enabled(): boolean {
    return Boolean(this.config);
  }

  publicKey(): string | null {
    return this.config?.vapidPublicKey ?? null;
  }

  async sendToToken(tokenName: string, payload: PushPayload): Promise<void> {
    if (!this.enabled) return;
    const subs = this.store.listByToken(tokenName);
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (s) => {
        const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
        try {
          await this.sender.sendNotification(sub, body);
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            this.store.deleteByEndpoint(s.endpoint);
          } else {
            this.log?.warn({ endpoint: s.endpoint, statusCode }, "web push send failed");
          }
        }
      }),
    );
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/web-push-service.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/push/web-push-service.ts packages/server/tests/web-push-service.test.ts
git commit -m "feat(server): WebPushService with dead-subscription pruning"
```

---

## Task 12: 推送订阅 REST 路由

**Files:**
- Create: `packages/server/src/api/push.ts`
- Test: `packages/server/tests/push-api.test.ts` (create)

**Interfaces:**
- Consumes: `PushSubscriptionStore` (Task 10), `WebPushService` (Task 11), `AuthIdentity` via `getRequestAuthIdentity`
- Produces: `registerPushRoutes(app, deps)` 其中
  - `interface PushRoutesDeps { store: PushSubscriptionStore; webPush: WebPushService; getAuthIdentity: (req) => AuthIdentity | null }`
  - `GET /api/push/vapid-public-key` → `{ publicKey: string | null }`
  - `POST /api/push/subscribe` body `{ endpoint, keys: { p256dh, auth } }` → 存储归属当前 token
  - `POST /api/push/unsubscribe` body `{ endpoint }` → 删除

- [ ] **Step 1: 写失败测试**

Create `packages/server/tests/push-api.test.ts`:

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/push-api.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

Create `packages/server/src/api/push.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PushSubscriptionStore } from "../storage/push-subscriptions.js";
import type { WebPushService } from "../push/web-push-service.js";
import type { AuthIdentity } from "../auth/token-auth.js";

export interface PushRoutesDeps {
  store: PushSubscriptionStore;
  webPush: WebPushService;
  getAuthIdentity: (req: FastifyRequest) => AuthIdentity | null;
}

interface SubscribeBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

export function registerPushRoutes(app: FastifyInstance, deps: PushRoutesDeps): void {
  const { store, webPush, getAuthIdentity } = deps;

  app.get("/api/push/vapid-public-key", async () => ({ publicKey: webPush.publicKey() }));

  app.post<{ Body: SubscribeBody }>("/api/push/subscribe", async (req, reply) => {
    const auth = getAuthIdentity(req);
    if (!auth) return reply.code(401).send({ error: "Unauthorized" });
    const { endpoint, keys } = req.body ?? {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return reply.code(400).send({ error: "Invalid subscription" });
    }
    store.upsert({ tokenName: auth.tokenName, endpoint, p256dh: keys.p256dh, auth: keys.auth });
    return { ok: true };
  });

  app.post<{ Body: { endpoint?: string } }>("/api/push/unsubscribe", async (req, reply) => {
    const auth = getAuthIdentity(req);
    if (!auth) return reply.code(401).send({ error: "Unauthorized" });
    const endpoint = req.body?.endpoint;
    if (!endpoint) return reply.code(400).send({ error: "endpoint is required" });
    store.deleteByEndpoint(endpoint);
    return { ok: true };
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/push-api.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/api/push.ts packages/server/tests/push-api.test.ts
git commit -m "feat(server): push subscription REST routes"
```

---

## Task 13: ProactiveDetector

**Files:**
- Create: `packages/server/src/resident/proactive-detector.ts`
- Test: `packages/server/tests/proactive-detector.test.ts` (create)

**Interfaces:**
- Produces:
  - `class ProactiveDetector`
    - `constructor(opts?: { windowMs?: number; now?: () => number })`（默认 windowMs=5min）
    - `markUserSend(connectionId: string, sessionKey: string): void`
    - `isProactive(connectionId: string, sessionKey: string): boolean`（窗口内无 user send → true）

- [ ] **Step 1: 写失败测试**

Create `packages/server/tests/proactive-detector.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ProactiveDetector } from "../src/resident/proactive-detector.js";

describe("ProactiveDetector", () => {
  it("is proactive when there was no recent user send", () => {
    const d = new ProactiveDetector({ windowMs: 1000, now: () => 10_000 });
    expect(d.isProactive("cc", "resident")).toBe(true);
  });

  it("is not proactive within the window after a user send", () => {
    let t = 0;
    const d = new ProactiveDetector({ windowMs: 1000, now: () => t });
    t = 5000;
    d.markUserSend("cc", "resident");
    t = 5500; // within 1000ms
    expect(d.isProactive("cc", "resident")).toBe(false);
    t = 6600; // beyond window
    expect(d.isProactive("cc", "resident")).toBe(true);
  });

  it("tracks sessions independently", () => {
    let t = 0;
    const d = new ProactiveDetector({ windowMs: 1000, now: () => t });
    t = 100;
    d.markUserSend("cc", "a");
    t = 200;
    expect(d.isProactive("cc", "a")).toBe(false);
    expect(d.isProactive("cc", "b")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/proactive-detector.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

Create `packages/server/src/resident/proactive-detector.ts`:

```ts
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

export class ProactiveDetector {
  private readonly windowMs: number;
  private readonly now: () => number;
  private lastUserSendAt = new Map<string, number>();

  constructor(opts?: { windowMs?: number; now?: () => number }) {
    this.windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = opts?.now ?? (() => Date.now());
  }

  markUserSend(connectionId: string, sessionKey: string): void {
    this.lastUserSendAt.set(`${connectionId}::${sessionKey}`, this.now());
  }

  /** True when the latest turn was not preceded by a recent local user send (e.g. cron). */
  isProactive(connectionId: string, sessionKey: string): boolean {
    const last = this.lastUserSendAt.get(`${connectionId}::${sessionKey}`);
    if (last === undefined) return true;
    return this.now() - last > this.windowMs;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/proactive-detector.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/resident/proactive-detector.ts packages/server/tests/proactive-detector.test.ts
git commit -m "feat(server): ProactiveDetector for cron-vs-user message discrimination"
```

---

## Task 14: 装配 P2 到 index.ts（订阅路由 + 主动消息推送）

**Files:**
- Modify: `packages/server/src/index.ts`
- Test: 手工

**Interfaces:**
- Consumes: `PushSubscriptionStore`, `WebPushService`, `registerPushRoutes`, `ProactiveDetector`, Task 8 的 `bumpResidentUnread`

- [ ] **Step 1: 实例化 push 子系统**

在 `packages/server/src/index.ts` import 区加：

```ts
import { PushSubscriptionStore } from "./storage/push-subscriptions.js";
import { WebPushService } from "./push/web-push-service.js";
import { registerPushRoutes } from "./api/push.js";
```

在 `const proactiveDetector = new ProactiveDetector();` 之后加：

```ts
const pushSubscriptionStore = new PushSubscriptionStore(db);
const webPush = new WebPushService(pushSubscriptionStore, initialConfig.webPush, { logger: app.log });
if (!webPush.enabled) {
  app.log.warn("Web push disabled: no valid webPush config; RESIDENT push notifications will not be sent");
}
```

- [ ] **Step 2: 注册 push 路由**

在其它 `register*Routes(app, ...)` 附近（`registerSessionRoutes` 之后）加：

```ts
registerPushRoutes(app, {
  store: pushSubscriptionStore,
  webPush,
  getAuthIdentity: getRequestAuthIdentity,
});
```

- [ ] **Step 3: 主动消息触发推送**

修改 Task 8 里加入的 `bumpResidentUnread` helper，补上推送：

```ts
  const bumpResidentUnread = (contentPreview: string): void => {
    if (!sessionKey) return;
    const r = onResidentAssistantMessage({ registry: residentRegistry, sessionStore }, connId, sessionKey);
    if (!r) return;
    hub.broadcast(WS_EVENTS.RESIDENT_UNREAD, {
      connectionId: connId,
      sessionKey,
      unreadCount: r.unreadCount,
    });
    if (r.ownerToken && proactiveDetector.isProactive(connId, sessionKey)) {
      const label = residentRegistry.pairs().find((p) => p.connectionId === connId && p.key === sessionKey)?.label;
      void webPush.sendToToken(r.ownerToken, {
        title: label ? `常驻助手 · ${label}` : "常驻助手",
        body: contentPreview.slice(0, 120) || "有新的主动消息",
        data: { connectionId: connId, sessionKey },
      });
    }
  };
```

更新 Task 8 中 4 处调用点，传入对应内容预览：
1. `case "reply":` → `bumpResidentUnread(replyContent);`
2. `case "reply_stream":` done 分支 → `bumpResidentUnread(fullText ?? "");`
3. `case "file":` → `bumpResidentUnread(fileName);`
4. `case "card":` → `bumpResidentUnread(msg.card?.header?.title ?? "");`

- [ ] **Step 4: 类型检查 + 服务端全量测试**

Run: `pnpm --filter @cc-pet/server exec tsc --noEmit && pnpm --filter @cc-pet/server test`
Expected: PASS

- [ ] **Step 5: 手工验证推送触发**

准备本地 `cc-pet.config.json`（含 residentSession + webPush，VAPID 用 `npx web-push generate-vapid-keys` 生成），启动服务端；用 curl 订阅一个假 endpoint 无法真正验证浏览器推送，故此步仅确认：向常驻 session 通过 bridge 手工投递一条 reply（或等 cron）后，日志无异常、`RESIDENT_UNREAD` 广播产生。真·端到端推送在 Task 16/17 前端完成后手工验证。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/index.ts
git commit -m "feat(server): register push routes and send proactive resident push"
```

---

## Task 15: 前端订阅库 lib/push.ts

**Files:**
- Create: `packages/web/src/lib/push.ts`
- Test: `packages/web/src/lib/push.test.ts` (create)

**Interfaces:**
- Produces:
  - `urlBase64ToUint8Array(base64: string): Uint8Array`
  - `isPushSupported(): boolean`
  - `subscribePush(): Promise<boolean>`（取 VAPID key → SW 注册 → PushManager.subscribe → POST /api/push/subscribe）
  - `unsubscribePush(): Promise<void>`

- [ ] **Step 1: 写失败测试（纯函数）**

Create `packages/web/src/lib/push.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { urlBase64ToUint8Array } from "./push.js";

describe("urlBase64ToUint8Array", () => {
  it("decodes URL-safe base64 VAPID key to bytes", () => {
    // "hello" standard base64 is aGVsbG8=; URL-safe unpadded: aGVsbG8
    const bytes = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/web exec vitest run src/lib/push.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

Create `packages/web/src/lib/push.ts`:

```ts
import { getPlatform } from "./platform.js";

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window
  );
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.ready);
}

/** Subscribe this browser for push. Returns true on success. Assumes Notification permission already granted. */
export async function subscribePush(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const keyRes = await getPlatform().fetchApi<{ publicKey: string | null }>("/api/push/vapid-public-key");
  if (!keyRes.publicKey) return false;
  const reg = await getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyRes.publicKey),
  });
  const json = sub.toJSON();
  await getPlatform().fetchApi("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  return true;
}

export async function unsubscribePush(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await getPlatform()
    .fetchApi("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) })
    .catch(() => {});
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/web exec vitest run src/lib/push.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/push.ts packages/web/src/lib/push.test.ts
git commit -m "feat(web): push subscription client library"
```

---

## Task 16: 自定义 Service Worker（injectManifest）

**Files:**
- Modify: `packages/web/vite.config.ts`
- Create: `packages/web/src/sw.ts`
- Test: 手工（构建产物 + 浏览器）

**Interfaces:**
- Consumes: 无（SW 独立运行）
- Produces: 构建出的 SW 含 `precacheAndRoute(self.__WB_MANIFEST)` + `push` + `notificationclick`

- [ ] **Step 1: 切换 PWA 策略**

在 `packages/web/vite.config.ts` 的 `VitePWA({ ... })` 配置里，把 `registerType: "autoUpdate",` 之后加入 injectManifest 策略，并保留 manifest：

```ts
    VitePWA({
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
      },
      manifest: {
        // ...保持原有 manifest 内容不变...
      },
    }),
```

删除原 `workbox: { ... }` 块（injectManifest 模式下改由 `sw.ts` 内的 `precacheAndRoute` 接管；`navigateFallbackDenylist` 逻辑对本应用非必需，SW 只做 precache + push）。

- [ ] **Step 2: 编写 SW**

Create `packages/web/src/sw.ts`:

```ts
/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("push", (event: PushEvent) => {
  let payload: { title?: string; body?: string; data?: Record<string, unknown> } = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { body: event.data?.text() };
  }
  const title = payload.title || "常驻助手";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "有新的主动消息",
      icon: "/pwa-192x192.png",
      badge: "/pwa-192x192.png",
      tag: "resident-proactive",
      data: payload.data ?? {},
    }),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientList.find((c) => "focus" in c) as WindowClient | undefined;
      if (existing) {
        await existing.focus();
      } else {
        await self.clients.openWindow("/");
      }
    })(),
  );
});
```

- [ ] **Step 3: 确认 workbox-precaching 可用**

`vite-plugin-pwa` 已依赖 workbox 家族；若 `workbox-precaching` 未直接可解析，安装为 web 依赖：

Run: `pnpm --filter @cc-pet/web add -D workbox-precaching`
Expected: 出现在 devDependencies。

- [ ] **Step 4: 构建验证**

Run: `pnpm --filter @cc-pet/web build`
Expected: 构建成功，`dist/sw.js` 存在且包含 `push` 监听（`grep -c "addEventListener" packages/web/dist/sw.js` ≥ 2）。

- [ ] **Step 5: 提交**

```bash
git add packages/web/vite.config.ts packages/web/src/sw.ts packages/web/package.json pnpm-lock.yaml
git commit -m "feat(web): custom service worker with push + notificationclick"
```

---

## Task 17: SettingsPanel 后台推送开关 + 端到端手工验证

**Files:**
- Modify: `packages/web/src/components/SettingsPanel.tsx`
- Test: 手工（浏览器端到端）

**Interfaces:**
- Consumes: `subscribePush`/`unsubscribePush`/`isPushSupported` (Task 15), `requestNotificationPermission`/`getNotificationPermission` (existing `lib/notification.ts`)

- [ ] **Step 1: 读现有 SettingsPanel 结构**

Run: `sed -n '1,60p' packages/web/src/components/SettingsPanel.tsx`
Expected: 了解其如何渲染开关（现有通知开关模式），照其样式加一项。

- [ ] **Step 2: 加后台推送开关**

在 `packages/web/src/components/SettingsPanel.tsx`：
- import：

```ts
import { isPushSupported, subscribePush, unsubscribePush } from "../lib/push.js";
import { requestNotificationPermission, getNotificationPermission } from "../lib/notification.js";
```

- 组件内加 state 与 handler（放在现有 hooks 附近）：

```ts
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const togglePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (!pushOn) {
        if (getNotificationPermission() !== "granted") {
          const perm = await requestNotificationPermission();
          if (perm !== "granted") return;
        }
        const ok = await subscribePush();
        setPushOn(ok);
      } else {
        await unsubscribePush();
        setPushOn(false);
      }
    } catch (err) {
      console.error("toggle push failed:", err);
    } finally {
      setPushBusy(false);
    }
  };
```

- 在设置项列表里（通知设置附近）加入一行（仅在支持时显示），沿用现有开关样式类名：

```tsx
      {isPushSupported() && (
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-gray-800">后台推送（关页面也提醒）</span>
          <button
            type="button"
            onClick={() => void togglePush()}
            disabled={pushBusy}
            className="px-3 py-1 rounded-lg bg-accent/10 text-accent text-sm disabled:opacity-50"
          >
            {pushOn ? "已开启" : "开启"}
          </button>
        </div>
      )}
```

（若 `useState` 尚未 import，在文件顶部 `import { useState } from "react";` 补上。具体样式类名以该文件既有开关为准，保持一致。）

- [ ] **Step 3: 前端类型检查 + 测试**

Run: `pnpm --filter @cc-pet/web exec tsc --noEmit && pnpm --filter @cc-pet/web exec vitest run`
Expected: PASS

- [ ] **Step 4: 端到端手工验证（真实环境）**

1. 生成 VAPID：`npx web-push generate-vapid-keys`，把公私钥 + subject 填入部署的 `cc-pet.docker.config.json` 的 `webPush`，给 Ziiimo token 加 `residentSession: { bridgeId: "cc", key: "resident", label: "第二大脑" }`。
2. 按 CLAUDE.md 发布流程用 feature 分支镜像部署，或本地 `pnpm build && node packages/server/dist/index.js`（HTTPS 或 localhost 才能用 Web Push / SW）。
3. 浏览器打开 pet-web，登录 Ziiimo，设置面板点「开启」后台推送，授权通知。
4. 在承载 bridge `cc` 的 cczm 上配置一次性触发：`cc-connect cron add -c "*/1 * * * *" -s resident --session-mode reuse --prompt "说一句：常驻推送测试" --desc "push-test"`，然后 `pm2 restart cczm`。
5. **关闭 pet-web 页面**，等 cron 触发；预期收到系统推送通知，点击后打开 pet-web 并停在常驻 session；该 session 有未读徒标。
6. 打开页面在常驻 session 手动发一条消息并收到回复 → 预期**不**触发系统推送（isProactive=false），仅正常显示。
7. 清理：`cc-connect cron del <id>` + `pm2 restart cczm`。

Expected: 主动消息（cron）关页面能收到推送；手动对话回复不推送。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/components/SettingsPanel.tsx
git commit -m "feat(web): background push toggle in settings"
```

---

## 执行顺序说明

Task 编号即推荐执行顺序，但有一处依赖需注意：**Task 8 依赖 Task 13 的 `ProactiveDetector`**（Task 8 装配时 import 了它）。两种执行方式：
- 简单：按 P1(1–7) → 先做 Task 13（ProactiveDetector）→ Task 8 → Task 9 → P2 余下(10,11,12,14,15,16,17)。
- 或：Task 8 先只接 registry + 未读广播（不 import detector），把 `markUserSend` 与 detector 相关行留到 Task 14 一起加。执行者可自行选择；推荐第一种，避免返工。

## 收尾（全部完成后）

- [ ] 全量测试：`pnpm test`
- [ ] 全量构建：`pnpm build`
- [ ] 按 spec §9 更新部署配置文档（cron recipe + VAPID 生成步骤）写入 `cc-pet.docker.config.json` 注释或 README
- [ ] 按 CLAUDE.md「发布流程」用 feature 分支镜像验证后合并 main
