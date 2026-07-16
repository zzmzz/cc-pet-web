# 常驻会话消息裁剪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给常驻会话（`is_resident = 1`）的消息设 500 条上限，由现有每日清理任务自动删除超出的老消息，解决常驻会话打开刷新慢的问题。

**Architecture:** 在 `SessionsCleanup` 类新增 `trimResidentMessages()` 方法，用一条 `DELETE ... WHERE id NOT IN (最新 500 条)` 的 SQL 对每个常驻会话裁剪；接入现有 `startCleanupSchedule` 的每日调度（立即跑一次 + setInterval 两处）。FTS 索引由已有 `messages_fts_ad` 触发器自动同步，无需额外处理。

**Tech Stack:** TypeScript、better-sqlite3、Vitest。

## Global Constraints

- 上限常量 `RESIDENT_MESSAGE_CAP = 500`（非配置项）。
- 仅作用于 `sessions.is_resident = 1` 的会话；普通会话不受影响。
- chat_key 用 `@cc-pet/shared` 的 `makeChatKey(connectionId, sessionKey)` 生成，格式 `${connectionId}::${sessionKey}`。
- 不改数据库 schema、不改 API、不改前端。
- 保留判据：`ORDER BY timestamp DESC, id DESC`（时间戳相同用 id 做确定性 tie-break）。

---

### Task 1: 实现 `trimResidentMessages` 并接入每日调度

**Files:**
- Modify: `packages/server/src/cleanup/sessions-cleanup.ts`
- Test: `packages/server/tests/sessions-cleanup-trim.test.ts` (Create)

**Interfaces:**
- Consumes: `SessionsCleanup` 构造函数已有 `(sessionStore, db)`；`db` 为 `better-sqlite3` 实例。`makeChatKey` 从 `@cc-pet/shared` 导入。
- Produces: `SessionsCleanup.trimResidentMessages(maxMessages?: number): number` —— 返回删除的消息总条数。`startCleanupSchedule` 内部在每次清理后调用它。

- [ ] **Step 1: 写失败测试**

创建 `packages/server/tests/sessions-cleanup-trim.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { makeChatKey } from "@cc-pet/shared";
import { initSchema } from "../src/storage/db.js";
import { SessionStore } from "../src/storage/sessions.js";
import { MessageStore } from "../src/storage/messages.js";
import { SessionsCleanup } from "../src/cleanup/sessions-cleanup.js";

describe("SessionsCleanup.trimResidentMessages", () => {
  let db: Database.Database;
  let sessions: SessionStore;
  let messages: MessageStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    sessions = new SessionStore(db);
    messages = new MessageStore(db);
  });
  afterEach(() => db.close());

  function seed(connectionId: string, sessionKey: string, count: number, baseTs: number) {
    for (let i = 0; i < count; i++) {
      messages.save({
        id: `${connectionId}:${sessionKey}:${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg ${i}`,
        timestamp: baseTs + i, // 递增，i 越大越新
        connectionId,
        sessionKey,
      } as any);
    }
  }

  function msgCount(chatKey: string): number {
    return (db.prepare("SELECT COUNT(*) c FROM messages WHERE chat_key = ?").get(chatKey) as any).c;
  }

  it("trims a resident session down to the newest 500 messages", () => {
    sessions.markResident("bridge", "resident");
    seed("bridge", "resident", 600, 1_000);
    const chatKey = makeChatKey("bridge", "resident");
    expect(msgCount(chatKey)).toBe(600);

    const cleanup = new SessionsCleanup(sessions, db);
    const deleted = cleanup.trimResidentMessages(500);

    expect(deleted).toBe(100);
    expect(msgCount(chatKey)).toBe(500);
    // 最老的 100 条（i=0..99, timestamp 1000..1099）应被删，最新的应保留
    const oldest = db.prepare("SELECT MIN(timestamp) t FROM messages WHERE chat_key = ?").get(chatKey) as any;
    expect(oldest.t).toBe(1_100); // i=100
  });

  it("keeps messages_fts row count in sync via the delete trigger", () => {
    sessions.markResident("bridge", "resident");
    seed("bridge", "resident", 600, 1_000);

    const cleanup = new SessionsCleanup(sessions, db);
    cleanup.trimResidentMessages(500);

    const ftsCount = (db.prepare("SELECT COUNT(*) c FROM messages_fts").get() as any).c;
    expect(ftsCount).toBe(500);
  });

  it("does not touch non-resident sessions", () => {
    sessions.create({ key: "normal", connectionId: "bridge", createdAt: 1_000, lastActiveAt: 1_600 });
    seed("bridge", "normal", 600, 1_000);
    const chatKey = makeChatKey("bridge", "normal");

    const cleanup = new SessionsCleanup(sessions, db);
    const deleted = cleanup.trimResidentMessages(500);

    expect(deleted).toBe(0);
    expect(msgCount(chatKey)).toBe(600);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/server && pnpm vitest run tests/sessions-cleanup-trim.test.ts`
Expected: FAIL —— `cleanup.trimResidentMessages is not a function`。

- [ ] **Step 3: 实现 `trimResidentMessages`**

在 `packages/server/src/cleanup/sessions-cleanup.ts` 顶部加导入：

```typescript
import { makeChatKey } from '@cc-pet/shared';
```

在 class 内 `CLEANUP_INTERVAL_MS` 下方加常量：

```typescript
  private readonly RESIDENT_MESSAGE_CAP = 500;
```

在 `cleanupInactiveSessions` 方法之后新增：

```typescript
  /**
   * 将每个常驻会话的历史消息裁剪到最多 maxMessages 条，删除更早的消息。
   * 普通会话不受影响（它们由 cleanupInactiveSessions 按不活跃天数整删）。
   * @returns 删除的消息总条数
   */
  trimResidentMessages(maxMessages: number = this.RESIDENT_MESSAGE_CAP): number {
    const residents = this.db.prepare(`
      SELECT connection_id, key FROM sessions WHERE is_resident = 1
    `).all() as { connection_id: string; key: string }[];

    const trim = this.db.prepare(`
      DELETE FROM messages
      WHERE chat_key = ?
        AND id NOT IN (
          SELECT id FROM messages WHERE chat_key = ?
          ORDER BY timestamp DESC, id DESC
          LIMIT ?
        )
    `);

    let deletedCount = 0;
    for (const r of residents) {
      const chatKey = makeChatKey(r.connection_id, r.key);
      try {
        const info = trim.run(chatKey, chatKey, maxMessages);
        deletedCount += info.changes;
      } catch (error) {
        console.error(`Failed to trim resident messages for ${chatKey}:`, error);
      }
    }
    return deletedCount;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/server && pnpm vitest run tests/sessions-cleanup-trim.test.ts`
Expected: PASS（3 个用例全过）。

- [ ] **Step 5: 接入每日调度**

在 `startCleanupSchedule` 里，"立即运行一次"的 try 块中，`console.log(...Initial...)` 之前加一行；setInterval 回调的 try 块中，`console.log(...Daily...)` 之前同样加一行。两处都改成：

立即运行块：

```typescript
    try {
      const deletedCount = this.cleanupInactiveSessions(daysThreshold);
      const trimmed = this.trimResidentMessages();
      console.log(`Initial session cleanup completed. Deleted ${deletedCount} inactive sessions, trimmed ${trimmed} resident messages.`);
    } catch (error) {
      console.error('Initial session cleanup failed:', error);
    }
```

setInterval 回调块：

```typescript
    const intervalId = setInterval(() => {
      try {
        const deletedCount = this.cleanupInactiveSessions(daysThreshold);
        const trimmed = this.trimResidentMessages();
        console.log(`Daily session cleanup completed. Deleted ${deletedCount} inactive sessions, trimmed ${trimmed} resident messages.`);
      } catch (error) {
        console.error('Daily session cleanup failed:', error);
      }
    }, this.CLEANUP_INTERVAL_MS);
```

- [ ] **Step 6: 跑整个 server 测试套件确认无回归**

Run: `cd packages/server && pnpm vitest run`
Expected: 全绿，尤其 `sessions-cleanup.test.ts`、`sessions-cleanup-resident.test.ts` 仍通过。

- [ ] **Step 7: 提交**

```bash
git add packages/server/src/cleanup/sessions-cleanup.ts packages/server/tests/sessions-cleanup-trim.test.ts docs/superpowers/
git commit -m "feat(server): 常驻会话消息按 500 条上限自动裁剪"
```

---

## Self-Review

**Spec coverage:**
- 策略=自动裁剪 → Task 1 Step 3 的 `trimResidentMessages` ✅
- 上限 500 常量 → `RESIDENT_MESSAGE_CAP` ✅
- 仅常驻 → SQL `WHERE is_resident = 1` + Task1 第三个用例断言普通会话不动 ✅
- 直接删除不归档 → `DELETE FROM messages` ✅
- FTS 联动 → 依赖已有 `messages_fts_ad` 触发器 + 第二个用例断言 ✅
- 接入每日调度两处 → Step 5 ✅
- 单测三项（600→500、FTS 同步、普通会话不动）→ Task1 三个用例 ✅
- 不改 schema/API/前端 → 计划仅动 cleanup 文件 + 新测试 ✅

**Placeholder scan:** 无 TBD/TODO；所有代码步骤含完整代码。

**Type consistency:** `trimResidentMessages(maxMessages?: number): number` 在定义、调用（Step 5）、测试中签名一致；`makeChatKey` 导入路径与 shared 一致。
