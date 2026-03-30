# CC Pet Web — B/S 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CC Pet 从 Tauri 桌面应用重构为 B/S 架构的 monorepo 项目，支持浏览器和桌面宠物双形态。

**Architecture:** pnpm monorepo 包含 4 个包——shared（类型）、server（Fastify + ws 后端）、web（React SPA）、desktop（Tauri 薄壳）。Server 作为中间代理，上游连 cc-connect Bridge WebSocket，下游通过 WebSocket + REST 为前端提供服务。

**Tech Stack:** TypeScript, Fastify, ws, better-sqlite3, React 19, Vite, Zustand, Tailwind CSS, Framer Motion, Tauri v2

**Source spec:** `docs/specs/2026-03-30-bs-refactor-design.md`

**Source project (reference):** `/Users/StevenZhu/code/cc-pet` — 现有 Tauri 项目，迁移时参照其中的类型定义、Bridge 协议、组件逻辑。

---

## File Map

```
cc-pet-web/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docker-compose.yml
├── Dockerfile
├── .gitignore
│
├── packages/shared/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/index.ts
│   ├── src/types/message.ts
│   ├── src/types/session.ts
│   ├── src/types/config.ts
│   ├── src/types/bridge.ts
│   ├── src/types/index.ts
│   ├── src/constants/events.ts
│   └── src/utils/chat-key.ts
│
├── packages/server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/index.ts
│   ├── src/bridge/client.ts
│   ├── src/bridge/protocol.ts
│   ├── src/bridge/manager.ts
│   ├── src/ws/hub.ts
│   ├── src/api/config.ts
│   ├── src/api/sessions.ts
│   ├── src/api/history.ts
│   ├── src/api/files.ts
│   ├── src/api/misc.ts
│   ├── src/storage/db.ts
│   ├── src/storage/messages.ts
│   ├── src/storage/sessions.ts
│   ├── src/storage/config.ts
│   ├── src/services/link-preview.ts
│   ├── src/services/update-check.ts
│   └── tests/
│       ├── storage.test.ts
│       ├── bridge-protocol.test.ts
│       └── api.test.ts
│
├── packages/web/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── tailwind.config.ts
│   ├── postcss.config.js
│   ├── src/main.tsx
│   ├── src/App.tsx
│   ├── src/lib/platform.ts
│   ├── src/lib/web-adapter.ts
│   ├── src/lib/tauri-adapter.ts
│   ├── src/lib/store/connection.ts
│   ├── src/lib/store/session.ts
│   ├── src/lib/store/message.ts
│   ├── src/lib/store/config.ts
│   ├── src/lib/store/ui.ts
│   ├── src/lib/store/index.ts
│   ├── src/components/Layout.tsx
│   ├── src/components/Pet.tsx
│   ├── src/components/ChatWindow.tsx
│   ├── src/components/MessageList.tsx
│   ├── src/components/MessageInput.tsx
│   ├── src/components/ButtonCard.tsx
│   ├── src/components/SessionDropdown.tsx
│   ├── src/components/Settings.tsx
│   ├── src/components/SlashCommandMenu.tsx
│   ├── src/components/LinkPreview.tsx
│   ├── src/components/ConnectionStatus.tsx
│   ├── src/components/MobileNav.tsx
│   ├── src/styles/globals.css
│   ├── src/assets/pet/
│   └── tests/
│       ├── setup.ts
│       ├── platform.test.ts
│       └── store.test.ts
│
└── packages/desktop/
    ├── package.json
    ├── src-tauri/
    │   ├── Cargo.toml
    │   ├── tauri.conf.json
    │   ├── src/main.rs
    │   └── src/lib.rs
    └── src/
        └── tauri-boot.ts
```

---

## Task 1: Monorepo 脚手架

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`

- [ ] **Step 1: 创建根 package.json**

```json
{
  "name": "cc-pet-web",
  "private": true,
  "scripts": {
    "dev:server": "pnpm --filter @cc-pet/server dev",
    "dev:web": "pnpm --filter @cc-pet/web dev",
    "dev": "pnpm run dev:server & pnpm run dev:web",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 2: 创建 pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 3: 创建 tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: 创建 .gitignore**

```
node_modules/
dist/
.superpowers/
*.db
*.db-journal
.env
.DS_Store
target/
```

- [ ] **Step 5: 初始化 pnpm 并验证**

Run: `pnpm install`
Expected: 空 lockfile 创建成功，无报错

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: initialize monorepo with pnpm workspace"
```

---

## Task 2: Shared 类型包

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `packages/shared/src/types/message.ts`, `session.ts`, `config.ts`, `bridge.ts`, `index.ts`
- Create: `packages/shared/src/constants/events.ts`
- Create: `packages/shared/src/utils/chat-key.ts`
- Create: `packages/shared/src/index.ts`

**Reference:** 现有项目 `/Users/StevenZhu/code/cc-pet/src/lib/types.ts` 中的类型定义

- [ ] **Step 1: 创建 shared/package.json**

```json
{
  "name": "@cc-pet/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: 创建 shared/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 types/message.ts**

参照现有 `cc-pet/src/lib/types.ts`，提取消息相关类型：

```typescript
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  connectionId?: string;
  sessionKey?: string;
  buttons?: ButtonOption[];
  files?: FileAttachment[];
  replyCtx?: string;
  preview?: PreviewBlock;
}

export interface ButtonOption {
  id: string;
  label: string;
  value: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  size: number;
  url?: string;
}

export interface PreviewBlock {
  id: string;
  content: string;
}

export interface StreamDelta {
  connectionId: string;
  sessionKey: string;
  delta: string;
}

export interface StreamDone {
  connectionId: string;
  sessionKey: string;
  fullText: string;
}
```

- [ ] **Step 4: 创建 types/session.ts**

```typescript
export interface Session {
  key: string;
  connectionId: string;
  label?: string;
  createdAt: number;
  lastActiveAt: number;
}

export type TaskPhase =
  | "idle"
  | "thinking"
  | "processing"
  | "waiting_confirm"
  | "completed"
  | "failed"
  | "possibly_stuck";

export interface SessionTaskState {
  phase: TaskPhase;
  startedAt?: number;
  timeoutMs?: number;
}
```

- [ ] **Step 5: 创建 types/config.ts**

```typescript
export interface AppConfig {
  bridges: BridgeConfig[];
  pet: PetConfig;
  server: ServerConfig;
}

export interface BridgeConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  token: string;
  enabled: boolean;
}

export interface PetConfig {
  appearance?: string;
  opacity: number;
  size: number;
}

export interface ServerConfig {
  port: number;
  dataDir: string;
}
```

- [ ] **Step 6: 创建 types/bridge.ts**

定义 Bridge 协议消息类型（cc-connect ↔ Server 之间）：

```typescript
export type BridgeIncoming =
  | { type: "register_ack"; session_key: string }
  | { type: "reply"; session_key: string; reply_ctx?: string; content: string }
  | { type: "reply_stream"; session_key: string; reply_ctx?: string; content?: string; done?: boolean; full_text?: string }
  | { type: "buttons"; session_key: string; content?: string; buttons: BridgeButton[] }
  | { type: "typing_start"; session_key: string }
  | { type: "typing_stop"; session_key: string }
  | { type: "preview_start"; session_key: string; preview_id: string; content: string }
  | { type: "update_message"; session_key: string; preview_id: string; content: string }
  | { type: "delete_message"; session_key: string; preview_id: string }
  | { type: "file"; session_key: string; name: string; data: string }
  | { type: "skills_updated"; commands: SlashCommand[] }
  | { type: "error"; message: string };

export interface BridgeButton {
  id: string;
  label: string;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export type BridgeOutgoing =
  | { type: "message"; session_key: string; content: string }
  | { type: "button_response"; session_key: string; button_id: string; custom_input?: string }
  | { type: "file"; session_key: string; name: string; data: string };
```

- [ ] **Step 7: 创建 types/index.ts 和 constants/events.ts**

`types/index.ts`:
```typescript
export * from "./message.js";
export * from "./session.js";
export * from "./config.js";
export * from "./bridge.js";
```

`constants/events.ts` — Server ↔ 前端 WebSocket 事件名：
```typescript
export const WS_EVENTS = {
  // 下行 (Server → 前端)
  BRIDGE_CONNECTED: "bridge:connected",
  BRIDGE_ERROR: "bridge:error",
  BRIDGE_MESSAGE: "bridge:message",
  BRIDGE_STREAM_DELTA: "bridge:stream-delta",
  BRIDGE_STREAM_DONE: "bridge:stream-done",
  BRIDGE_BUTTONS: "bridge:buttons",
  BRIDGE_TYPING_START: "bridge:typing-start",
  BRIDGE_TYPING_STOP: "bridge:typing-stop",
  BRIDGE_FILE_RECEIVED: "bridge:file-received",
  BRIDGE_SKILLS_UPDATED: "bridge:skills-updated",
  BRIDGE_PREVIEW_START: "bridge:preview-start",
  BRIDGE_PREVIEW_UPDATE: "bridge:preview-update",
  BRIDGE_PREVIEW_DELETE: "bridge:preview-delete",

  // 上行 (前端 → Server)
  SEND_MESSAGE: "send-message",
  SEND_BUTTON: "send-button",
  SEND_FILE: "send-file",
} as const;
```

- [ ] **Step 8: 创建 utils/chat-key.ts**

```typescript
export function makeChatKey(connectionId: string, sessionKey: string): string {
  return `${connectionId}::${sessionKey}`;
}

export function parseChatKey(chatKey: string): { connectionId: string; sessionKey: string } {
  const idx = chatKey.indexOf("::");
  if (idx === -1) throw new Error(`Invalid chatKey: ${chatKey}`);
  return {
    connectionId: chatKey.slice(0, idx),
    sessionKey: chatKey.slice(idx + 2),
  };
}
```

- [ ] **Step 9: 创建 src/index.ts（barrel export）**

```typescript
export * from "./types/index.js";
export * from "./constants/events.js";
export * from "./utils/chat-key.js";
```

- [ ] **Step 10: 安装依赖并验证类型检查**

Run: `cd packages/shared && pnpm install && pnpm typecheck`
Expected: 无类型错误

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(shared): add type definitions, constants, and utilities"
```

---

## Task 3: Server 脚手架

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`
- Create: `packages/server/src/index.ts`

- [ ] **Step 1: 创建 server/package.json**

```json
{
  "name": "@cc-pet/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node --import tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: 创建 server/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: 安装依赖**

Run:
```bash
cd packages/server
pnpm add fastify @fastify/static @fastify/multipart @fastify/cors ws better-sqlite3 tsx
pnpm add -D @types/ws @types/better-sqlite3 vitest typescript
```

- [ ] **Step 4: 创建 src/index.ts — 最小可运行的 Fastify 服务器**

```typescript
import Fastify from "fastify";
import cors from "@fastify/cors";

const PORT = parseInt(process.env.CC_PET_PORT ?? "3000", 10);

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

app.get("/api/health", async () => ({ status: "ok", timestamp: Date.now() }));

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`CC Pet Server running on http://localhost:${PORT}`);
```

- [ ] **Step 5: 启动并验证**

Run: `pnpm dev`
Then: `curl http://localhost:3000/api/health`
Expected: `{"status":"ok","timestamp":...}`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): scaffold Fastify server with health endpoint"
```

---

## Task 4: SQLite 存储层

**Files:**
- Create: `packages/server/src/storage/db.ts`
- Create: `packages/server/src/storage/messages.ts`
- Create: `packages/server/src/storage/sessions.ts`
- Create: `packages/server/src/storage/config.ts`
- Create: `packages/server/tests/storage.test.ts`

**Reference:** 现有项目 `/Users/StevenZhu/code/cc-pet/src-tauri/src/history.rs` 中的 schema 和 CRUD 逻辑

- [ ] **Step 1: 编写 storage 单元测试**

`tests/storage.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
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
        id: "msg-1",
        role: "user",
        content: "hello",
        timestamp: Date.now(),
        connectionId: "conn-1",
        sessionKey: "default",
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
  });

  describe("ConfigStore", () => {
    it("should save and load config", () => {
      const cfg = { bridges: [], pet: { opacity: 1, size: 120 }, server: { port: 3000, dataDir: "./data" } };
      config.save(cfg);
      const loaded = config.load();
      expect(loaded).toEqual(cfg);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd packages/server && pnpm test`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 storage/db.ts**

```typescript
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export function createDatabase(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "cc-pet.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      connection_id TEXT,
      session_key TEXT,
      extra TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_key ON messages(chat_key);

    CREATE TABLE IF NOT EXISTS sessions (
      connection_id TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY (connection_id, key)
    );

    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
  `);
}
```

- [ ] **Step 4: 实现 storage/messages.ts**

```typescript
import type Database from "better-sqlite3";
import type { ChatMessage } from "@cc-pet/shared";
import { makeChatKey } from "@cc-pet/shared";

export class MessageStore {
  private stmtInsert;
  private stmtSelect;
  private stmtDelete;

  constructor(private db: Database.Database) {
    this.stmtInsert = db.prepare(
      `INSERT OR REPLACE INTO messages (id, chat_key, role, content, timestamp, connection_id, session_key, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.stmtSelect = db.prepare(
      `SELECT * FROM messages WHERE chat_key = ? ORDER BY timestamp ASC`
    );
    this.stmtDelete = db.prepare(`DELETE FROM messages WHERE chat_key = ?`);
  }

  save(msg: ChatMessage): void {
    const chatKey = makeChatKey(msg.connectionId ?? "", msg.sessionKey ?? "");
    const extra = JSON.stringify({
      buttons: msg.buttons,
      files: msg.files,
      replyCtx: msg.replyCtx,
      preview: msg.preview,
    });
    this.stmtInsert.run(msg.id, chatKey, msg.role, msg.content, msg.timestamp, msg.connectionId, msg.sessionKey, extra);
  }

  getByChatKey(chatKey: string): ChatMessage[] {
    const rows = this.stmtSelect.all(chatKey) as any[];
    return rows.map((r) => {
      const extra = r.extra ? JSON.parse(r.extra) : {};
      return {
        id: r.id,
        role: r.role,
        content: r.content,
        timestamp: r.timestamp,
        connectionId: r.connection_id,
        sessionKey: r.session_key,
        ...extra,
      };
    });
  }

  deleteByChatKey(chatKey: string): void {
    this.stmtDelete.run(chatKey);
  }
}
```

- [ ] **Step 5: 实现 storage/sessions.ts**

```typescript
import type Database from "better-sqlite3";
import type { Session } from "@cc-pet/shared";

export class SessionStore {
  constructor(private db: Database.Database) {}

  create(session: Session): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO sessions (connection_id, key, label, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(session.connectionId, session.key, session.label ?? null, session.createdAt, session.lastActiveAt);
  }

  listByConnection(connectionId: string): Session[] {
    const rows = this.db.prepare(
      `SELECT * FROM sessions WHERE connection_id = ? ORDER BY last_active_at DESC`
    ).all(connectionId) as any[];
    return rows.map((r) => ({
      key: r.key,
      connectionId: r.connection_id,
      label: r.label ?? undefined,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
    }));
  }

  delete(connectionId: string, key: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE connection_id = ? AND key = ?`).run(connectionId, key);
  }

  updateLabel(connectionId: string, key: string, label: string): void {
    this.db.prepare(`UPDATE sessions SET label = ? WHERE connection_id = ? AND key = ?`).run(label, connectionId, key);
  }

  touchActive(connectionId: string, key: string): void {
    this.db.prepare(`UPDATE sessions SET last_active_at = ? WHERE connection_id = ? AND key = ?`).run(Date.now(), connectionId, key);
  }
}
```

- [ ] **Step 6: 实现 storage/config.ts**

```typescript
import type Database from "better-sqlite3";
import type { AppConfig } from "@cc-pet/shared";

const DEFAULT_CONFIG: AppConfig = {
  bridges: [],
  pet: { opacity: 1, size: 120 },
  server: { port: 3000, dataDir: "./data" },
};

export class ConfigStore {
  constructor(private db: Database.Database) {}

  load(): AppConfig {
    const row = this.db.prepare(`SELECT data FROM config WHERE id = 1`).get() as any;
    if (!row) return { ...DEFAULT_CONFIG };
    return JSON.parse(row.data);
  }

  save(config: AppConfig): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO config (id, data) VALUES (1, ?)`
    ).run(JSON.stringify(config));
  }
}
```

- [ ] **Step 7: 运行测试验证通过**

Run: `cd packages/server && pnpm test`
Expected: 所有测试 PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(server): add SQLite storage layer with tests"
```

---

## Task 5: Bridge WebSocket 客户端

**Files:**
- Create: `packages/server/src/bridge/client.ts`
- Create: `packages/server/src/bridge/protocol.ts`
- Create: `packages/server/tests/bridge-protocol.test.ts`

**Reference:** 现有项目 `/Users/StevenZhu/code/cc-pet/src-tauri/src/bridge.rs` 中的 WebSocket 连接和消息处理逻辑

- [ ] **Step 1: 编写 protocol 解析测试**

`tests/bridge-protocol.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { parseBridgeMessage } from "../src/bridge/protocol.js";

describe("parseBridgeMessage", () => {
  it("should parse reply message", () => {
    const raw = JSON.stringify({ type: "reply", session_key: "s1", content: "hello" });
    const msg = parseBridgeMessage(raw);
    expect(msg).toEqual({ type: "reply", session_key: "s1", content: "hello" });
  });

  it("should parse stream message", () => {
    const raw = JSON.stringify({ type: "reply_stream", session_key: "s1", content: "chunk", done: false });
    const msg = parseBridgeMessage(raw);
    expect(msg).toEqual({ type: "reply_stream", session_key: "s1", content: "chunk", done: false });
  });

  it("should parse buttons message", () => {
    const raw = JSON.stringify({ type: "buttons", session_key: "s1", content: "pick one", buttons: [{ id: "1", label: "Yes" }] });
    const msg = parseBridgeMessage(raw);
    expect(msg.type).toBe("buttons");
  });

  it("should return error for invalid JSON", () => {
    const msg = parseBridgeMessage("not json");
    expect(msg.type).toBe("error");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test`
Expected: FAIL

- [ ] **Step 3: 实现 bridge/protocol.ts**

```typescript
import type { BridgeIncoming } from "@cc-pet/shared";

export function parseBridgeMessage(raw: string): BridgeIncoming {
  try {
    const data = JSON.parse(raw);
    if (!data.type) return { type: "error", message: "Missing type field" };
    return data as BridgeIncoming;
  } catch {
    return { type: "error", message: `Invalid JSON: ${raw.slice(0, 100)}` };
  }
}
```

- [ ] **Step 4: 实现 bridge/client.ts**

```typescript
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { BridgeConfig, BridgeIncoming, BridgeOutgoing } from "@cc-pet/shared";
import { parseBridgeMessage } from "./protocol.js";

export interface BridgeClientEvents {
  message: [connectionId: string, msg: BridgeIncoming];
  connected: [connectionId: string];
  disconnected: [connectionId: string, reason: string];
  error: [connectionId: string, error: string];
}

export class BridgeClient extends EventEmitter<BridgeClientEvents> {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;

  constructor(
    public readonly connectionId: string,
    private config: BridgeConfig,
  ) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.ws) this.disconnect();

    const url = `ws://${this.config.host}:${this.config.port}/bridge/ws?token=${encodeURIComponent(this.config.token)}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this._connected = true;
      this.emit("connected", this.connectionId);
    });

    this.ws.on("message", (data) => {
      const raw = data.toString();
      const msg = parseBridgeMessage(raw);
      this.emit("message", this.connectionId, msg);
    });

    this.ws.on("close", (code, reason) => {
      this._connected = false;
      this.emit("disconnected", this.connectionId, reason.toString());
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.emit("error", this.connectionId, err.message);
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  send(msg: BridgeOutgoing): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emit("error", this.connectionId, "WebSocket not connected");
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm test`
Expected: 所有测试 PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add Bridge WebSocket client and protocol parser"
```

---

## Task 6: Bridge Manager + Client WebSocket Hub

**Files:**
- Create: `packages/server/src/bridge/manager.ts`
- Create: `packages/server/src/ws/hub.ts`

- [ ] **Step 1: 实现 bridge/manager.ts**

```typescript
import { EventEmitter } from "node:events";
import type { BridgeConfig, BridgeIncoming, BridgeOutgoing } from "@cc-pet/shared";
import { BridgeClient } from "./client.js";

export class BridgeManager extends EventEmitter {
  private clients = new Map<string, BridgeClient>();

  connect(config: BridgeConfig): void {
    if (this.clients.has(config.id)) this.disconnect(config.id);

    const client = new BridgeClient(config.id, config);

    client.on("message", (connId, msg) => this.emit("message", connId, msg));
    client.on("connected", (connId) => this.emit("connected", connId));
    client.on("disconnected", (connId, reason) => this.emit("disconnected", connId, reason));
    client.on("error", (connId, err) => this.emit("error", connId, err));

    this.clients.set(config.id, client);
    client.connect();
  }

  disconnect(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      client.disconnect();
      this.clients.delete(id);
    }
  }

  send(connectionId: string, msg: BridgeOutgoing): void {
    const client = this.clients.get(connectionId);
    if (!client) throw new Error(`No bridge connection: ${connectionId}`);
    client.send(msg);
  }

  getStatus(id: string): boolean {
    return this.clients.get(id)?.connected ?? false;
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) client.disconnect();
    this.clients.clear();
  }
}
```

- [ ] **Step 2: 实现 ws/hub.ts**

```typescript
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { WS_EVENTS } from "@cc-pet/shared";

interface ClientInfo {
  ws: WebSocket;
  authenticated: boolean;
}

export class ClientHub {
  private wss: WebSocketServer;
  private clients = new Set<ClientInfo>();
  private secret: string;

  constructor(server: Server, secret: string) {
    this.secret = secret;
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const token = url.searchParams.get("token");
      const authenticated = token === this.secret;

      if (!authenticated) {
        ws.close(4001, "Unauthorized");
        return;
      }

      const client: ClientInfo = { ws, authenticated };
      this.clients.add(client);

      ws.on("close", () => this.clients.delete(client));
      ws.on("error", () => this.clients.delete(client));

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.onClientMessage(client, msg);
        } catch { /* ignore malformed */ }
      });
    });
  }

  private onClientMessage(_client: ClientInfo, _msg: any): void {
    // Will be wired to BridgeManager in server/index.ts
  }

  /** Set handler for client messages (called from index.ts) */
  onMessage: (msg: any) => void = () => {};

  broadcast(event: string, payload: Record<string, any>): void {
    const data = JSON.stringify({ type: event, ...payload });
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  close(): void {
    this.wss.close();
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(server): add BridgeManager and ClientHub WebSocket layers"
```

---

## Task 7: REST API 路由

**Files:**
- Create: `packages/server/src/api/config.ts`, `sessions.ts`, `history.ts`, `files.ts`, `misc.ts`
- Create: `packages/server/tests/api.test.ts`

- [ ] **Step 1: 实现 api/config.ts**

```typescript
import type { FastifyInstance } from "fastify";
import type { ConfigStore } from "../storage/config.js";

export function registerConfigRoutes(app: FastifyInstance, store: ConfigStore) {
  app.get("/api/config", async () => store.load());

  app.put<{ Body: any }>("/api/config", async (req) => {
    store.save(req.body);
    return { ok: true };
  });
}
```

- [ ] **Step 2: 实现 api/sessions.ts**

```typescript
import type { FastifyInstance } from "fastify";
import type { SessionStore } from "../storage/sessions.js";
import type { BridgeManager } from "../bridge/manager.js";

export function registerSessionRoutes(app: FastifyInstance, store: SessionStore, bridge: BridgeManager) {
  app.get("/api/sessions", async () => {
    // 返回所有连接的所有会话（聚合）
    return { sessions: [] }; // placeholder — 在 Task 9 集成时完善
  });

  app.post<{ Body: { connectionId: string; key: string; label?: string } }>("/api/sessions", async (req) => {
    const { connectionId, key, label } = req.body;
    const now = Date.now();
    store.create({ key, connectionId, label, createdAt: now, lastActiveAt: now });
    return { ok: true };
  });

  app.delete<{ Params: { connectionId: string; key: string } }>("/api/sessions/:connectionId/:key", async (req) => {
    store.delete(req.params.connectionId, req.params.key);
    return { ok: true };
  });
}
```

- [ ] **Step 3: 实现 api/history.ts**

```typescript
import type { FastifyInstance } from "fastify";
import type { MessageStore } from "../storage/messages.js";

export function registerHistoryRoutes(app: FastifyInstance, store: MessageStore) {
  app.get<{ Params: { chatKey: string } }>("/api/history/:chatKey", async (req) => {
    return { messages: store.getByChatKey(decodeURIComponent(req.params.chatKey)) };
  });

  app.delete<{ Params: { chatKey: string } }>("/api/history/:chatKey", async (req) => {
    store.deleteByChatKey(decodeURIComponent(req.params.chatKey));
    return { ok: true };
  });
}
```

- [ ] **Step 4: 实现 api/files.ts**

```typescript
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function registerFileRoutes(app: FastifyInstance, dataDir: string) {
  const filesDir = path.join(dataDir, "files");
  fs.mkdirSync(filesDir, { recursive: true });

  app.post("/api/files/upload", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "No file" });

    const id = randomUUID();
    const ext = path.extname(data.filename);
    const filePath = path.join(filesDir, `${id}${ext}`);
    const buf = await data.toBuffer();
    fs.writeFileSync(filePath, buf);

    return { id, name: data.filename, size: buf.length, url: `/api/files/${id}${ext}` };
  });

  app.get<{ Params: { fileId: string } }>("/api/files/:fileId", async (req, reply) => {
    const filePath = path.join(filesDir, req.params.fileId);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile(req.params.fileId, filesDir);
  });
}
```

- [ ] **Step 5: 实现 api/misc.ts**

```typescript
import type { FastifyInstance } from "fastify";

export function registerMiscRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { url: string } }>("/api/link-preview", async (req) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return { error: "Missing url param" };

    try {
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(5000) });
      const html = await res.text();
      const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
      const desc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "";
      const image = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "";
      return { url: targetUrl, title, description: desc, image };
    } catch {
      return { url: targetUrl, title: "", description: "", image: "" };
    }
  });

  app.get("/api/update-check", async () => {
    try {
      const res = await fetch("https://api.github.com/repos/zzmzz/cc-pet-web/releases/latest", {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { hasUpdate: false };
      const data = await res.json() as any;
      return { hasUpdate: true, version: data.tag_name, url: data.html_url };
    } catch {
      return { hasUpdate: false };
    }
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add REST API routes for config, sessions, history, files"
```

---

## Task 8: Server 集成——串联所有模块

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: 重写 index.ts 串联所有模块**

```typescript
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WS_EVENTS } from "@cc-pet/shared";
import type { BridgeIncoming } from "@cc-pet/shared";
import { createDatabase } from "./storage/db.js";
import { MessageStore } from "./storage/messages.js";
import { SessionStore } from "./storage/sessions.js";
import { ConfigStore } from "./storage/config.js";
import { BridgeManager } from "./bridge/manager.js";
import { ClientHub } from "./ws/hub.js";
import { registerConfigRoutes } from "./api/config.js";
import { registerSessionRoutes } from "./api/sessions.js";
import { registerHistoryRoutes } from "./api/history.js";
import { registerFileRoutes } from "./api/files.js";
import { registerMiscRoutes } from "./api/misc.js";

const PORT = parseInt(process.env.CC_PET_PORT ?? "3000", 10);
const SECRET = process.env.CC_PET_SECRET ?? "cc-pet-dev";
const DATA_DIR = process.env.CC_PET_DATA_DIR ?? "./data";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Database
const db = createDatabase(DATA_DIR);
const messageStore = new MessageStore(db);
const sessionStore = new SessionStore(db);
const configStore = new ConfigStore(db);

// Fastify
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(multipart);

// Serve web frontend static files in production
const webDistPath = path.resolve(__dirname, "../../web/dist");
try {
  await app.register(staticPlugin, { root: webDistPath, prefix: "/" });
} catch {
  app.log.warn("Web dist not found, skipping static file serving");
}

// REST API
app.get("/api/health", async () => ({ status: "ok" }));
registerConfigRoutes(app, configStore);
registerSessionRoutes(app, sessionStore, bridgeManager);
registerHistoryRoutes(app, messageStore);
registerFileRoutes(app, DATA_DIR);
registerMiscRoutes(app);

// Bridge Manager
const bridgeManager = new BridgeManager();

// Start HTTP server
await app.listen({ port: PORT, host: "0.0.0.0" });

// Client WebSocket Hub (needs raw HTTP server)
const hub = new ClientHub(app.server, SECRET);

// Wire Bridge events → Client Hub
bridgeManager.on("connected", (connId: string) => {
  hub.broadcast(WS_EVENTS.BRIDGE_CONNECTED, { connectionId: connId, connected: true });
});

bridgeManager.on("disconnected", (connId: string, reason: string) => {
  hub.broadcast(WS_EVENTS.BRIDGE_CONNECTED, { connectionId: connId, connected: false, reason });
});

bridgeManager.on("error", (connId: string, err: string) => {
  hub.broadcast(WS_EVENTS.BRIDGE_ERROR, { connectionId: connId, error: err });
});

bridgeManager.on("message", (connId: string, msg: BridgeIncoming) => {
  const sessionKey = "session_key" in msg ? (msg as any).session_key : undefined;

  switch (msg.type) {
    case "reply":
      messageStore.save({
        id: `msg-${Date.now()}`, role: "assistant", content: msg.content,
        timestamp: Date.now(), connectionId: connId, sessionKey,
      });
      hub.broadcast(WS_EVENTS.BRIDGE_MESSAGE, { connectionId: connId, sessionKey, content: msg.content, replyCtx: msg.reply_ctx });
      break;
    case "reply_stream":
      if (msg.done) {
        if (msg.full_text) {
          messageStore.save({
            id: `msg-${Date.now()}`, role: "assistant", content: msg.full_text,
            timestamp: Date.now(), connectionId: connId, sessionKey,
          });
        }
        hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DONE, { connectionId: connId, sessionKey, fullText: msg.full_text });
      } else {
        hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DELTA, { connectionId: connId, sessionKey, delta: msg.content });
      }
      break;
    case "buttons":
      hub.broadcast(WS_EVENTS.BRIDGE_BUTTONS, { connectionId: connId, sessionKey, content: msg.content, buttons: msg.buttons });
      break;
    case "typing_start":
      hub.broadcast(WS_EVENTS.BRIDGE_TYPING_START, { connectionId: connId, sessionKey });
      break;
    case "typing_stop":
      hub.broadcast(WS_EVENTS.BRIDGE_TYPING_STOP, { connectionId: connId, sessionKey });
      break;
    case "file":
      hub.broadcast(WS_EVENTS.BRIDGE_FILE_RECEIVED, { connectionId: connId, name: msg.name });
      break;
    case "skills_updated":
      hub.broadcast(WS_EVENTS.BRIDGE_SKILLS_UPDATED, { connectionId: connId, commands: msg.commands });
      break;
    case "preview_start":
      hub.broadcast(WS_EVENTS.BRIDGE_PREVIEW_START, { connectionId: connId, sessionKey, previewId: msg.preview_id, content: msg.content });
      break;
    case "update_message":
      hub.broadcast(WS_EVENTS.BRIDGE_PREVIEW_UPDATE, { connectionId: connId, sessionKey, previewId: msg.preview_id, content: msg.content });
      break;
    case "delete_message":
      hub.broadcast(WS_EVENTS.BRIDGE_PREVIEW_DELETE, { connectionId: connId, sessionKey, previewId: msg.preview_id });
      break;
    case "error":
      hub.broadcast(WS_EVENTS.BRIDGE_ERROR, { connectionId: connId, error: msg.message });
      break;
  }
});

// Wire Client Hub messages → Bridge Manager
hub.onMessage = (msg: any) => {
  const { type, connectionId, sessionKey, content, buttonId, fileId, customInput } = msg;
  switch (type) {
    case WS_EVENTS.SEND_MESSAGE:
      messageStore.save({
        id: `msg-${Date.now()}`, role: "user", content,
        timestamp: Date.now(), connectionId, sessionKey,
      });
      bridgeManager.send(connectionId, { type: "message", session_key: sessionKey, content });
      break;
    case WS_EVENTS.SEND_BUTTON:
      bridgeManager.send(connectionId, { type: "button_response", session_key: sessionKey, button_id: buttonId, custom_input: customInput });
      break;
    case WS_EVENTS.SEND_FILE:
      // File upload handled via REST, this sends the reference to bridge
      bridgeManager.send(connectionId, { type: "file", session_key: sessionKey, name: fileId, data: "" });
      break;
  }
};

// Auto-connect configured bridges on startup
const config = configStore.load();
for (const bridge of config.bridges) {
  if (bridge.enabled) bridgeManager.connect(bridge);
}

// Bridge connect/disconnect API (added to existing routes)
app.post<{ Params: { id: string }; Body: any }>("/api/bridges/:id/connect", async (req) => {
  const cfg = configStore.load();
  const bridge = cfg.bridges.find((b) => b.id === req.params.id);
  if (!bridge) return { error: "Bridge not found" };
  bridgeManager.connect(bridge);
  return { ok: true };
});

app.post<{ Params: { id: string } }>("/api/bridges/:id/disconnect", async (req) => {
  bridgeManager.disconnect(req.params.id);
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/api/bridges/:id/status", async (req) => {
  return { connected: bridgeManager.getStatus(req.params.id) };
});

console.log(`CC Pet Server running on http://localhost:${PORT}`);
```

- [ ] **Step 2: 修复 BridgeManager 引用顺序（移到 REST 路由注册之前）**

注意上面代码中 `bridgeManager` 的声明位置需要在 `registerSessionRoutes` 调用之前。调整代码顺序使其正确。

- [ ] **Step 3: 启动验证**

Run: `cd packages/server && pnpm dev`
Expected: 服务启动在 3000 端口，无报错，`/api/health` 返回 ok

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(server): wire all modules together in server entry point"
```

---

## Task 9: Web 前端脚手架

**Files:**
- Create: `packages/web/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`
- Create: `packages/web/tailwind.config.ts`, `postcss.config.js`
- Create: `packages/web/src/main.tsx`, `src/App.tsx`, `src/styles/globals.css`

- [ ] **Step 1: 创建 web/package.json**

```json
{
  "name": "@cc-pet/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 2: 安装依赖**

```bash
cd packages/web
pnpm add react react-dom react-markdown react-syntax-highlighter rehype-raw remark-gfm zustand framer-motion
pnpm add -D @types/react @types/react-dom @types/react-syntax-highlighter @vitejs/plugin-react vite typescript tailwindcss postcss autoprefixer vitest @testing-library/react @testing-library/jest-dom jsdom
```

- [ ] **Step 3: 创建 vite.config.ts**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 1420 },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});
```

- [ ] **Step 4: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["DOM", "DOM.Iterable", "ES2022"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 5: 创建 tailwind + postcss 配置**

`tailwind.config.ts`:
```typescript
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: "#0d1117", secondary: "#161b22", tertiary: "#21262d" },
        border: { DEFAULT: "#30363d" },
        accent: { DEFAULT: "#58a6ff" },
      },
    },
  },
  plugins: [],
} satisfies Config;
```

`postcss.config.js`:
```javascript
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 6: 创建 index.html, main.tsx, App.tsx, globals.css**

`index.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>CC Pet</title></head>
  <body class="bg-surface text-white"><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`src/main.tsx`:
```typescript
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>
);
```

`src/App.tsx`:
```typescript
export default function App() {
  return <div className="min-h-screen flex items-center justify-center text-lg">CC Pet Web — coming soon</div>;
}
```

`src/styles/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`tests/setup.ts`:
```typescript
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 7: 验证 dev server**

Run: `pnpm dev`
Expected: Vite 在 1420 端口启动，浏览器显示 "CC Pet Web — coming soon"

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): scaffold React + Vite + Tailwind frontend"
```

---

## Task 10: 平台适配层 + Zustand Stores

**Files:**
- Create: `packages/web/src/lib/platform.ts`, `web-adapter.ts`, `tauri-adapter.ts`
- Create: `packages/web/src/lib/store/connection.ts`, `session.ts`, `message.ts`, `config.ts`, `ui.ts`, `index.ts`
- Create: `packages/web/tests/platform.test.ts`, `tests/store.test.ts`

- [ ] **Step 1: 实现 platform.ts — 适配器接口**

```typescript
import type { AppConfig, ChatMessage } from "@cc-pet/shared";

export interface PlatformAPI {
  connectWs(): void;
  disconnectWs(): void;
  onWsEvent(handler: (type: string, payload: any) => void): () => void;
  sendWsMessage(msg: any): void;

  fetchApi<T = any>(path: string, options?: RequestInit): Promise<T>;

  setWindowMode?(mode: "pet" | "chat" | "settings"): void;
  setAlwaysOnTop?(value: boolean): void;
  setOpacity?(value: number): void;
  startDrag?(): void;
}

let _platform: PlatformAPI | null = null;

export function setPlatform(p: PlatformAPI) { _platform = p; }
export function getPlatform(): PlatformAPI {
  if (!_platform) throw new Error("Platform not initialized");
  return _platform;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}
```

- [ ] **Step 2: 实现 web-adapter.ts**

```typescript
import type { PlatformAPI } from "./platform.js";

export function createWebAdapter(serverUrl: string, token: string): PlatformAPI {
  let ws: WebSocket | null = null;
  let eventHandler: ((type: string, payload: any) => void) | null = null;

  return {
    connectWs() {
      const url = `${serverUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(url);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          eventHandler?.(msg.type, msg);
        } catch { /* ignore */ }
      };
      ws.onclose = () => setTimeout(() => this.connectWs(), 3000);
    },

    disconnectWs() {
      ws?.close();
      ws = null;
    },

    onWsEvent(handler) {
      eventHandler = handler;
      return () => { eventHandler = null; };
    },

    sendWsMessage(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },

    async fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
      const res = await fetch(`${serverUrl}${path}`, {
        ...options,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...options?.headers },
      });
      return res.json() as T;
    },
  };
}
```

- [ ] **Step 3: 实现 tauri-adapter.ts（占位，完整实现在 Task 15）**

```typescript
import type { PlatformAPI } from "./platform.js";

export function createTauriAdapter(serverUrl: string, token: string): PlatformAPI {
  // Tauri 环境下，业务通信仍走 WebSocket/REST（与 Web 相同），
  // 仅窗口控制走 Tauri invoke
  const { createWebAdapter } = await import("./web-adapter.js");
  const base = createWebAdapter(serverUrl, token);

  return {
    ...base,

    async setWindowMode(mode) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_window_mode", { mode });
    },

    async setAlwaysOnTop(value) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_always_on_top", { value });
    },

    async setOpacity(value) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_opacity", { value });
    },

    async startDrag() {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("start_drag");
    },
  };
}
```

- [ ] **Step 4: 实现 store/ui.ts**

```typescript
import { create } from "zustand";
import type { TaskPhase } from "@cc-pet/shared";

export type PetState = "idle" | "thinking" | "talking" | "happy" | "error";

interface UIState {
  chatOpen: boolean;
  settingsOpen: boolean;
  petState: PetState;
  isMobile: boolean;

  setChatOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setPetState: (state: PetState) => void;
  setIsMobile: (mobile: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  chatOpen: false,
  settingsOpen: false,
  petState: "idle",
  isMobile: false,

  setChatOpen: (open) => set({ chatOpen: open, settingsOpen: open ? false : undefined }),
  setSettingsOpen: (open) => set({ settingsOpen: open, chatOpen: open ? false : undefined }),
  setPetState: (petState) => set({ petState }),
  setIsMobile: (isMobile) => set({ isMobile }),
}));
```

- [ ] **Step 5: 实现 store/connection.ts**

```typescript
import { create } from "zustand";

export interface ConnectionInfo {
  id: string;
  name: string;
  connected: boolean;
}

interface ConnectionState {
  connections: ConnectionInfo[];
  activeConnectionId: string | null;

  setConnections: (connections: ConnectionInfo[]) => void;
  setConnectionStatus: (id: string, connected: boolean) => void;
  setActiveConnection: (id: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connections: [],
  activeConnectionId: null,

  setConnections: (connections) => set({ connections }),
  setConnectionStatus: (id, connected) =>
    set((s) => ({
      connections: s.connections.map((c) => (c.id === id ? { ...c, connected } : c)),
    })),
  setActiveConnection: (id) => set({ activeConnectionId: id }),
}));
```

- [ ] **Step 6: 实现 store/session.ts, store/message.ts, store/config.ts, store/index.ts**

`store/session.ts`:
```typescript
import { create } from "zustand";
import type { Session } from "@cc-pet/shared";

interface SessionState {
  sessions: Record<string, Session[]>;  // connectionId → sessions
  activeSessionKey: Record<string, string>; // connectionId → key
  unread: Record<string, number>; // chatKey → count

  setSessions: (connectionId: string, sessions: Session[]) => void;
  setActiveSession: (connectionId: string, key: string) => void;
  incrementUnread: (chatKey: string) => void;
  clearUnread: (chatKey: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: {},
  activeSessionKey: {},
  unread: {},

  setSessions: (connectionId, sessions) => set((s) => ({ sessions: { ...s.sessions, [connectionId]: sessions } })),
  setActiveSession: (connectionId, key) => set((s) => ({ activeSessionKey: { ...s.activeSessionKey, [connectionId]: key } })),
  incrementUnread: (chatKey) => set((s) => ({ unread: { ...s.unread, [chatKey]: (s.unread[chatKey] ?? 0) + 1 } })),
  clearUnread: (chatKey) => set((s) => ({ unread: { ...s.unread, [chatKey]: 0 } })),
}));
```

`store/message.ts`:
```typescript
import { create } from "zustand";
import type { ChatMessage } from "@cc-pet/shared";

interface MessageState {
  messagesByChat: Record<string, ChatMessage[]>; // chatKey → messages
  streamingContent: Record<string, string>; // chatKey → partial content

  addMessage: (chatKey: string, msg: ChatMessage) => void;
  setMessages: (chatKey: string, msgs: ChatMessage[]) => void;
  appendStreamDelta: (chatKey: string, delta: string) => void;
  finalizeStream: (chatKey: string, fullText: string) => void;
  clearMessages: (chatKey: string) => void;
}

export const useMessageStore = create<MessageState>((set) => ({
  messagesByChat: {},
  streamingContent: {},

  addMessage: (chatKey, msg) =>
    set((s) => ({
      messagesByChat: { ...s.messagesByChat, [chatKey]: [...(s.messagesByChat[chatKey] ?? []), msg] },
    })),
  setMessages: (chatKey, msgs) =>
    set((s) => ({ messagesByChat: { ...s.messagesByChat, [chatKey]: msgs } })),
  appendStreamDelta: (chatKey, delta) =>
    set((s) => ({
      streamingContent: { ...s.streamingContent, [chatKey]: (s.streamingContent[chatKey] ?? "") + delta },
    })),
  finalizeStream: (chatKey, fullText) =>
    set((s) => {
      const { [chatKey]: _, ...rest } = s.streamingContent;
      return {
        streamingContent: rest,
        messagesByChat: {
          ...s.messagesByChat,
          [chatKey]: [...(s.messagesByChat[chatKey] ?? []), { id: `msg-${Date.now()}`, role: "assistant", content: fullText, timestamp: Date.now() }],
        },
      };
    }),
  clearMessages: (chatKey) =>
    set((s) => ({ messagesByChat: { ...s.messagesByChat, [chatKey]: [] } })),
}));
```

`store/config.ts`:
```typescript
import { create } from "zustand";
import type { AppConfig } from "@cc-pet/shared";

interface ConfigState {
  config: AppConfig | null;
  setConfig: (config: AppConfig) => void;
}

export const useConfigStore = create<ConfigState>((set) => ({
  config: null,
  setConfig: (config) => set({ config }),
}));
```

`store/index.ts`:
```typescript
export { useUIStore } from "./ui.js";
export { useConnectionStore } from "./connection.js";
export { useSessionStore } from "./session.js";
export { useMessageStore } from "./message.js";
export { useConfigStore } from "./config.js";
```

- [ ] **Step 7: 编写 store 基础测试**

`tests/store.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { useMessageStore } from "../src/lib/store/message.js";

describe("MessageStore", () => {
  it("should add and retrieve messages", () => {
    const { addMessage, messagesByChat } = useMessageStore.getState();
    addMessage("conn::sess", { id: "1", role: "user", content: "hi", timestamp: 1 });
    const msgs = useMessageStore.getState().messagesByChat["conn::sess"];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("hi");
  });

  it("should handle stream delta and finalize", () => {
    const store = useMessageStore.getState();
    store.appendStreamDelta("conn::sess", "hel");
    store.appendStreamDelta("conn::sess", "lo");
    expect(useMessageStore.getState().streamingContent["conn::sess"]).toBe("hello");

    store.finalizeStream("conn::sess", "hello world");
    const state = useMessageStore.getState();
    expect(state.streamingContent["conn::sess"]).toBeUndefined();
    expect(state.messagesByChat["conn::sess"]?.at(-1)?.content).toBe("hello world");
  });
});
```

- [ ] **Step 8: 运行测试**

Run: `cd packages/web && pnpm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web): add platform adapter layer and Zustand stores"
```

---

## Task 11: Pet 组件 + Layout

**Files:**
- Create: `packages/web/src/components/Pet.tsx`
- Create: `packages/web/src/components/Layout.tsx`
- Create: `packages/web/src/components/ConnectionStatus.tsx`
- Copy: 宠物素材从 `cc-pet/src/assets/pet/` → `packages/web/src/assets/pet/`

**Reference:** 现有项目 `/Users/StevenZhu/code/cc-pet/src/components/Pet.tsx`

- [ ] **Step 1: 复制宠物素材**

```bash
cp -r /Users/StevenZhu/code/cc-pet/src/assets/pet packages/web/src/assets/
```

- [ ] **Step 2: 实现 Pet.tsx**

```typescript
import { motion } from "framer-motion";
import { useUIStore, type PetState } from "../lib/store/ui.js";
import { isTauri } from "../lib/platform.js";

import idleImg from "../assets/pet/idle.png";
import thinkingImg from "../assets/pet/thinking.png";
import talkingImg from "../assets/pet/talking.png";
import happyImg from "../assets/pet/happy.png";
import errorImg from "../assets/pet/error.png";

const PET_IMAGES: Record<PetState, string> = {
  idle: idleImg, thinking: thinkingImg, talking: talkingImg, happy: happyImg, error: errorImg,
};

const STATE_COLORS: Record<PetState, string> = {
  idle: "border-gray-500", thinking: "border-yellow-500", talking: "border-blue-500",
  happy: "border-green-500", error: "border-red-500",
};

const STATE_ANIMATIONS: Record<PetState, any> = {
  idle: {},
  thinking: { scale: [1, 1.05, 1], transition: { repeat: Infinity, duration: 1.5 } },
  talking: { opacity: [1, 0.8, 1], transition: { repeat: Infinity, duration: 1 } },
  happy: { y: [0, -4, 0], transition: { repeat: Infinity, duration: 0.6 } },
  error: { x: [0, -3, 3, -3, 0], transition: { repeat: Infinity, duration: 0.4 } },
};

/** Full-size pet for desktop sidebar / Tauri */
export function PetFull() {
  const { petState, chatOpen, setChatOpen } = useUIStore();

  return (
    <motion.div
      className="cursor-pointer select-none"
      animate={STATE_ANIMATIONS[petState]}
      onClick={() => setChatOpen(!chatOpen)}
      onDoubleClick={() => isTauri() && setChatOpen(!chatOpen)}
    >
      <img src={PET_IMAGES[petState]} alt="pet" className="w-28 h-28 mx-auto" draggable={false} />
      <div className="text-center text-xs text-gray-400 mt-1">{petState}</div>
    </motion.div>
  );
}

/** Mini avatar for mobile top bar */
export function PetMini() {
  const { petState, setChatOpen, chatOpen } = useUIStore();

  return (
    <motion.button
      className={`w-8 h-8 rounded-full border-2 ${STATE_COLORS[petState]} overflow-hidden flex-shrink-0 bg-surface-tertiary`}
      animate={STATE_ANIMATIONS[petState]}
      onClick={() => setChatOpen(!chatOpen)}
    >
      <img src={PET_IMAGES[petState]} alt="pet" className="w-full h-full object-cover" />
    </motion.button>
  );
}
```

- [ ] **Step 3: 实现 ConnectionStatus.tsx**

```typescript
import { useConnectionStore } from "../lib/store/connection.js";

export function ConnectionStatus() {
  const { connections, activeConnectionId } = useConnectionStore();
  const active = connections.find((c) => c.id === activeConnectionId);
  if (!active) return null;

  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${active.connected ? "bg-green-500" : "bg-red-500"}`} />
      <span className="text-sm text-gray-300 truncate">{active.name}</span>
    </div>
  );
}
```

- [ ] **Step 4: 实现 Layout.tsx**

```typescript
import { useEffect } from "react";
import { useUIStore } from "../lib/store/ui.js";
import { PetFull, PetMini } from "./Pet.js";
import { ConnectionStatus } from "./ConnectionStatus.js";

export function Layout({ children }: { children: React.ReactNode }) {
  const { isMobile, setIsMobile } = useUIStore();

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [setIsMobile]);

  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-surface">
        {/* Mobile top bar */}
        <header className="flex items-center px-3 py-2 bg-surface-secondary border-b border-border gap-2">
          <PetMini />
          <div className="flex-1 min-w-0">
            <ConnectionStatus />
            <div className="text-xs text-gray-500 truncate">默认会话</div>
          </div>
          <button className="text-gray-400 text-lg">📋</button>
          <button className="text-gray-400 text-lg">⚙️</button>
        </header>
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-surface">
      {/* Desktop sidebar */}
      <aside className="w-52 bg-surface-secondary border-r border-border flex flex-col p-3 gap-4">
        <PetFull />
        <ConnectionStatus />
        <div className="flex-1 overflow-y-auto">
          {/* Session list rendered by parent */}
        </div>
        <button className="text-gray-400 hover:text-gray-200 text-sm">⚙️ 设置</button>
      </aside>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add Pet component, Layout, and ConnectionStatus"
```

---

## Task 12: Chat 组件（MessageList + MessageInput + ButtonCard）

**Files:**
- Create: `packages/web/src/components/MessageList.tsx`
- Create: `packages/web/src/components/MessageInput.tsx`
- Create: `packages/web/src/components/ButtonCard.tsx`
- Create: `packages/web/src/components/ChatWindow.tsx`

**Reference:** 现有项目 `/Users/StevenZhu/code/cc-pet/src/components/ChatWindow.tsx`

- [ ] **Step 1: 实现 MessageList.tsx**

```typescript
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { ChatMessage } from "@cc-pet/shared";
import { useRef, useEffect } from "react";

interface Props {
  messages: ChatMessage[];
  streamingContent?: string;
}

export function MessageList({ messages, streamingContent }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {streamingContent && (
        <MessageBubble message={{ id: "streaming", role: "assistant", content: streamingContent, timestamp: Date.now() }} />
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] rounded-lg px-3 py-2 ${isUser ? "bg-accent/20 text-blue-100" : "bg-surface-tertiary text-gray-200"}`}>
        <div className="text-[10px] text-gray-500 mb-1">{isUser ? "you" : "bot"}</div>
        <div className="prose prose-invert prose-sm max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || "");
                const code = String(children).replace(/\n$/, "");
                return match ? (
                  <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div">{code}</SyntaxHighlighter>
                ) : (
                  <code className="bg-surface-tertiary px-1 rounded" {...props}>{children}</code>
                );
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 实现 MessageInput.tsx**

```typescript
import { useState, useRef, type KeyboardEvent } from "react";

interface Props {
  onSend: (content: string) => void;
  onFileUpload?: (file: File) => void;
  disabled?: boolean;
}

export function MessageInput({ onSend, onFileUpload, disabled }: Props) {
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="flex items-end gap-2 p-3 bg-surface-secondary border-t border-border">
      <button className="text-gray-400 hover:text-gray-200 pb-1" onClick={() => fileRef.current?.click()}>📎</button>
      <input ref={fileRef} type="file" className="hidden" onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) onFileUpload?.(file);
        e.target.value = "";
      }} />
      <textarea
        className="flex-1 bg-surface-tertiary rounded-lg px-3 py-2 text-sm text-gray-200 resize-none outline-none placeholder:text-gray-600"
        rows={1}
        placeholder="输入消息..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      />
      <button
        className="bg-accent rounded-lg px-4 py-2 text-white text-sm font-medium disabled:opacity-40"
        onClick={handleSend}
        disabled={!text.trim() || disabled}
      >
        发送
      </button>
    </div>
  );
}
```

- [ ] **Step 3: 实现 ButtonCard.tsx**

```typescript
import type { ButtonOption } from "@cc-pet/shared";
import { useState } from "react";

interface Props {
  content?: string;
  buttons: ButtonOption[];
  onSelect: (buttonId: string, customInput?: string) => void;
}

export function ButtonCard({ content, buttons, onSelect }: Props) {
  const [customInput, setCustomInput] = useState("");
  const [selected, setSelected] = useState(false);

  if (selected) return null;

  return (
    <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
      {content && <p className="text-sm text-gray-300">{content}</p>}
      <div className="flex flex-wrap gap-2">
        {buttons.map((btn) => (
          <button
            key={btn.id}
            className="bg-accent/20 hover:bg-accent/30 text-accent px-3 py-1.5 rounded text-sm transition"
            onClick={() => { setSelected(true); onSelect(btn.id); }}
          >
            {btn.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2 mt-2">
        <input
          className="flex-1 bg-surface rounded px-2 py-1 text-sm text-gray-200 outline-none placeholder:text-gray-600"
          placeholder="自定义输入..."
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && customInput.trim() && (setSelected(true), onSelect("custom", customInput.trim()))}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 实现 ChatWindow.tsx（组装）**

```typescript
import { makeChatKey } from "@cc-pet/shared";
import { WS_EVENTS } from "@cc-pet/shared";
import { useConnectionStore } from "../lib/store/connection.js";
import { useSessionStore } from "../lib/store/session.js";
import { useMessageStore } from "../lib/store/message.js";
import { getPlatform } from "../lib/platform.js";
import { MessageList } from "./MessageList.js";
import { MessageInput } from "./MessageInput.js";
import { ButtonCard } from "./ButtonCard.js";

export function ChatWindow() {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const activeSessionKey = useSessionStore((s) =>
    activeConnectionId ? s.activeSessionKey[activeConnectionId] ?? "default" : "default"
  );
  const chatKey = activeConnectionId ? makeChatKey(activeConnectionId, activeSessionKey) : "";
  const messages = useMessageStore((s) => s.messagesByChat[chatKey] ?? []);
  const streaming = useMessageStore((s) => s.streamingContent[chatKey]);

  const handleSend = (content: string) => {
    if (!activeConnectionId) return;
    const platform = getPlatform();

    useMessageStore.getState().addMessage(chatKey, {
      id: `msg-${Date.now()}`,
      role: "user",
      content,
      timestamp: Date.now(),
      connectionId: activeConnectionId,
      sessionKey: activeSessionKey,
    });

    platform.sendWsMessage({
      type: WS_EVENTS.SEND_MESSAGE,
      connectionId: activeConnectionId,
      sessionKey: activeSessionKey,
      content,
    });
  };

  const handleButtonSelect = (buttonId: string, customInput?: string) => {
    if (!activeConnectionId) return;
    getPlatform().sendWsMessage({
      type: WS_EVENTS.SEND_BUTTON,
      connectionId: activeConnectionId,
      sessionKey: activeSessionKey,
      buttonId,
      customInput,
    });
  };

  return (
    <div className="flex flex-col h-full">
      <MessageList messages={messages} streamingContent={streaming} />
      <MessageInput onSend={handleSend} />
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add Chat components — MessageList, MessageInput, ButtonCard, ChatWindow"
```

---

## Task 13: Settings + SessionDropdown + SlashCommandMenu

**Files:**
- Create: `packages/web/src/components/Settings.tsx`
- Create: `packages/web/src/components/SessionDropdown.tsx`
- Create: `packages/web/src/components/SlashCommandMenu.tsx`

**Reference:** 现有项目对应组件

- [ ] **Step 1: 实现 Settings.tsx**

参照现有 `cc-pet/src/components/Settings.tsx`，实现 Bridge 配置管理（增删改）、宠物设置、保存功能。通过 `getPlatform().fetchApi()` 与 Server 通信。使用 `useConfigStore` 管理状态。

包含：Bridge 列表（name/host/port/token）、添加/删除 Bridge、保存按钮、更新检查按钮。

- [ ] **Step 2: 实现 SessionDropdown.tsx**

参照现有 `cc-pet/src/components/SessionDropdown.tsx`，实现会话切换下拉/sheet。显示当前连接下的所有会话，点击切换，支持新建和删除。通过 `fetchApi` 调用 `/api/sessions` 系列接口。

- [ ] **Step 3: 实现 SlashCommandMenu.tsx**

参照现有 `cc-pet/src/components/SlashCommandMenu.tsx`，实现 `/` 触发的命令补全菜单。从 store 中读取 `agentCommands`（通过 `bridge:skills-updated` 事件填充）。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(web): add Settings, SessionDropdown, SlashCommandMenu components"
```

---

## Task 14: App 组装 + WebSocket 事件绑定

**Files:**
- Modify: `packages/web/src/App.tsx`

- [ ] **Step 1: 重写 App.tsx 完成全局组装**

```typescript
import { useEffect, useState } from "react";
import { WS_EVENTS, makeChatKey } from "@cc-pet/shared";
import { setPlatform, isTauri } from "./lib/platform.js";
import { createWebAdapter } from "./lib/web-adapter.js";
import { Layout } from "./components/Layout.js";
import { ChatWindow } from "./components/ChatWindow.js";
import { Settings } from "./components/Settings.js";
import { useUIStore } from "./lib/store/ui.js";
import { useConnectionStore } from "./lib/store/connection.js";
import { useSessionStore } from "./lib/store/session.js";
import { useMessageStore } from "./lib/store/message.js";
import { useConfigStore } from "./lib/store/config.js";

export default function App() {
  const { settingsOpen } = useUIStore();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const serverUrl = localStorage.getItem("cc-pet-server-url") ?? "http://localhost:3000";
    const token = localStorage.getItem("cc-pet-token") ?? "";

    if (!token) {
      // 首次访问，显示登录
      useUIStore.getState().setSettingsOpen(true);
      setReady(true);
      return;
    }

    const adapter = createWebAdapter(serverUrl, token);
    setPlatform(adapter);

    // Load initial config
    adapter.fetchApi("/api/config").then((cfg: any) => {
      useConfigStore.getState().setConfig(cfg);
      const connections = (cfg.bridges ?? []).map((b: any) => ({ id: b.id, name: b.name, connected: false }));
      useConnectionStore.getState().setConnections(connections);
      if (connections.length > 0) {
        useConnectionStore.getState().setActiveConnection(connections[0].id);
      }
    });

    // Connect WebSocket and bind events
    const unsub = adapter.onWsEvent((type, payload) => {
      const { connectionId, sessionKey } = payload;
      const chatKey = connectionId && sessionKey ? makeChatKey(connectionId, sessionKey) : "";

      switch (type) {
        case WS_EVENTS.BRIDGE_CONNECTED:
          useConnectionStore.getState().setConnectionStatus(connectionId, payload.connected);
          if (payload.connected) useUIStore.getState().setPetState("happy");
          break;
        case WS_EVENTS.BRIDGE_MESSAGE:
          useMessageStore.getState().addMessage(chatKey, {
            id: `msg-${Date.now()}`, role: "assistant", content: payload.content,
            timestamp: Date.now(), connectionId, sessionKey,
          });
          useUIStore.getState().setPetState("idle");
          break;
        case WS_EVENTS.BRIDGE_STREAM_DELTA:
          useMessageStore.getState().appendStreamDelta(chatKey, payload.delta);
          useUIStore.getState().setPetState("talking");
          break;
        case WS_EVENTS.BRIDGE_STREAM_DONE:
          useMessageStore.getState().finalizeStream(chatKey, payload.fullText);
          useUIStore.getState().setPetState("idle");
          break;
        case WS_EVENTS.BRIDGE_BUTTONS:
          useMessageStore.getState().addMessage(chatKey, {
            id: `msg-${Date.now()}`, role: "assistant", content: payload.content ?? "",
            timestamp: Date.now(), connectionId, sessionKey, buttons: payload.buttons,
          });
          useUIStore.getState().setPetState("idle");
          break;
        case WS_EVENTS.BRIDGE_TYPING_START:
          useUIStore.getState().setPetState("thinking");
          break;
        case WS_EVENTS.BRIDGE_TYPING_STOP:
          useUIStore.getState().setPetState("idle");
          break;
        case WS_EVENTS.BRIDGE_ERROR:
          useUIStore.getState().setPetState("error");
          break;
      }
    });

    adapter.connectWs();
    setReady(true);

    return () => {
      unsub();
      adapter.disconnectWs();
    };
  }, []);

  if (!ready) return null;

  return (
    <Layout>
      {settingsOpen ? <Settings /> : <ChatWindow />}
    </Layout>
  );
}
```

- [ ] **Step 2: 验证 web dev 能启动**

Run: `cd packages/web && pnpm dev`
Expected: Vite 启动，页面渲染 Layout + ChatWindow

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(web): assemble App with Layout, WebSocket event binding, and routing"
```

---

## Task 15: Tauri 桌面壳

**Files:**
- Create: `packages/desktop/package.json`
- Create: `packages/desktop/src-tauri/Cargo.toml`, `tauri.conf.json`, `src/main.rs`, `src/lib.rs`
- Create: `packages/desktop/src/tauri-boot.ts`

**Reference:** 现有项目 `/Users/StevenZhu/code/cc-pet/src-tauri/`

- [ ] **Step 1: 创建 desktop/package.json**

```json
{
  "name": "@cc-pet/desktop",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

- [ ] **Step 2: 创建 Cargo.toml（精简版）**

```toml
[package]
name = "cc-pet-desktop"
version = "0.1.0"
edition = "2021"

[lib]
name = "cc_pet_desktop"
crate-type = ["lib", "cdylib", "staticlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["protocol-asset", "tray-icon", "macos-private-api", "image-png"] }
tauri-plugin-global-shortcut = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 3: 创建 tauri.conf.json**

```json
{
  "productName": "CC Pet",
  "version": "0.1.0",
  "identifier": "com.ccpet.desktop",
  "build": {
    "frontendDist": "../../web/dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "pnpm --filter @cc-pet/web dev",
    "beforeBuildCommand": "pnpm --filter @cc-pet/web build"
  },
  "app": {
    "withGlobalTauri": true,
    "macOSPrivateApi": true,
    "windows": [
      {
        "label": "main",
        "title": "CC Pet",
        "width": 480,
        "height": 640,
        "transparent": true,
        "decorations": false,
        "alwaysOnTop": true,
        "resizable": true,
        "skipTaskbar": true,
        "shadow": false,
        "visible": true
      }
    ]
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/icon.icns", "icons/icon.ico", "icons/icon.png"]
  }
}
```

- [ ] **Step 4: 创建 main.rs + lib.rs**

`src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cc_pet_desktop::run();
}
```

`src/lib.rs`:
```rust
use tauri::{Manager, WebviewWindow};

#[tauri::command]
fn set_window_mode(window: WebviewWindow, mode: String) {
    match mode.as_str() {
        "pet" => {
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: 200.0, height: 200.0 }));
            let _ = window.set_always_on_top(true);
        }
        "chat" => {
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: 480.0, height: 640.0 }));
            let _ = window.set_always_on_top(true);
        }
        "settings" => {
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: 500.0, height: 600.0 }));
            let _ = window.set_always_on_top(false);
        }
        _ => {}
    }
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, value: bool) {
    let _ = window.set_always_on_top(value);
}

#[tauri::command]
fn set_opacity(window: WebviewWindow, value: f64) {
    let _ = window.set_opacity(value);
}

#[tauri::command]
fn start_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            set_window_mode,
            set_always_on_top,
            set_opacity,
            start_drag,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(desktop): add Tauri v2 shell with minimal window control commands"
```

---

## Task 16: Docker 部署

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`

- [ ] **Step 1: 创建 Dockerfile**

```dockerfile
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/web packages/web
COPY tsconfig.base.json .

RUN pnpm --filter @cc-pet/web build

FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/package.json ./
COPY --from=builder /app/packages/shared packages/shared
COPY --from=builder /app/packages/server packages/server
COPY --from=builder /app/packages/web/dist packages/web/dist
COPY --from=builder /app/tsconfig.base.json .

RUN pnpm install --frozen-lockfile --prod

EXPOSE 3000

CMD ["node", "--import", "tsx", "packages/server/src/index.ts"]
```

- [ ] **Step 2: 创建 docker-compose.yml**

```yaml
services:
  cc-pet:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - CC_PET_SECRET=change-me
      - CC_PET_PORT=3000
      - CC_PET_DATA_DIR=/app/data
    restart: unless-stopped
```

- [ ] **Step 3: 验证构建**

Run: `docker compose build`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: add Dockerfile and docker-compose.yml for deployment"
```

---

## Task 17: 端到端冒烟测试

- [ ] **Step 1: 启动 Server 并验证 API**

```bash
cd packages/server && CC_PET_SECRET=test pnpm dev &
sleep 2
curl -s http://localhost:3000/api/health | grep -q '"status":"ok"'
curl -s -X PUT http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d '{"bridges":[],"pet":{"opacity":1,"size":120},"server":{"port":3000,"dataDir":"./data"}}' | grep -q '"ok":true'
curl -s http://localhost:3000/api/config | grep -q '"bridges"'
```

Expected: 所有请求返回正确响应

- [ ] **Step 2: 验证 Web 前端构建**

```bash
cd packages/web && pnpm build
ls dist/index.html
```

Expected: 构建产物存在

- [ ] **Step 3: 验证 Server 能 serve 静态文件**

启动 server 后访问 `http://localhost:3000`
Expected: 返回前端 HTML 页面

- [ ] **Step 4: 运行全部测试**

```bash
pnpm -r test
```

Expected: 所有包测试通过

- [ ] **Step 5: 最终 Commit**

```bash
git add -A
git commit -m "test: add end-to-end smoke tests and verify full stack"
```

---

## 后续 TODO（不在本计划范围内）

- [ ] LinkPreview 组件完善
- [ ] UpdateNotice 组件
- [ ] 文件下载进度指示
- [ ] Tauri 托盘菜单
- [ ] Tauri 全局快捷键注册
- [ ] PWA manifest
- [ ] GitHub Actions CI/CD
- [ ] LLM 直连（v1.1）
- [ ] SSH 隧道（v1.2）
