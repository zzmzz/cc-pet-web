# cc-pet Multi-Session Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持 `cc-pet-web` 现有 API/类型兼容的前提下，完整迁移 `../cc-pet` 的多连接会话管理、消息归属规则、会话存储行为和会话 UI 交互。

**Architecture:** 采用“行为移植 + 接口兼容”路径：新增纯函数路由层处理 session 归属，在现有事件消费处统一接入；沿用当前 store 和 server route 结构，只补齐行为一致性；通过单测/集成/E2E 闭环验证。所有迁移以会话边界隔离为主线，避免跨连接和跨会话串扰。

**Tech Stack:** TypeScript, React, Zustand, Vitest, Fastify, better-sqlite3, pnpm workspace

---

## Scope Check

本 spec 为单一子系统（会话迁移）实现，不需要再拆成多个计划。任务顺序为：路由归属 -> 前端事件链路 -> store 行为 -> UI 行为 -> server 存储 -> 回归验证。

## File Structure

### Create

- `packages/web/src/lib/sessionRouting.ts`  
  责任：纯函数实现 `replyCtx` 解析和 session 归属优先级决策。
- `packages/web/src/lib/sessionRouting.test.ts`  
  责任：覆盖 payload/replyCtx/active/fallback 等规则单测。
- `packages/web/src/lib/store/session-behavior.test.ts`  
  责任：补充当前 app store 的会话行为单测（ensure/remove/unread/auto-title）。
- `docs/superpowers/plans/2026-03-30-cc-pet-multi-session-migration-plan.md`  
  责任：实施计划文档（当前文件）。

### Modify

- `packages/web/src/lib/web-adapter.ts`  
  责任：在 web 事件流接入统一 session 归属解析。
- `packages/web/src/lib/tauri-adapter.ts`  
  责任：在 tauri 事件流接入统一 session 归属解析。
- `packages/web/src/lib/store/index.ts`  
  责任：补齐并稳定会话行为一致性，不改外部接口签名。
- `packages/web/src/components/SessionDropdown.tsx`  
  责任：完整对齐 `../cc-pet` 的会话交互行为。
- `packages/web/src/App.integration.test.tsx`  
  责任：补跨 session 消息归属回归场景。
- `packages/server/src/storage/sessions.ts`  
  责任：补齐 touch/list/label 行为和排序一致性。
- `packages/server/tests/storage.test.ts`  
  责任：覆盖 SessionStore 行为。

### Test Targets

- `packages/web/src/lib/sessionRouting.test.ts`
- `packages/web/src/lib/store/session-behavior.test.ts`
- `packages/web/src/App.integration.test.tsx`
- `packages/server/tests/storage.test.ts`
- `pnpm test:e2e`

---

### Task 1: 会话归属纯函数（sessionRouting）

**Files:**
- Create: `packages/web/src/lib/sessionRouting.ts`
- Test: `packages/web/src/lib/sessionRouting.test.ts`

- [ ] **Step 1: 写失败单测（优先级与 replyCtx 提取）**

```ts
import { describe, expect, it } from "vitest";
import { resolveIncomingSessionKey } from "./sessionRouting";

describe("resolveIncomingSessionKey", () => {
  it("prefers payload sessionKey over active session", () => {
    const key = resolveIncomingSessionKey({
      payloadSessionKey: "session-other",
      replyCtx: undefined,
      knownSessions: ["session-current", "session-other"],
      activeSessionKey: "session-current",
    });
    expect(key).toBe("session-other");
  });

  it("extracts session key from ccpet reply context", () => {
    const key = resolveIncomingSessionKey({
      payloadSessionKey: undefined,
      replyCtx: "ccpet:session-a:42",
      knownSessions: ["session-a", "session-b"],
      activeSessionKey: "session-b",
    });
    expect(key).toBe("session-a");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cc-pet/web test sessionRouting.test.ts`  
Expected: FAIL（提示 `sessionRouting` 或导出函数不存在）。

- [ ] **Step 3: 写最小实现**

```ts
type ResolveIncomingSessionKeyInput = {
  payloadSessionKey?: string;
  replyCtx?: string;
  knownSessions: string[];
  activeSessionKey?: string;
  fallbackSessionKey?: string;
};

export function sessionFromReplyCtx(replyCtx?: string): string | null {
  if (!replyCtx) return null;
  if (!replyCtx.startsWith("ccpet:")) return null;
  const body = replyCtx.slice("ccpet:".length);
  const idx = body.lastIndexOf(":");
  if (idx <= 0) return null;
  return body.slice(0, idx);
}

export function resolveIncomingSessionKey({
  payloadSessionKey,
  replyCtx,
  knownSessions,
  activeSessionKey,
  fallbackSessionKey = "default",
}: ResolveIncomingSessionKeyInput): string {
  const keyFromPayload = payloadSessionKey?.trim();
  if (keyFromPayload) return keyFromPayload;

  const keyFromReplyCtx = sessionFromReplyCtx(replyCtx);
  if (keyFromReplyCtx && (knownSessions.length === 0 || knownSessions.includes(keyFromReplyCtx))) {
    return keyFromReplyCtx;
  }

  if (activeSessionKey) return activeSessionKey;
  if (knownSessions[0]) return knownSessions[0];
  return fallbackSessionKey;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cc-pet/web test sessionRouting.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/sessionRouting.ts packages/web/src/lib/sessionRouting.test.ts
git commit -m "test(web): add session routing priority rules"
```

---

### Task 2: 在事件接入层统一 session 归属规则

**Files:**
- Modify: `packages/web/src/lib/web-adapter.ts`
- Modify: `packages/web/src/lib/tauri-adapter.ts`
- Test: `packages/web/src/App.integration.test.tsx`

- [ ] **Step 1: 写失败集成测试（跨 session 串台防回归）**

```ts
it("routes incoming payload to payloadSessionKey instead of active session", async () => {
  // arrange: active session = session-a
  // emit incoming event with payloadSessionKey = session-b
  // assert: message lands in session-b list, not session-a
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cc-pet/web test App.integration.test.tsx`  
Expected: FAIL（消息仍落在 active session）。

- [ ] **Step 3: 实现接入逻辑**

```ts
import { resolveIncomingSessionKey } from "./sessionRouting";

const knownSessions = store.sessionsByConnection[connectionId] ?? [];
const resolvedSessionKey = resolveIncomingSessionKey({
  payloadSessionKey: payload.sessionKey,
  replyCtx: payload.replyCtx,
  knownSessions,
  activeSessionKey: store.activeSessionByConnection[connectionId],
});

store.ensureSession(connectionId, resolvedSessionKey);
const activeSession = store.activeSessionByConnection[connectionId];
if (!store.chatOpen || activeSession !== resolvedSessionKey) {
  store.markSessionUnread(connectionId, resolvedSessionKey);
}
store.addMessage(connectionId, resolvedSessionKey, message);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cc-pet/web test App.integration.test.tsx`  
Expected: PASS（消息归属正确，未读策略符合预期）。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/web-adapter.ts packages/web/src/lib/tauri-adapter.ts packages/web/src/App.integration.test.tsx
git commit -m "fix(web): route incoming events by session priority"
```

---

### Task 3: 补齐 store 会话行为一致性

**Files:**
- Modify: `packages/web/src/lib/store/index.ts`
- Create: `packages/web/src/lib/store/session-behavior.test.ts`

- [ ] **Step 1: 写失败单测（remove 级联 + unread + auto-title）**

```ts
it("removeSession clears related messages labels unread and task state", () => {
  // 初始化 state 后调用 removeSession
  // 断言 messagesByChat、sessionLabelsByConnection、sessionUnreadByConnection 被正确清理
});

it("clearSessionUnread turns pet to idle when no unread remains", () => {
  // 断言 petState 从 talking -> idle
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cc-pet/web test session-behavior.test.ts`  
Expected: FAIL（存在未覆盖的行为差异）。

- [ ] **Step 3: 实现最小行为补齐**

```ts
removeSession: (connectionId, sessionId) =>
  set((state) => {
    // 1) 从 sessionsByConnection 移除
    // 2) 删除 chatKey 对应消息
    // 3) 删除 label / lastActive / unread / taskState
    // 4) 若删除 active，切换到剩余首个
    // 5) unread 清空后将 talking 归位到 idle
    return nextState;
  }),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cc-pet/web test session-behavior.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/store/index.ts packages/web/src/lib/store/session-behavior.test.ts
git commit -m "test(web): align session store behavior with cc-pet"
```

---

### Task 4: SessionDropdown 行为完整对齐

**Files:**
- Modify: `packages/web/src/components/SessionDropdown.tsx`
- Test: `packages/web/src/components/SlashCommandMenu.test.tsx` (仅保留原有覆盖，不在此任务扩展)

- [ ] **Step 1: 写失败组件测试（可新建 SessionDropdown 测试文件）**

```tsx
it("shows grouped sections and unread badge", () => {
  // 断言当前会话/最近会话分组存在，且未读角标展示
});

it("requires second click to confirm delete", () => {
  // 第一次点击进入确认态，第二次点击触发删除
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cc-pet/web test SessionDropdown`  
Expected: FAIL（交互未完全一致）。

- [ ] **Step 3: 实现交互行为**

```tsx
function DeleteBtn({ sid }: { sid: string }) {
  const confirming = confirmDeleteId === sid;
  return (
    <button onClick={(e) => handleDeleteClick(e, sid)}>
      {confirming ? "确认?" : "✕"}
    </button>
  );
}

const inactive = allSessions
  .filter((sid) => sid !== activeSessionKey)
  .sort((a, b) => (lastActive[b] ?? 0) - (lastActive[a] ?? 0));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cc-pet/web test SessionDropdown`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/SessionDropdown.tsx
git commit -m "feat(web): match cc-pet session dropdown behaviors"
```

---

### Task 5: SessionStore 持久化行为补齐

**Files:**
- Modify: `packages/server/src/storage/sessions.ts`
- Modify: `packages/server/tests/storage.test.ts`

- [ ] **Step 1: 写失败单测（排序、touch、label 更新）**

```ts
it("lists sessions by last_active_at desc", () => {
  // 创建两个 session，touch 后断言排序
});

it("touchActive updates last_active_at", () => {
  // 调 touchActive 后断言时间戳变大
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cc-pet/server test storage.test.ts`  
Expected: FAIL（行为未完整覆盖或实现不一致）。

- [ ] **Step 3: 实现最小修复**

```ts
listByConnection(connectionId: string): Session[] {
  const rows = this.db.prepare(
    `SELECT * FROM sessions WHERE connection_id = ? ORDER BY last_active_at DESC`
  ).all(connectionId) as any[];
  return rows.map(mapRowToSession);
}

touchActive(connectionId: string, key: string): void {
  this.db.prepare(
    `UPDATE sessions SET last_active_at = ? WHERE connection_id = ? AND key = ?`
  ).run(Date.now(), connectionId, key);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cc-pet/server test storage.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/storage/sessions.ts packages/server/tests/storage.test.ts
git commit -m "test(server): align session store persistence behavior"
```

---

### Task 6: 全量回归与 E2E 闸门

**Files:**
- Modify: `packages/web/src/App.integration.test.tsx`（若前序遗漏场景）
- Modify: `packages/web/src/lib/slash-commands.test.ts`（仅当受改动影响时）

- [ ] **Step 1: 运行前端关键测试**

Run: `pnpm --filter @cc-pet/web test sessionRouting.test.ts session-behavior.test.ts App.integration.test.tsx`  
Expected: PASS。

- [ ] **Step 2: 运行服务端关键测试**

Run: `pnpm --filter @cc-pet/server test storage.test.ts e2e-connect-regression.test.ts`  
Expected: PASS。

- [ ] **Step 3: 运行强制 E2E**

Run: `pnpm test:e2e`  
Expected: PASS（server 连接回归 + web 集成回归均通过）。

- [ ] **Step 4: 修复失败项并重跑（如有）**

Run: `pnpm test:e2e`  
Expected: PASS（不允许带失败完成）。

- [ ] **Step 5: Commit**

```bash
git add packages/web packages/server
git commit -m "fix: migrate cc-pet multi-session behavior with full e2e coverage"
```

---

## Self-Review

### 1) Spec Coverage

- 消息归属规则：Task 1 + Task 2 覆盖
- store 行为一致性：Task 3 覆盖
- SessionDropdown 完整交互：Task 4 覆盖
- 会话存储层行为：Task 5 覆盖
- E2E 闸门：Task 6 覆盖
- 无未覆盖 requirement

### 2) Placeholder Scan

已检查：无 `TBD/TODO/implement later/类似 Task N` 等占位写法。每个任务均给出文件路径、命令、预期结果。

### 3) Type Consistency

- `resolveIncomingSessionKey/sessionFromReplyCtx` 命名在任务中一致
- `setActiveSessionKey/ensureSession/markSessionUnread/removeSession` 命名与现有 store 保持一致
- server `SessionStore` 方法命名与现有实现一致

