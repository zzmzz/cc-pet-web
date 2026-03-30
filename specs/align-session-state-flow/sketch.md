## 目标
基于 `./cc-pet` 现有实现，对齐 `cc-pet-web` 的会话状态流转，确保同一会话在 WebSocket 事件链路中的阶段变化、未读计数与宠物状态行为一致，避免跨会话串流和状态回退异常。

## 推荐实现方案
采用“轻量状态机 + 统一事件归约”的方式，将当前 `TaskPhase` 级别的离散更新，升级为与 `./cc-pet/src/lib/types.ts::SessionTaskState` 对齐的会话任务状态模型（`activeRequestId`、`startedAt`、`lastActivityAt`、`firstTokenAt`、`stalledReason`）。

核心思路：
- 保留 `cc-pet-web` 现有分层（`App` 负责 WS 事件消费，store 负责状态存储），不引入 Tauri 侧窗口能力。
- 参考 `./cc-pet/src/components/ChatWindow.tsx` 中的事件驱动状态迁移规则，抽取为 web 侧可复用的状态迁移方法，避免在 `App.tsx` 中分散 `setTaskPhase("...")`。
- 继续沿用 `resolveIncomingSessionKey` 和 `applyIncomingWsSessionRouting`，将“会话路由”与“任务状态流转”解耦，保证跨会话消息不会污染当前会话状态。

## 相关改动 & 步骤
1. 扩展共享会话状态类型，建立映射兼容层  
- `packages/shared/src/types/session.ts`  
  - 将当前 `TaskPhase` 扩展为与 `cc-pet` 对齐的任务阶段（至少覆盖 `working/awaiting_confirmation/stalled` 语义），并补齐 `SessionTaskState` 的结构化字段。  
  - 保留对现有 `processing/waiting_confirm/possibly_stuck` 的兼容映射（迁移过渡期）。

2. 升级 session store 的任务状态存储能力  
- `packages/web/src/lib/store/session.ts`  
  - 用 `taskStateByConnection`（`Record<connectionId, Record<sessionKey, SessionTaskState>>`）替代当前 `taskPhaseByConnection`。  
  - 增加原子化方法：`beginSessionRequest`、`patchSessionTaskState`、`markSessionCompleted`、`markSessionFailed`、`clearSessionTaskState`（命名可微调）。  
  - 在 `removeSession` 时清理整条任务状态，保持与 unread/messages 的清理一致性。

3. 统一 App 事件流转为“会话任务状态归约”  
- `packages/web/src/App.tsx`  
  - 将 `BRIDGE_TYPING_START / STREAM_DELTA / STREAM_DONE / BRIDGE_BUTTONS / BRIDGE_ERROR / TYPING_STOP` 的分支更新统一走 store 的任务状态 API。  
  - 参考 `./cc-pet/src/components/ChatWindow.tsx`：  
    - typing/start -> `thinking`  
    - delta/preview/message进行中 -> `working`（并更新 `lastActivityAt`/`firstTokenAt`）  
    - buttons -> `awaiting_confirmation`  
    - done/typing_stop -> `completed`（再延时归零或清理）  
    - error -> `failed`
  - 对宠物状态切换增加“未读优先”守护：状态回 idle 前先判断 `hasAnyUnread()`。

4. 对齐会话标签展示逻辑（阶段文案与状态来源）  
- `packages/web/src/components/SessionDropdown.tsx`  
  - 由读取 `taskPhaseByConnection` 改为读取 `SessionTaskState.phase`。  
  - `formatSessionPhase` 文案与 `./cc-pet/src/components/SessionDropdown.tsx` 保持一致，并保留旧 phase 的兼容输入。

5. 补齐会话状态流转测试（优先行为测试）  
- `packages/web/src/App.integration.test.tsx`  
  - 新增/调整用例覆盖：  
    - typing -> stream -> done 的阶段演进  
    - buttons 导致 `awaiting_confirmation`  
    - error 导致 `failed`  
    - 非激活会话消息触发未读但不污染当前会话状态  
- `packages/web/src/lib/store/session-behavior.test.ts`  
  - 增加任务状态对象的清理与覆盖行为测试（removeSession、clear、并发事件覆盖）。
- `packages/web/src/components/SessionDropdown.test.tsx`（可能涉及）  
  - 校验状态文案映射和显示来源。

6. 可能涉及的配套文件  
- `packages/web/src/lib/hydrateFromServer.ts`（如需在 hydrate 时初始化任务状态默认值）  
- `packages/web/src/lib/store/index.ts`（导出签名更新）  
- `packages/shared/src/types/index.ts`（类型导出同步）

## 验证方式
- 单测/集成：
  - `pnpm -C packages/web test -- App.integration.test.tsx session-behavior.test.ts SessionDropdown.test.tsx`
  - 重点断言：phase 迁移顺序、跨会话隔离、unread 与 petState 联动。
- 回归（强制）：
  - `pnpm test:e2e`
  - 通过标准：`packages/server/tests/e2e-connect-regression.test.ts` 与 `packages/web/src/App.integration.test.tsx` 全部通过。
- 手工冒烟：
  - 开两个会话并切换激活会话，向非激活会话注入回复，确认 unread、阶段文案和宠物状态符合预期。
  - 触发按钮消息与异常消息，确认分别进入 `待确认` / `失败` 并可恢复。

## 技术风险与假设
- 假设当前服务端事件字段（`sessionKey/replyCtx`）保持兼容；若出现仅 `reply_ctx` 或仅 `session_key` 的混合场景，需在适配层继续兜底。
- 风险在于“阶段名迁移”可能影响现有断言与样式分支；建议先保留旧 phase 映射，分两步移除。
- `cc-pet` 中部分逻辑依赖 Tauri 事件与窗口生命周期；本次只对齐会话状态流转语义，不迁移桌面端专属能力。
