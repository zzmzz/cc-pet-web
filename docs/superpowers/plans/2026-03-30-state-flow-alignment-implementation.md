# State Flow Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以“前后端同批次硬切”方式完成 `cc-pet-web` 状态流转对齐，确保消息路由、未读、宠物状态与 task phase 在单一协议下稳定一致。

**Architecture:** 服务端成为会话路由和事件语义的唯一生产者，所有会话相关事件都显式携带 `sessionKey`；前端移除 `replyCtx/reply_ctx` 推断分支，仅消费标准字段。`App` 事件处理层统一管理 unread、petState、phase 变更，避免多分支互相覆盖。

**Tech Stack:** TypeScript, Fastify, ws, React, Zustand, Vitest, pnpm workspace

---

## Scope Check

该 spec 聚焦单一子系统（“状态流转对齐”），不需要拆成多个独立计划。执行顺序固定为：协议类型收敛 -> server 事件硬切 -> web 消费硬切 -> 状态联动收敛 -> 回归验证。

## File Structure

### Create

- `docs/superpowers/plans/2026-03-30-state-flow-alignment-implementation.md`  
  责任：实现计划（当前文件）。

### Modify

- `packages/shared/src/types/bridge.ts`  
  责任：收敛 bridge 入站类型，不再让前端依赖 `reply_ctx` 回推会话归属。
- `packages/server/src/index.ts`  
  责任：所有广播事件只输出标准字段，错误事件也精确携带 `sessionKey`。
- `packages/web/src/lib/web-adapter.ts`  
  责任：移除 `applyIncomingWsSessionRouting/resolveIncomingSessionKey` 分支，改为显式字段校验。
- `packages/web/src/lib/sessionRouting.ts`  
  责任：保留仅用于 outbound `replyCtx` 解析（若有），移除 inbound 主路径依赖。
- `packages/web/src/App.tsx`  
  责任：集中 unread/pet/phase 状态推进逻辑，统一回落策略。
- `packages/web/src/lib/store/session.ts`  
  责任：固化 unread 与 phase 的单一更新策略，减少 UI 分支重复写状态。
- `packages/web/src/App.integration.test.tsx`  
  责任：验证消息落点、流式首包 unread、phase 与 petState 联动。
- `packages/server/tests/e2e-connect-regression.test.ts`  
  责任：验证 server 转发事件必须携带标准字段并可被 dashboard 直接消费。

### Test Targets

- `pnpm --filter @cc-pet/shared test -- --runInBand` (如 shared 无 test 脚本可跳过，见任务步骤说明)
- `pnpm --filter @cc-pet/server test -- tests/e2e-connect-regression.test.ts`
- `pnpm --filter @cc-pet/web test -- src/App.integration.test.tsx`
- `pnpm test:e2e`

---

### Task 1: 收敛共享协议类型（Shared Contract）

**Files:**
- Modify: `packages/shared/src/types/bridge.ts`
- Test: `packages/web/src/App.integration.test.tsx`

- [ ] **Step 1: 先写失败测试，锁定“前端不再依赖 reply_ctx 回推会话”**

```ts
it("does not route BRIDGE_MESSAGE by reply_ctx fallback when sessionKey is absent", async () => {
  const routed = applyIncomingWsSessionRouting(WS_EVENTS.BRIDGE_MESSAGE, {
    connectionId: "cc-connect",
    reply_ctx: "ccpet:session-b:77",
    content: "legacy payload",
  }) as { sessionKey?: string };

  expect(routed.sessionKey).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/web test -- src/App.integration.test.tsx -t "does not route BRIDGE_MESSAGE by reply_ctx fallback when sessionKey is absent"`  
Expected: FAIL（当前逻辑仍会从 `reply_ctx` 推导 `sessionKey`）。

- [ ] **Step 3: 修改 bridge 类型，明确 reply/stream 等入站消息必须显式 `session_key`**

```ts
export type BridgeIncoming =
  | { type: "register_ack"; ok?: boolean; error?: string; session_key?: string }
  | { type: "reply"; session_key: string; content: string }
  | { type: "reply_stream"; session_key: string; content?: string; done?: boolean; full_text?: string }
  | { type: "buttons"; session_key: string; content?: string; buttons: BridgeButton[] }
  | { type: "typing_start"; session_key: string }
  | { type: "typing_stop"; session_key: string }
  | { type: "preview_start"; session_key: string; preview_id: string; content: string }
  | { type: "update_message"; session_key: string; preview_id: string; content: string }
  | { type: "delete_message"; session_key: string; preview_id: string }
  | { type: "file"; session_key: string; name: string; data: string }
  | { type: "skills_updated"; commands: SlashCommand[] }
  | { type: "error"; session_key: string; message: string; code?: string };
```

- [ ] **Step 4: 运行受影响测试确认通过**

Run: `pnpm --filter @cc-pet/web test -- src/App.integration.test.tsx -t "does not route BRIDGE_MESSAGE by reply_ctx fallback when sessionKey is absent"`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/bridge.ts packages/web/src/App.integration.test.tsx
git commit -m "refactor(shared): require explicit bridge session_key payloads"
```

---

### Task 2: Server 事件广播硬切为标准字段

**Files:**
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/tests/e2e-connect-regression.test.ts`

- [ ] **Step 1: 写失败 E2E 断言，要求错误事件也携带 sessionKey**

```ts
it("broadcasts BRIDGE_ERROR with explicit sessionKey", async () => {
  const stack = await startServerAndBridge();
  const dashboardWs = await stack.openDashboardWs();
  const bridgeClient = stack.bridgeClient();
  try {
    await waitForWsMessage(dashboardWs, (msg: any) => msg.type === WS_EVENTS.BRIDGE_CONNECTED);
    bridgeClient.send(JSON.stringify({ type: "error", session_key: "default", message: "bridge failure" }));
    const evt = await waitForWsMessage<any>(
      dashboardWs,
      (msg) => msg.type === WS_EVENTS.BRIDGE_ERROR && msg.error === "bridge failure",
    );
    expect(evt.sessionKey).toBe("default");
  } finally {
    dashboardWs.close();
    await stack.stop();
  }
}, 30_000);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cc-pet/server test -- tests/e2e-connect-regression.test.ts -t "broadcasts BRIDGE_ERROR with explicit sessionKey"`  
Expected: FAIL（当前 `BRIDGE_ERROR` 广播缺少 `sessionKey`）。

- [ ] **Step 3: 最小实现：server 广播统一 `sessionKey` 字段并去掉 replyCtx 透传**

```ts
case "reply":
  hub.broadcast(WS_EVENTS.BRIDGE_MESSAGE, {
    connectionId: connId,
    sessionKey: msg.session_key,
    content: msg.content,
  });
  break;

case "reply_stream":
  if (msg.done) {
    hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DONE, {
      connectionId: connId,
      sessionKey: msg.session_key,
      fullText: msg.full_text ?? "",
    });
  } else {
    hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DELTA, {
      connectionId: connId,
      sessionKey: msg.session_key,
      delta: msg.content ?? "",
    });
  }
  break;

case "error":
  hub.broadcast(WS_EVENTS.BRIDGE_ERROR, {
    connectionId: connId,
    sessionKey: msg.session_key,
    error: msg.message,
  });
  break;
```

- [ ] **Step 4: 跑 server E2E 回归**

Run: `pnpm --filter @cc-pet/server test -- tests/e2e-connect-regression.test.ts`  
Expected: PASS（新增错误事件断言 + 原有回归均通过）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/index.ts packages/server/tests/e2e-connect-regression.test.ts
git commit -m "fix(server): hard-cut bridge event payloads to explicit sessionKey"
```

---

### Task 3: Web Adapter 移除 inbound 会话推断路径

**Files:**
- Modify: `packages/web/src/lib/web-adapter.ts`
- Modify: `packages/web/src/lib/sessionRouting.ts`
- Test: `packages/web/src/App.integration.test.tsx`

- [ ] **Step 1: 写失败测试，验证适配层不再把 replyCtx/reply_ctx 自动补成 sessionKey**

```ts
it("keeps payload untouched when BRIDGE_MESSAGE has no explicit sessionKey", () => {
  const routed = applyIncomingWsSessionRouting(WS_EVENTS.BRIDGE_MESSAGE, {
    connectionId: "cc-connect",
    replyCtx: "ccpet:session-b:42",
    content: "legacy",
  }) as { sessionKey?: string; replyCtx?: string };

  expect(routed.sessionKey).toBeUndefined();
  expect(routed.replyCtx).toBe("ccpet:session-b:42");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cc-pet/web test -- src/App.integration.test.tsx -t "keeps payload untouched when BRIDGE_MESSAGE has no explicit sessionKey"`  
Expected: FAIL（当前仍会补出 `sessionKey`）。

- [ ] **Step 3: 修改 web-adapter，删除推断逻辑，仅做合法性透传**

```ts
export function applyIncomingWsSessionRouting(type: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  if (!INCOMING_SESSION_ROUTING_TYPES.has(type)) return payload;
  if (typeof p.connectionId !== "string" || p.connectionId.length === 0) return payload;
  // hard-cut: do not derive sessionKey from replyCtx/reply_ctx anymore.
  return payload;
}
```

- [ ] **Step 4: 删除/收敛 sessionRouting 的 inbound 导出依赖并跑测试**

```ts
// sessionRouting.ts 仅保留必要工具（若仍被其他模块使用）
export function sessionFromReplyCtx(replyCtx?: string): string | null {
  if (!replyCtx?.startsWith("ccpet:")) return null;
  const body = replyCtx.slice("ccpet:".length);
  const idx = body.lastIndexOf(":");
  if (idx <= 0) return null;
  return body.slice(0, idx);
}
```

Run: `pnpm --filter @cc-pet/web test -- src/App.integration.test.tsx`  
Expected: PASS（移除 fallback 后，依赖显式 `sessionKey` 的用例通过）。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/web-adapter.ts packages/web/src/lib/sessionRouting.ts packages/web/src/App.integration.test.tsx
git commit -m "refactor(web): remove inbound session fallback routing"
```

---

### Task 4: App + SessionStore 统一 unread/pet/phase 决策

**Files:**
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/lib/store/session.ts`
- Test: `packages/web/src/lib/store/session-behavior.test.ts`
- Test: `packages/web/src/App.integration.test.tsx`

- [ ] **Step 1: 先写失败测试，覆盖流式首包 unread 与 petState 回落**

```ts
it("marks unread only once for first stream delta in background session", async () => {
  useSessionStore.setState({
    sessions: {
      "cc-connect": [
        { key: "session-a", connectionId: "cc-connect", createdAt: 1, lastActiveAt: 1 },
        { key: "session-b", connectionId: "cc-connect", createdAt: 2, lastActiveAt: 2 },
      ],
    },
    activeSessionKey: { "cc-connect": "session-a" },
  });
  render(<App />);
  await screen.findByText("cc-connect");
  adapter.emit(WS_EVENTS.BRIDGE_STREAM_DELTA, {
    connectionId: "cc-connect",
    sessionKey: "session-b",
    delta: "hello",
  });
  adapter.emit(WS_EVENTS.BRIDGE_STREAM_DELTA, {
    connectionId: "cc-connect",
    sessionKey: "session-b",
    delta: " world",
  });
  const keyB = makeChatKey("cc-connect", "session-b");
  await waitFor(() => expect(useSessionStore.getState().unread[keyB]).toBe(1));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cc-pet/web test -- src/App.integration.test.tsx -t "marks unread only once for first stream delta in background session"`  
Expected: FAIL（当前可能重复累计 unread 或状态回落不一致）。

- [ ] **Step 3: 实现统一决策函数并在 App 事件分支集中调用**

```ts
const syncPetStateFromUnread = (): void => {
  const hasUnread = useSessionStore.getState().hasAnyUnread();
  useUIStore.getState().setPetState(hasUnread ? "talking" : "idle");
};

const shouldMarkUnread = (cid: string, sessionKey: string): boolean => {
  const chatOpen = useUIStore.getState().chatOpen;
  const active = useSessionStore.getState().activeSessionKey[cid] ?? "default";
  return !chatOpen || active !== sessionKey;
};

case WS_EVENTS.BRIDGE_STREAM_DONE:
  useMessageStore.getState().finalizeStream(chatKey, payload.fullText);
  setTaskPhase("idle");
  syncPetStateFromUnread();
  break;

case WS_EVENTS.BRIDGE_TYPING_STOP:
  setTaskPhase("idle");
  syncPetStateFromUnread();
  break;
```

- [ ] **Step 4: 为 SessionStore 补行为断言并跑通**

```ts
it("clearSessionUnread keeps pet talking when other chats still unread", () => {
  useUIStore.getState().setPetState("talking");
  useSessionStore.setState({
    unread: {
      [makeChatKey("bridge-1", "session-a")]: 1,
      [makeChatKey("bridge-1", "session-b")]: 1,
    },
  });
  useSessionStore.getState().clearSessionUnread("bridge-1", "session-a");
  expect(useUIStore.getState().petState).toBe("talking");
});
```

Run: `pnpm --filter @cc-pet/web test -- src/lib/store/session-behavior.test.ts src/App.integration.test.tsx`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/App.tsx packages/web/src/lib/store/session.ts packages/web/src/lib/store/session-behavior.test.ts packages/web/src/App.integration.test.tsx
git commit -m "fix(web): unify unread pet-state and task-phase transitions"
```

---

### Task 5: 端到端回归与发布闸门

**Files:**
- Modify: `packages/server/tests/e2e-connect-regression.test.ts`（仅当 Task 2 增补断言后需微调）
- Modify: `packages/web/src/App.integration.test.tsx`（仅当回归发现断言缺口）

- [ ] **Step 1: 运行 server 关键回归**

Run: `pnpm --filter @cc-pet/server test -- tests/e2e-connect-regression.test.ts`  
Expected: PASS。

- [ ] **Step 2: 运行 web 关键集成回归**

Run: `pnpm --filter @cc-pet/web test -- src/App.integration.test.tsx`  
Expected: PASS。

- [ ] **Step 3: 运行强制 E2E 闸门**

Run: `pnpm test:e2e`  
Expected: PASS（`packages/server/tests/e2e-connect-regression.test.ts` 与 `packages/web/src/App.integration.test.tsx` 全部通过）。

- [ ] **Step 4: 若失败则修复并重跑同一命令**

Run: `pnpm test:e2e`  
Expected: PASS（不允许带失败宣告完成）。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/bridge.ts packages/server/src/index.ts packages/server/tests/e2e-connect-regression.test.ts packages/web/src/lib/web-adapter.ts packages/web/src/lib/sessionRouting.ts packages/web/src/App.tsx packages/web/src/lib/store/session.ts packages/web/src/lib/store/session-behavior.test.ts packages/web/src/App.integration.test.tsx
git commit -m "fix: hard-cut state flow alignment across server and web"
```

---

## Self-Review

### 1) Spec Coverage

- 协议硬切与字段统一：Task 1 + Task 2 覆盖。
- 移除前端 replyCtx 推断：Task 3 覆盖。
- unread/pet/phase 统一流转：Task 4 覆盖。
- 强制 E2E 闸门：Task 5 覆盖。
- 无遗漏需求。

### 2) Placeholder Scan

已检查：无 `TBD/TODO/implement later/类似 Task N` 占位内容；每个任务均给出文件、代码、命令、预期结果。

### 3) Type Consistency

- server 广播字段统一使用 `sessionKey`。
- bridge 入站字段统一使用 `session_key`（来自上游协议）。
- web 消费链路统一读取 `payload.sessionKey`，不再依赖 `replyCtx/reply_ctx` 补位。

