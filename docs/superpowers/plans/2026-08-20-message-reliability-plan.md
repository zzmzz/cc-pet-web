# 消息可靠性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除消息在数据库层被覆盖丢失的缺陷，并让上行发送与断线重连都不再丢消息。

**Architecture:** 分三层推进。服务端先把 message id 唯一化、写入语义从 `INSERT OR REPLACE` 改为显式 upsert（止血，独立可上线）；再引入单调 `seq` 列作为增量游标并开放 `afterSeq` 拉取；客户端最后建立带分级重发策略的 outbox 队列与重连补齐。

**Tech Stack:** TypeScript 6.0、Fastify 5、better-sqlite3 12.8、ws 8、React 19 + zustand、vitest 4.1.2、pnpm workspace

**Spec:** `docs/superpowers/specs/2026-08-20-message-reliability-design.md`

## Global Constraints

- 测试框架统一 vitest 4.1.2。服务端 `pnpm --filter @cc-pet/server test`，客户端 `pnpm --filter @cc-pet/web test`。
- **客户端测试在 Node 25+ 必须带 `NODE_OPTIONS=--no-experimental-webstorage`**，否则 Node 内置 localStorage 会与 jsdom 冲突。`packages/web/package.json` 的 `test` 脚本已包含该判断，务必通过 pnpm script 运行而非直接调 vitest。
- 服务端测试用内存库：`new Database(":memory:")` + `initSchema(db)`，参照 `packages/server/tests/storage.test.ts:11-24`。
- 提交信息遵循 conventional commits（`fix(server):`、`feat(web):` 等），与 `git log` 现有风格一致。
- `seq` 允许跳号，只要求单调递增；游标语义不依赖连续性。
- 不改动 bridge 协议，传给 bridge 的 `msg_id` 语义保持不变。
- 每个 task 结束时 `pnpm --filter @cc-pet/server typecheck` 必须通过（客户端由 `build` 中的 `tsc` 覆盖）。

---

### Task 1: 消息 id 唯一化与 upsert 写入语义

止血任务，独立可上线。修掉同毫秒 id 碰撞导致的数据库层覆盖。

**Files:**
- Modify: `packages/server/src/storage/messages.ts:23-27`（`stmtInsert`）
- Modify: `packages/server/src/index.ts:270,312,336,367,378,427,476`
- Modify: `packages/server/src/api/siri.ts:50`
- Test: `packages/server/tests/storage.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `MessageStore.save(msg: ChatMessage): void` 语义变更 —— 同 id 重复调用为更新而非删除重建

- [ ] **Step 1: 写失败测试**

在 `packages/server/tests/storage.test.ts` 的 `describe("MessageStore")` 内追加：

```ts
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
```

第一条用例是回归护栏（store 层本身不碰撞，缺陷在调用方拼 id）。第二条才是本 task 真正的红灯：
`INSERT OR REPLACE` 实际执行 DELETE + INSERT，rowid 会被重新分配并抬到末尾，断言必然失败。
这正是 Task 2 的 `seq` 必须建立在 upsert 之上的原因。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/storage.test.ts -t "in place"`

Expected: FAIL —— `expect(rowidOf("msg-dup")).toBe(originalRowid)` 不通过，rowid 已被 `OR REPLACE` 改写。

- [ ] **Step 3: 把 `INSERT OR REPLACE` 改为显式 upsert**

`packages/server/src/storage/messages.ts`，将 `stmtInsert` 替换为：

```ts
this.stmtInsert = db.prepare(
  `INSERT INTO messages (id, chat_key, role, content, timestamp, connection_id, session_key, extra)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     content = excluded.content,
     timestamp = excluded.timestamp,
     extra = excluded.extra`
);
```

不更新 `chat_key` 与 `role`：同一 id 不应改变归属。`OR REPLACE` 会 DELETE+INSERT 从而改变 rowid，改为 upsert 后行位置稳定，这是 Task 2 的 `seq` 得以保留的前提。

- [ ] **Step 4: 全部 8 处 id 生成改用 randomUUID**

`packages/server/src/index.ts` 顶部确保有 `import { randomUUID } from "node:crypto";`，然后把 7 处 `` `msg-${Date.now()}` `` 全部替换为 `` `msg-${randomUUID()}` ``（行号 270、312、336、367、378、427、476）。

第 427 行所在的 `SEND_MESSAGE` 分支同时定义了 `msgId`（`index.ts:416`），改为：

```ts
const msgId = `msg-${randomUUID()}`;
```

同时 `index.ts:339` 的 `` `file-${Date.now()}` ``、`:480` 的 `` `file-${Date.now()}-${file.file_name}` ``、`:490` 的 `` `msg-file-${Date.now()}` `` 同样存在碰撞风险，一并换成 `randomUUID()` 拼接。

`packages/server/src/api/siri.ts:50` 处的 `msgId` 同样改用 `randomUUID()`。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server test`

Expected: 全部 PASS，含新增两条用例。

- [ ] **Step 6: 类型检查**

Run: `pnpm --filter @cc-pet/server typecheck`

Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add packages/server/src/storage/messages.ts packages/server/src/index.ts packages/server/src/api/siri.ts packages/server/tests/storage.test.ts
git commit -m "fix(server): stop message loss from millisecond id collisions

消息 id 原本是 msg-\${Date.now()}，配合 INSERT OR REPLACE 会让同毫秒
到达的两条消息在库中互相覆盖。改用 randomUUID 并把写入语义换成显式
upsert，同时保持行 rowid 稳定。"
```

---

### Task 2: 单调 seq 列、迁移回填与稳定排序

**Files:**
- Modify: `packages/server/src/storage/db.ts:14-27`（`initSchema`）
- Modify: `packages/server/src/storage/messages.ts:16-31,48-73`
- Test: `packages/server/tests/storage.test.ts`

**Interfaces:**
- Consumes: Task 1 的 upsert 写入
- Produces:
  - `messages.seq` 列；`ChatMessage.seq?: number` 出现在 `getByChatKey` 返回值中
  - `MessageStore.save(msg: ChatMessage): number` —— 返回该消息在库中的 `seq`（新增即新分配，冲突则为原值），供 Task 4 回 ack 与下行推送携带

- [ ] **Step 1: 写失败测试**

追加到 `packages/server/tests/storage.test.ts` 的 `describe("MessageStore")`：

```ts
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
```

再追加一个迁移用例到 `describe("Storage")` 顶层：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/storage.test.ts -t seq`

Expected: FAIL，`seq` 为 `undefined`。

- [ ] **Step 3: schema 加列、迁移与索引**

`packages/server/src/storage/db.ts` 的 `initSchema` 中，`messages` 建表语句加入 `seq INTEGER`：

```ts
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_key TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  connection_id TEXT,
  session_key TEXT,
  extra TEXT,
  seq INTEGER
);
```

在 `db.exec(...)` 之后追加迁移与索引（幂等，可重复执行）：

```ts
const messageCols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
if (!messageCols.some((c) => c.name === "seq")) {
  db.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER`);
}
db.exec(`
  UPDATE messages SET seq = (
    SELECT rn FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY timestamp ASC, rowid ASC) AS rn FROM messages
    ) ordered WHERE ordered.id = messages.id
  ) WHERE seq IS NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_key, seq);
`);
```

回填按 `timestamp, rowid` 而非单按 `rowid`：历史上的 `OR REPLACE` 已把被更新过的旧消息 rowid 抬到末尾，只按 rowid 会让老消息顺序错乱。

- [ ] **Step 4: MessageStore 分配与读取 seq**

`packages/server/src/storage/messages.ts`。构造函数内初始化计数器并改写语句：

```ts
private nextSeq: number;
```

```ts
this.stmtInsert = db.prepare(
  `INSERT INTO messages (id, chat_key, role, content, timestamp, connection_id, session_key, extra, seq)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     content = excluded.content,
     timestamp = excluded.timestamp,
     extra = excluded.extra`
);
this.stmtSelect = db.prepare(
  `SELECT * FROM messages WHERE chat_key = ? ORDER BY seq ASC`
);
this.stmtSelectSeq = db.prepare(`SELECT seq FROM messages WHERE id = ?`);
const maxSeq = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM messages`).get() as { m: number };
this.nextSeq = maxSeq.m + 1;
```

`save` 中传入新序号并返回该行最终的 `seq`（`seq` 不在 `DO UPDATE` 列表内，冲突时自动保留原值；冲突会消耗一个序号造成跳号，这是允许的）。返回类型从 `void` 改为 `number`：

```ts
save(msg: ChatMessage): number {
  // ...既有的 chatKey / extra 组装逻辑保持不变...
  this.stmtInsert.run(
    msg.id, chatKey, msg.role, msg.content, msg.timestamp,
    msg.connectionId, msg.sessionKey, extra, this.nextSeq++
  );
  return (this.stmtSelectSeq.get(msg.id) as { seq: number }).seq;
}
```

回读一次而不是直接返回 `this.nextSeq - 1`：冲突路径上行保留的是原有 `seq`，只有回读才拿得到正确值。
既有调用方忽略返回值即可，无需改动。

`getByChatKey` 的映射中带出 `seq`（`packages/server/src/storage/messages.ts:79-87` 的对象字面量内，`...extra` 展开之前）：

```ts
seq: r.seq,
```

- [ ] **Step 5: `ChatMessage` 类型加 seq**

`packages/shared/src/types/message.ts` 的 `ChatMessage` 接口加入：

```ts
seq?: number;
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server test`

Expected: 全部 PASS。

- [ ] **Step 7: 类型检查并提交**

```bash
pnpm --filter @cc-pet/server typecheck
git add packages/server/src/storage/db.ts packages/server/src/storage/messages.ts packages/shared/src/types/message.ts packages/server/tests/storage.test.ts
git commit -m "feat(server): add monotonic seq column as history cursor

rowid 会被 REPLACE 改写、timestamp 有同毫秒碰撞，两者都不能当增量拉取
游标。新增显式 seq 列并按 timestamp+rowid 回填历史数据，排序改为按 seq。"
```

---

### Task 3: 增量历史查询

**Files:**
- Modify: `packages/server/src/storage/messages.ts`（新增方法）
- Modify: `packages/server/src/api/history.ts:5-7`
- Test: `packages/server/tests/storage.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `seq` 列与索引
- Produces:
  - `MessageStore.getByChatKeyAfterSeq(chatKey: string, afterSeq: number, limit: number): { messages: ChatMessage[]; hasMore: boolean }`
  - `GET /api/history/:chatKey?afterSeq=<n>&limit=<n>` → `{ messages, hasMore }`；不传 `afterSeq` 时返回 `{ messages }` 全量

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/storage.test.ts -t "incremental history"`

Expected: FAIL —— `getByChatKeyAfterSeq is not a function`。

- [ ] **Step 3: 实现增量查询**

`packages/server/src/storage/messages.ts` 构造函数内加语句：

```ts
this.stmtSelectAfterSeq = db.prepare(
  `SELECT * FROM messages WHERE chat_key = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
);
```

把 `getByChatKey` 里的行→对象映射抽成私有方法 `private toChatMessage(r: any): ChatMessage`，两个查询共用，避免重复。然后：

```ts
getByChatKeyAfterSeq(
  chatKey: string,
  afterSeq: number,
  limit: number
): { messages: ChatMessage[]; hasMore: boolean } {
  const rows = this.stmtSelectAfterSeq.all(chatKey, afterSeq, limit + 1) as any[];
  const hasMore = rows.length > limit;
  return {
    messages: rows.slice(0, limit).map((r) => this.toChatMessage(r)),
    hasMore,
  };
}
```

多取一条用于判断 `hasMore`，避免额外的 COUNT 查询。

- [ ] **Step 4: 接口暴露参数**

`packages/server/src/api/history.ts` 的 GET 路由改为：

```ts
app.get<{
  Params: { chatKey: string };
  Querystring: { afterSeq?: string; limit?: string };
}>("/api/history/:chatKey", async (req) => {
  const chatKey = decodeURIComponent(req.params.chatKey);
  if (req.query.afterSeq === undefined) {
    return { messages: store.getByChatKey(chatKey) };
  }
  const afterSeq = Number(req.query.afterSeq);
  const limit = Number(req.query.limit ?? 200);
  if (!Number.isFinite(afterSeq) || !Number.isFinite(limit) || limit <= 0) {
    return { messages: store.getByChatKey(chatKey) };
  }
  return store.getByChatKeyAfterSeq(chatKey, afterSeq, Math.min(limit, 500));
});
```

`limit` 仅在传了 `afterSeq` 时生效，因此启动（`hydrateFromServer.ts:98`）与切换会话（`ChatWindow.tsx:109`）的现有全量行为完全不变。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/server test`

Expected: 全部 PASS。

- [ ] **Step 6: 类型检查并提交**

```bash
pnpm --filter @cc-pet/server typecheck
git add packages/server/src/storage/messages.ts packages/server/src/api/history.ts packages/server/tests/storage.test.ts
git commit -m "feat(server): support incremental history fetch via afterSeq cursor"
```

---

### Task 4: 消息 id 与 seq 的上下行协议

**Files:**
- Modify: `packages/shared/src/constants/events.ts`
- Modify: `packages/server/src/index.ts:269-278,308-317,334-345,365-375,376-385,415-439,450-498`
- Test: `packages/server/tests/message-ack.test.ts`

**Interfaces:**
- Consumes: Task 1 的 randomUUID id、Task 2 的 `save(): number`
- Produces:
  - `WS_EVENTS.MESSAGE_ACK = "message-ack"`
  - 上行 `SEND_MESSAGE` / `SEND_FILE` 载荷新增可选字段 `clientMsgId: string`
  - 服务端 save 后广播 `MESSAGE_ACK`，payload `{ connectionId, sessionKey, clientMsgId, id, seq }`
  - 下行 `BRIDGE_MESSAGE` / `BRIDGE_STREAM_DONE` / `BRIDGE_FILE_RECEIVED` / `BRIDGE_CARD` / `BRIDGE_AUDIO` 的 payload 新增 `msgId: string` 与 `seq: number`

- [ ] **Step 1: 新增事件常量**

`packages/shared/src/constants/events.ts` 的 `WS_EVENTS` 对象内加入：

```ts
MESSAGE_ACK: "message-ack",
```

- [ ] **Step 2: 写失败测试**

新建 `packages/server/tests/message-ack.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { MessageStore } from "../src/storage/messages.js";

describe("upstream message id adoption", () => {
  let db: Database.Database;
  let messages: MessageStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    messages = new MessageStore(db);
  });
  afterEach(() => db.close());

  it("is idempotent when the client resends the same clientMsgId", () => {
    const clientMsgId = "client-uuid-1";
    for (let i = 0; i < 3; i++) {
      messages.save({
        id: clientMsgId, role: "user", content: "hello",
        timestamp: 1000, connectionId: "c", sessionKey: "s",
      });
    }
    const rows = messages.getByChatKey("c::s");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(clientMsgId);
  });

  it("exposes seq so the server can ack with it", () => {
    messages.save({
      id: "client-uuid-2", role: "user", content: "hi",
      timestamp: 1000, connectionId: "c", sessionKey: "s",
    });
    expect(messages.getByChatKey("c::s")[0].seq).toBeTypeOf("number");
  });
});
```

- [ ] **Step 3: 运行测试确认状态**

Run: `pnpm --filter @cc-pet/server exec vitest run tests/message-ack.test.ts`

Expected: PASS（依赖 Task 1-2 已完成）。这两条用例锁定重发幂等这一不变量，防止后续回归。

- [ ] **Step 4: 服务端采用客户端 id 并回 ack**

`packages/server/src/index.ts` 的 `SEND_MESSAGE` 分支（`:415`），把 msgId 来源改为优先客户端：

```ts
case WS_EVENTS.SEND_MESSAGE: {
  const msgId = clientMsgId ?? `msg-${randomUUID()}`;
```

`clientMsgId` 需与 `content`、`connectionId`、`sessionKey` 一起从入站消息中解构（解构位置见该 handler 顶部现有的字段解包处）。

`clientMsgId` 需加入 `hub.onMessage` 顶部的解构（`index.ts:406` 那一行的字段列表）。

`messageStore.save(...)` 之后、`bridgeManager.send(...)` 之前插入 ack：

```ts
const seq = messageStore.save({
  id: msgId, role: "user", content,
  timestamp: Date.now(), connectionId, sessionKey,
});
if (clientMsgId) {
  hub.broadcast(WS_EVENTS.MESSAGE_ACK, {
    connectionId, sessionKey, clientMsgId, id: msgId, seq,
  });
}
```

seq 直接取 `save` 的返回值（Task 2），不要回头 `getByChatKey(...).find(...)` —— 那是一次全会话扫描，每条消息都做代价随会话长度线性增长。

payload 带上 `connectionId`：`hub.broadcast` 会按它过滤订阅了该 bridge 的客户端（`ws/hub.ts:86-88`），省略会广播给所有连接。

`SEND_FILE` 分支（`:450`）同样处理：`id` 取 `clientMsgId ?? \`msg-${randomUUID()}\``，save 后广播同结构的 ack。

- [ ] **Step 5: 下行推送携带 msgId 与 seq**

这一步是 Task 7 按 id 去重的前提。客户端目前给每条下行消息现编一个本地 id
（`App.tsx:248,300,322,364,389` 的 `` `msg-${Date.now()}` ``），与服务端入库的 id 毫无关系。
若不改，重连补齐拉回的同一条 assistant 消息会因 id 不同被当成新消息，界面上出现重复。

`packages/server/src/index.ts` 中 5 处「save 后紧跟 broadcast」的下行分支，把 save 的返回值和 id 一起带进 payload：

```ts
// case "reply"（:269-278）
const replyMsgId = `msg-${randomUUID()}`;
const replySeq = messageStore.save({
  id: replyMsgId, role: "assistant", content: replyContent,
  timestamp: Date.now(), connectionId: connId, sessionKey,
});
hub.broadcast(WS_EVENTS.BRIDGE_MESSAGE, {
  connectionId: connId,
  sessionKey,
  content: replyContent,
  replyCtx: replyCtx || undefined,
  msgId: replyMsgId,
  seq: replySeq,
});
```

同样处理其余四处，各自 broadcast 加 `msgId` / `seq` 两个字段：

| 分支 | save 位置 | broadcast 事件 |
|---|---|---|
| `reply_stream` done | `index.ts:311` | `BRIDGE_STREAM_DONE`（`:316`） |
| `file` | `index.ts:335` | `BRIDGE_FILE_RECEIVED`（`:344`） |
| `card` | `index.ts:366` | `BRIDGE_CARD`（`:372`） |
| `audio` | `index.ts:377` | `BRIDGE_AUDIO`（`:382`） |

`reply_stream` 的 save 在 `if (fullText)` 内，broadcast 在外面。把 id 与 seq 提到 `if` 之前声明：

```ts
let doneMsgId: string | undefined;
let doneSeq: number | undefined;
if (fullText) {
  doneMsgId = `msg-${randomUUID()}`;
  doneSeq = messageStore.save({
    id: doneMsgId, role: "assistant", content: fullText,
    timestamp: Date.now(), connectionId: connId, sessionKey,
  });
}
hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DONE, {
  connectionId: connId, sessionKey, fullText, msgId: doneMsgId, seq: doneSeq,
});
```

`BRIDGE_BUTTONS`（`index.ts:326`）服务端本就不入库，保持不动 —— 它没有 `seq`，Task 7 的合并逻辑必须容忍这种纯本地消息。

- [ ] **Step 6: 运行全部服务端测试**

Run: `pnpm --filter @cc-pet/server test`

Expected: 全部 PASS。

- [ ] **Step 7: 类型检查并提交**

```bash
pnpm --filter @cc-pet/server typecheck
git add packages/shared/src/constants/events.ts packages/server/src/index.ts packages/server/tests/message-ack.test.ts
git commit -m "feat(server): propagate message id and seq in both directions

上行采用客户端生成的 id 使重发天然幂等并回 ack；下行推送带上入库的
msgId 与 seq，让客户端不再自己编 id，重连补齐才能按 id 去重。"
```

---

### Task 5: 客户端 outbox store

**Files:**
- Create: `packages/web/src/lib/store/outbox.ts`
- Create: `packages/web/src/lib/store/outbox.test.ts`

**Interfaces:**
- Consumes: Task 4 的 ack payload 结构
- Produces:
  - `export type RetryPolicy = "auto" | "manual" | "never"`
  - `export type OutboxStatus = "pending" | "sent" | "failed"`
  - `export interface OutboxEntry { clientMsgId: string; payload: Record<string, unknown>; policy: RetryPolicy; status: OutboxStatus; createdAt: number; payloadDropped?: boolean }`
  - `useOutboxStore` 暴露 `enqueue(payload, policy): string`、`markSent(clientMsgId)`、`resend(clientMsgId)`、`takeSendable(now?): OutboxEntry[]`、`expireStale(now?)`
  - 常量 `MANUAL_WINDOW_MS = 120_000`、`ACK_TIMEOUT_MS = 15_000`、`PERSIST_MAX_BYTES = 262_144`、`OUTBOX_STORAGE_KEY = "cc-pet-outbox"`

- [ ] **Step 1: 写失败测试**

新建 `packages/web/src/lib/store/outbox.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  useOutboxStore, MANUAL_WINDOW_MS, ACK_TIMEOUT_MS, OUTBOX_STORAGE_KEY,
} from "./outbox";

describe("outbox store", () => {
  beforeEach(() => {
    localStorage.clear();
    useOutboxStore.setState({ entries: [] });
  });

  it("enqueues a pending entry and returns its clientMsgId", () => {
    const id = useOutboxStore.getState().enqueue({ type: "send-message", content: "hi" }, "auto");
    const [entry] = useOutboxStore.getState().entries;
    expect(entry.clientMsgId).toBe(id);
    expect(entry.status).toBe("pending");
  });

  it("never enqueues a never-policy payload", () => {
    const id = useOutboxStore.getState().enqueue({ type: "send-message", content: "/stop" }, "never");
    expect(id).toBe("");
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });

  it("marks an entry sent on ack", () => {
    const id = useOutboxStore.getState().enqueue({ content: "hi" }, "auto");
    useOutboxStore.getState().markSent(id);
    expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)).toBeUndefined();
  });

  it("expires a pending auto entry past the ack timeout into failed", () => {
    const id = useOutboxStore.getState().enqueue({ content: "hi" }, "auto");
    useOutboxStore.getState().expireStale(Date.now() + ACK_TIMEOUT_MS + 1);
    const entry = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
    expect(entry.status).toBe("failed");
  });

  it("does not resend a manual entry past its context window", () => {
    const id = useOutboxStore.getState().enqueue({ content: "answer" }, "manual");
    const sendable = useOutboxStore.getState().takeSendable(Date.now() + MANUAL_WINDOW_MS + 1);
    expect(sendable.map((e) => e.clientMsgId)).not.toContain(id);
    expect(useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!.status).toBe("failed");
  });

  it("still resends an auto entry past the manual window", () => {
    const id = useOutboxStore.getState().enqueue({ content: "hi" }, "auto");
    const sendable = useOutboxStore.getState().takeSendable(Date.now() + MANUAL_WINDOW_MS + 1);
    expect(sendable.map((e) => e.clientMsgId)).toContain(id);
  });

  it("keeps oversized payloads in memory but persists only a dropped placeholder", () => {
    const big = "x".repeat(300_000);
    const id = useOutboxStore.getState().enqueue({ files: big }, "auto");
    const live = useOutboxStore.getState().entries.find((e) => e.clientMsgId === id)!;
    expect(live.payload.files).toBe(big);
    expect(live.status).toBe("pending");

    const persisted = JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY) ?? "[]");
    const placeholder = persisted.find((e: any) => e.clientMsgId === id);
    expect(placeholder).toBeDefined();
    expect(placeholder.status).toBe("failed");
    expect(placeholder.payloadDropped).toBe(true);
    expect(placeholder.payload).toEqual({});
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/web test -- src/lib/store/outbox.test.ts`

Expected: FAIL —— 模块 `./outbox` 不存在。

- [ ] **Step 3: 实现 outbox store**

新建 `packages/web/src/lib/store/outbox.ts`：

```ts
import { create } from "zustand";

export type RetryPolicy = "auto" | "manual" | "never";
export type OutboxStatus = "pending" | "sent" | "failed";

export interface OutboxEntry {
  clientMsgId: string;
  payload: Record<string, unknown>;
  policy: RetryPolicy;
  status: OutboxStatus;
  createdAt: number;
  /** 载荷因过大未被持久化，重载后无法续发，只用于告知用户 */
  payloadDropped?: boolean;
}

export const MANUAL_WINDOW_MS = 120_000;
export const ACK_TIMEOUT_MS = 15_000;
export const PERSIST_MAX_BYTES = 262_144;
export const OUTBOX_STORAGE_KEY = "cc-pet-outbox";

interface OutboxState {
  entries: OutboxEntry[];
  enqueue: (payload: Record<string, unknown>, policy: RetryPolicy) => string;
  markSent: (clientMsgId: string) => void;
  resend: (clientMsgId: string) => void;
  takeSendable: (now?: number) => OutboxEntry[];
  expireStale: (now?: number) => void;
}

function loadPersisted(): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e: OutboxEntry) =>
      // 载荷已丢弃的条目无法续发，保持 failed 让 UI 告知用户重新选择文件
      e.payloadDropped ? e : { ...e, status: "pending" as OutboxStatus }
    );
  } catch {
    return [];
  }
}

function persist(entries: OutboxEntry[]): void {
  const persistable = entries.map((e) =>
    JSON.stringify(e.payload).length > PERSIST_MAX_BYTES
      ? { ...e, payload: {}, status: "failed" as OutboxStatus, payloadDropped: true }
      : e
  );
  try {
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(persistable));
  } catch {
    // 配额不足时放弃持久化，内存队列仍然可用
  }
}

export const useOutboxStore = create<OutboxState>((set, get) => ({
  entries: loadPersisted(),

  enqueue: (payload, policy) => {
    if (policy === "never") return "";
    const clientMsgId = crypto.randomUUID();
    const entry: OutboxEntry = {
      clientMsgId, payload, policy,
      status: "pending", createdAt: Date.now(),
    };
    const entries = [...get().entries, entry];
    set({ entries });
    persist(entries);
    return clientMsgId;
  },

  markSent: (clientMsgId) => {
    const entries = get().entries.filter((e) => e.clientMsgId !== clientMsgId);
    set({ entries });
    persist(entries);
  },

  resend: (clientMsgId) => {
    const entries = get().entries.map((e) =>
      // 载荷已丢弃的条目无法续发，重试对它无意义
      e.clientMsgId === clientMsgId && !e.payloadDropped
        ? { ...e, status: "pending" as OutboxStatus, createdAt: Date.now() }
        : e
    );
    set({ entries });
    persist(entries);
  },

  takeSendable: (now = Date.now()) => {
    const entries = get().entries.map((e) => {
      if (e.policy === "manual" && e.status === "pending" && now - e.createdAt > MANUAL_WINDOW_MS) {
        return { ...e, status: "failed" as OutboxStatus };
      }
      return e;
    });
    set({ entries });
    persist(entries);
    return entries.filter((e) => e.status === "pending");
  },

  expireStale: (now = Date.now()) => {
    const entries = get().entries.map((e) =>
      e.status === "pending" && now - e.createdAt > ACK_TIMEOUT_MS
        ? { ...e, status: "failed" as OutboxStatus }
        : e
    );
    set({ entries });
    persist(entries);
  },
}));
```

`markSent` 直接移除条目而非留下 `sent` 状态：已确认的消息由服务端历史接管，留在队列里只会占配额。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/web test -- src/lib/store/outbox.test.ts`

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/store/outbox.ts packages/web/src/lib/store/outbox.test.ts
git commit -m "feat(web): add outbox store with tiered retry policies

/stop 这类控制指令标记为 never 不入队，卡片回复为 manual 且超出 2 分钟
上下文窗口不自动重放，只有普通文本与文件是 auto。"
```

---

### Task 6: 队列化发送与策略声明

**Files:**
- Modify: `packages/web/src/lib/platform.ts:5`
- Modify: `packages/web/src/lib/web-adapter.ts:215-224`
- Modify: `packages/web/src/components/ChatWindow.tsx:179,201,282`
- Modify: `packages/web/src/components/AskQuestionCard.tsx:66`
- Modify: `packages/web/src/components/CardMessage.tsx:30`

**Interfaces:**
- Consumes: Task 5 的 `useOutboxStore`、`RetryPolicy`
- Produces:
  - `sendWsMessage(msg: any, policy: RetryPolicy): string` —— policy 为**必填**参数，返回入队得到的 `clientMsgId`（`never` 策略返回 `""`）
  - `flushOutbox(): void` —— 加入 `PlatformAPI`，把队列中可发送的条目按原 `clientMsgId` 重发；Task 7 的重连补齐与 Task 8 的重试按钮共用

- [ ] **Step 1: 修改接口签名**

`packages/web/src/lib/platform.ts` 第 5 行改为：

```ts
sendWsMessage(msg: any, policy: RetryPolicy): string;
```

并在文件顶部 `import type { RetryPolicy } from "./store/outbox";`。

policy 设为必填而非带默认值：新增发送点时必须显式想清楚策略，避免无声继承错误行为。

返回 `clientMsgId` 是必要的 —— `ChatWindow.tsx:163` 与 `:192` 会在发送前把消息乐观插入 message store，目前用的 id 是 `file-${Date.now()}` / `msg-${Date.now()}`。这个 id 必须与 outbox 的 `clientMsgId` 一致，否则 Task 8 无法按 id 查到发送状态；顺带这也消除了客户端侧同毫秒 id 碰撞的隐患。

- [ ] **Step 2: 运行类型检查确认失败**

Run: `pnpm --filter @cc-pet/web exec tsc -p tsconfig.build.json --noEmit`

Expected: FAIL —— 5 个调用点缺少第二个参数。这份错误列表正是本 task 需要逐一处理的清单。

- [ ] **Step 3: 改写 web-adapter 的发送实现**

`packages/web/src/lib/web-adapter.ts` 的 `sendWsMessage` 替换为：

```ts
sendWsMessage(msg, policy) {
  if (policy === "never") {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      console.warn("[cc-pet] control message dropped: socket not open", { msgType: msg?.type });
    }
    return "";
  }

  const clientMsgId = useOutboxStore.getState().enqueue(msg, policy);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...msg, clientMsgId }));
  }
  return clientMsgId;
},
```

`never` 策略不入队，socket 未开即放弃并记 warn（`/stop` 过期重放会掐掉一次全新的生成）。其余策略先入队，socket 未开时留在队列中等重连 flush。

在文件顶部加 `import { useOutboxStore } from "./store/outbox";`。

- [ ] **Step 4: 处理 ack、超时与重连 flush**

在 `web-adapter.ts` 的 `socket.onmessage`（`:164-173`）内，`applyIncomingWsSessionRouting` 之前识别 `MESSAGE_ACK` 并结单：

```ts
const msg = JSON.parse(e.data) as { type: string; clientMsgId?: string };
if (msg.type === WS_EVENTS.MESSAGE_ACK) {
  if (msg.clientMsgId) useOutboxStore.getState().markSent(msg.clientMsgId);
  return;
}
```

注意 WS 载荷是**扁平**的 —— `hub.broadcast` 发的是 `{ type, ...payload }`（`ws/hub.ts:85`），
客户端也是把整个对象当 payload 传给 handler（`web-adapter.ts:169`）。没有 `msg.payload` 这一层。

ack 只结单，**不得**用其 `seq` 推进 Task 7 的下行水位（断线期间产生的中间 seq 会被跳过，那些消息将永远拉不回来）。

在 adapter 内定义 flush 函数，并加入 platform 接口（`packages/web/src/lib/platform.ts` 增加 `flushOutbox(): void`），供重连与 UI 重试共用：

```ts
function flushOutbox(): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  for (const entry of useOutboxStore.getState().takeSendable()) {
    ws.send(JSON.stringify({ ...entry.payload, clientMsgId: entry.clientMsgId }));
  }
}
```

`socket.onopen` 内（`web-adapter.ts:158`，`reconnectAttempt = 0` 之后）调用 `flushOutbox()`。

并启动一个 `setInterval(() => useOutboxStore.getState().expireStale(), 5_000)`，在 adapter 销毁时 `clearInterval`。

- [ ] **Step 5: 逐个调用点声明策略**

按下表补第二个参数：

| 文件:行 | 内容 | 参数 |
|---|---|---|
| `ChatWindow.tsx:179` | `SEND_FILE` | `"auto"` |
| `ChatWindow.tsx:201` | `SEND_MESSAGE` 普通文本 | `"auto"` |
| `ChatWindow.tsx:282` | `SEND_MESSAGE` 内容 `/stop` | `"never"` |
| `AskQuestionCard.tsx:66` | 回答 Claude 提问 | `"manual"` |
| `CardMessage.tsx:30` | 卡片交互回复 | `"manual"` |

- [ ] **Step 6: 乐观渲染改用 clientMsgId**

`ChatWindow.tsx` 的两处乐观插入目前排在 `sendWsMessage` 之前、且自己拼毫秒 id。
调整为先发送拿到 id，再用同一个 id 插入 message store。

文本消息（原 `ChatWindow.tsx:191-206`）：

```ts
const clientMsgId = getPlatform().sendWsMessage({
  type: WS_EVENTS.SEND_MESSAGE,
  connectionId: activeConnectionId,
  sessionKey: activeSessionKey,
  content: text,
}, "auto");

useMessageStore.getState().addMessage(chatKey, {
  id: clientMsgId,
  role: "user",
  content: text,
  timestamp: Date.now(),
  connectionId: activeConnectionId,
  sessionKey: activeSessionKey,
});
useSessionStore.getState().touchSessionAutoTitle(activeConnectionId, activeSessionKey, text);
```

文件消息（原 `ChatWindow.tsx:162-185`）同样调整：先调 `sendWsMessage({ type: WS_EVENTS.SEND_FILE, ... }, "auto")` 取回 `clientMsgId`，再以它作为 `addMessage` 的 `id`，其余字段（`files` 的展示用元数据、`content`、`timestamp`）保持不变。

这样服务端 upsert 用的 id、outbox 的 `clientMsgId`、UI 里这条消息的 `id` 三者统一，Task 7 的按 id 去重与 Task 8 的状态查询才成立。

- [ ] **Step 7: 类型检查与测试**

Run: `pnpm --filter @cc-pet/web exec tsc -p tsconfig.build.json --noEmit && pnpm --filter @cc-pet/web test`

Expected: 类型检查无错误；既有测试全部 PASS。`App.integration.test.tsx` 中若有对 `sendWsMessage` 的 mock 或断言，需同步补上 policy 参数并让 mock 返回一个字符串 id（否则乐观渲染会拿到 `undefined` 作为消息 id）。

- [ ] **Step 8: 提交**

```bash
git add packages/web/src/lib/platform.ts packages/web/src/lib/web-adapter.ts packages/web/src/components/ChatWindow.tsx packages/web/src/components/AskQuestionCard.tsx packages/web/src/components/CardMessage.tsx
git commit -m "fix(web): queue outgoing messages instead of dropping them silently

socket 未就绪时原先只打一行 console 就丢弃消息，UI 无任何提示。改为入队
并在重连时按策略 flush。"
```

---

### Task 7: 下行水位与重连补齐

**Files:**
- Modify: `packages/web/src/lib/store/message.ts`
- Modify: `packages/web/src/App.tsx:247,299,321,363,388`（下行消息改用服务端 id 与 seq）
- Modify: `packages/web/src/lib/web-adapter.ts`（onopen 补齐钩子）
- Test: `packages/web/src/lib/store/message.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `afterSeq` 接口、Task 2 的 `ChatMessage.seq`、Task 4 下行 payload 的 `msgId` / `seq`
- Produces: `useMessageStore` 增加 `watermarks: Record<string, number>`、`setWatermark(chatKey, seq)`、`getWatermark(chatKey): number`、`mergeMessages(chatKey, incoming: ChatMessage[])`

**注意状态字段名是 `messagesByChat`，不是 `messages`**（`packages/web/src/lib/store/message.ts:5`）。

- [ ] **Step 1: 写失败测试**

新建 `packages/web/src/lib/store/message.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useMessageStore } from "./message";
import type { ChatMessage } from "@cc-pet/shared";

const msg = (id: string, seq: number): ChatMessage => ({
  id, seq, role: "assistant", content: id, timestamp: 1000 + seq,
});

describe("message store watermark and merge", () => {
  beforeEach(() => {
    useMessageStore.setState({ watermarks: {}, messagesByChat: {} });
  });

  it("tracks the highest seq seen per chatKey", () => {
    useMessageStore.getState().mergeMessages("c::s", [msg("a", 3), msg("b", 7)]);
    expect(useMessageStore.getState().getWatermark("c::s")).toBe(7);
  });

  it("never moves the watermark backwards", () => {
    useMessageStore.getState().setWatermark("c::s", 10);
    useMessageStore.getState().setWatermark("c::s", 4);
    expect(useMessageStore.getState().getWatermark("c::s")).toBe(10);
  });

  it("dedupes by id when a locally rendered message comes back from history", () => {
    const store = useMessageStore.getState();
    store.mergeMessages("c::s", [msg("client-uuid", 5)]);
    store.mergeMessages("c::s", [msg("client-uuid", 5)]);
    const list = useMessageStore.getState().messagesByChat["c::s"] ?? [];
    expect(list.filter((m) => m.id === "client-uuid")).toHaveLength(1);
  });

  it("orders merged messages chronologically", () => {
    useMessageStore.getState().mergeMessages("c::s", [msg("late", 9), msg("early", 2)]);
    const list = useMessageStore.getState().messagesByChat["c::s"] ?? [];
    expect(list.map((m) => m.id)).toEqual(["early", "late"]);
  });

  it("keeps seq-less local messages in chronological position", () => {
    useMessageStore.getState().mergeMessages("c::s", [
      { id: "srv-1", seq: 1, role: "assistant", content: "a", timestamp: 1000 },
      { id: "local-buttons", role: "assistant", content: "b", timestamp: 1500 },
      { id: "srv-2", seq: 2, role: "assistant", content: "c", timestamp: 2000 },
    ]);
    const list = useMessageStore.getState().messagesByChat["c::s"] ?? [];
    expect(list.map((m) => m.id)).toEqual(["srv-1", "local-buttons", "srv-2"]);
  });

  it("breaks same-timestamp ties by seq", () => {
    useMessageStore.getState().mergeMessages("c::s", [
      { id: "b", seq: 9, role: "assistant", content: "b", timestamp: 7000 },
      { id: "a", seq: 4, role: "assistant", content: "a", timestamp: 7000 },
    ]);
    const list = useMessageStore.getState().messagesByChat["c::s"] ?? [];
    expect(list.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("starts from watermark 0 for an unknown chatKey", () => {
    expect(useMessageStore.getState().getWatermark("never::seen")).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/web test -- src/lib/store/message.test.ts`

Expected: FAIL —— `mergeMessages` / `getWatermark` 未定义。

- [ ] **Step 3: 实现水位与合并**

在 `packages/web/src/lib/store/message.ts` 的 state 接口与实现中加入：

```ts
watermarks: Record<string, number>;
setWatermark: (chatKey: string, seq: number) => void;
getWatermark: (chatKey: string) => number;
mergeMessages: (chatKey: string, incoming: ChatMessage[]) => void;
```

```ts
watermarks: {},

setWatermark: (chatKey, seq) =>
  set((s) => ({
    watermarks: { ...s.watermarks, [chatKey]: Math.max(s.watermarks[chatKey] ?? 0, seq) },
  })),

getWatermark: (chatKey) => get().watermarks[chatKey] ?? 0,

mergeMessages: (chatKey, incoming) => {
  const existing = get().messagesByChat[chatKey] ?? [];
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  const merged = [...byId.values()].sort(
    (a, b) => a.timestamp - b.timestamp || (a.seq ?? 0) - (b.seq ?? 0)
  );
  const maxSeq = merged.reduce((acc, m) => Math.max(acc, m.seq ?? 0), 0);
  set((s) => ({
    messagesByChat: { ...s.messagesByChat, [chatKey]: merged },
    watermarks: { ...s.watermarks, [chatKey]: Math.max(s.watermarks[chatKey] ?? 0, maxSeq) },
  }));
},
```

按 id 去重使本地乐观渲染的条目与补齐拉回的同一条消息自动合并 —— 上行消息入库用的就是客户端生成的
`clientMsgId`，下行消息（Task 4 Step 5 之后）用的是服务端下发的 `msgId`，两侧 id 都相同。

排序用 `timestamp` 主键、`seq` 次键，而非 spec 里写的「按 seq 排序」：`BRIDGE_BUTTONS`
这类纯本地消息没有 `seq`，单按 seq 会把它们全部塌到序列最前。timestamp 保证时序正确，
seq 负责打破同毫秒的平手 —— spec 反对的是把 timestamp 当**游标**（同毫秒会漏消息），
用于展示排序并无此问题。

- [ ] **Step 4: 下行消息改用服务端 id 与 seq**

`packages/web/src/App.tsx` 的 5 个下行分支目前自己拼 `` `msg-${Date.now()}` ``，必须改用 Task 4 下发的字段，
否则重连补齐会把同一条 assistant 消息重复渲染一次。

- `:247` `BRIDGE_MESSAGE`、`:299` `BRIDGE_BUTTONS`、`:321` `BRIDGE_FILE_RECEIVED`、`:363` `BRIDGE_CARD`、`:388` `BRIDGE_AUDIO`

除 `BRIDGE_BUTTONS` 外的四处都改成：

```ts
useMessageStore.getState().addMessage(chatKey, {
  id: payload.msgId ?? `msg-${crypto.randomUUID()}`,
  seq: payload.seq,
  // ...其余字段保持不变
});
```

`BRIDGE_BUTTONS`（`:299`）服务端不入库、payload 没有 `msgId`，只把 id 从 `Date.now()`
换成 `crypto.randomUUID()` 消除客户端同毫秒碰撞，不加 `seq`。

`BRIDGE_STREAM_DONE`（`:283`）走的是 `finalizeStream`，它在 store 内部拼 id
（`message.ts:62`）。给它加两个可选参数并透传：

```ts
finalizeStream: (chatKey: string, fullText: string, msgId?: string, seq?: number) => void;
```

```ts
{ id: msgId ?? `msg-${crypto.randomUUID()}`, seq, role: "assistant" as const, content: fullText, timestamp: Date.now() },
```

调用处改为 `finalizeStream(chatKey, payload.fullText, payload.msgId, payload.seq)`。

`deletePreview`（`message.ts:116`）的 `` `preview-${previewId}-${Date.now()}` `` 是纯本地消息，
服务端不入库，保持原样。

- [ ] **Step 5: 重连时补齐**

在 `packages/web/src/lib/web-adapter.ts` 的 `socket.onopen` 内，Task 6 的 flush 之后加入补齐逻辑：

```ts
void (async () => {
  const chatKey = getActiveChatKey();
  if (!chatKey) return;
  for (;;) {
    const after = useMessageStore.getState().getWatermark(chatKey);
    const res = await api.fetchApi<{ messages: ChatMessage[]; hasMore: boolean }>(
      `/api/history/${encodeURIComponent(chatKey)}?afterSeq=${after}&limit=200`
    );
    if (res.messages.length === 0) break;
    useMessageStore.getState().mergeMessages(chatKey, res.messages);
    if (!res.hasMore) break;
  }
})();
```

`getActiveChatKey()` 从 `useConnectionStore` 与 `useSessionStore` 的当前选中值拼出，与 `ChatWindow.tsx:109` 构造 chatKey 的方式保持一致。只补当前活跃会话；其他会话在切换过去时经既有路径拉取。

循环以 `messages.length === 0` 兜底退出，避免服务端 `hasMore` 异常时死循环。

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @cc-pet/web exec tsc -p tsconfig.build.json --noEmit && pnpm --filter @cc-pet/web test`

Expected: 类型检查无错误；全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/web/src/lib/store/message.ts packages/web/src/lib/store/message.test.ts packages/web/src/App.tsx packages/web/src/lib/web-adapter.ts
git commit -m "feat(web): backfill missed messages after websocket reconnect

重连后按 seq 水位增量拉取断线期间的消息，按 id 去重合并。"
```

---

### Task 8: 发送状态的 UI 呈现

**Files:**
- Modify: `packages/web/src/components/MessageList.tsx`
- Modify: `packages/web/src/lib/store/outbox.ts`（导出查询辅助）

**Interfaces:**
- Consumes: Task 5 的 `useOutboxStore`、`OutboxEntry`、`resend`；Task 6 的 `flushOutbox`
- Produces: 消息气泡根据 outbox 状态呈现 `pending` / `failed` 样式与重试入口

- [ ] **Step 1: 在 outbox 暴露按 id 查条目的辅助**

`packages/web/src/lib/store/outbox.ts` 末尾追加：

```ts
export function useOutboxEntry(clientMsgId: string): OutboxEntry | undefined {
  return useOutboxStore((s) => s.entries.find((e) => e.clientMsgId === clientMsgId));
}
```

- [ ] **Step 2: 气泡呈现状态**

在 `packages/web/src/components/MessageList.tsx` 渲染单条消息的组件内取状态：

```tsx
const outboxEntry = useOutboxEntry(message.id);
const outboxStatus = outboxEntry?.status;
```

`pending` 时容器加 `opacity-60` 并在时间戳旁渲染一个时钟图标；`failed` 时加 `border-red-500` 并渲染重试按钮：

```tsx
{outboxStatus === "failed" && (
  outboxEntry?.payloadDropped ? (
    <span className="text-xs text-red-400">发送失败，请重新选择文件</span>
  ) : (
    <button
      className="text-xs text-red-400 underline"
      onClick={() => {
        useOutboxStore.getState().resend(message.id);
        getPlatform().flushOutbox();
      }}
    >
      重新发送
    </button>
  )
)}
```

重试复用**原有的** `clientMsgId` 而不是重新入队：服务端按 id upsert，因此即使旧的那次其实已经入库，重发也不会产生第二条消息。若换成新 id 重新入队，就会既产生重复消息、又让 UI 里这条消息的 id 与新队列条目对不上。

载荷已被丢弃的条目（超过 `PERSIST_MAX_BYTES` 的文件、页面重载后）无法续发，只显示提示文案，不给重试按钮。

- [ ] **Step 3: 手动验证**

Run: `pnpm dev`

在浏览器中打开应用，然后：
1. DevTools → Network → 切到 Offline
2. 发送一条普通消息 → 气泡应半透明并显示时钟
3. 恢复 Online → 气泡应转为正常态，且服务端只有一条记录
4. Offline 状态下点停止按钮 → 不应入队，恢复后不得发出 `/stop`

- [ ] **Step 4: 运行全部测试与构建**

Run: `pnpm test && pnpm build`

Expected: 全部 PASS，构建成功。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/store/outbox.ts packages/web/src/components/MessageList.tsx
git commit -m "feat(web): surface pending and failed send states in message list"
```

---

## 验收

全部 task 完成后，逐条核对 spec 的「测试要点」：

- [ ] 同毫秒写入两条消息都能查到（Task 1）
- [ ] 同 id 重复 save 内容更新、`seq` 不变、无重复行（Task 1 + 2）
- [ ] socket 关闭时发普通消息渲染 `pending`，重连后送达且服务端仅一条（Task 6 + 8）
- [ ] socket 关闭时点停止不入队，重连后不发出 `/stop`（Task 6）
- [ ] 卡片回复超过 2 分钟窗口转 `failed` 且不自动重放（Task 5）
- [ ] 断线期间的 assistant 消息重连后自动出现且顺序正确（Task 7）
- [ ] 已经在界面上的 assistant 消息不因补齐而重复渲染（Task 4 Step 5 + Task 7 Step 4）
- [ ] 没有 `seq` 的纯本地消息（`BRIDGE_BUTTONS`）合并后仍在正确的时间位置（Task 7）
- [ ] 收到 ack 后断线期间的中间消息仍能补齐（Task 6 Step 4 + Task 7）
- [ ] 积压超过 `limit` 时分页循环直至追平（Task 3 + 7）
- [ ] 不传 `afterSeq` 的历史请求仍返回全量，启动与切会话行为不变（Task 3）
- [ ] 迁移后既有消息 `seq` 单调且与原 `timestamp` 顺序一致（Task 2）
