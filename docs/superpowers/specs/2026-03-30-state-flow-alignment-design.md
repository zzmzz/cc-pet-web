# 状态流转对齐设计（参考 cc-pet）

## 背景

当前 `cc-pet-web` 在会话路由、未读与宠物状态联动、任务 phase 更新上，已经部分对齐 `../cc-pet`，但仍存在多处“前端兜底推断”和“多分支写状态”的实现。  
本次目标是按“同批次硬切”方式统一前后端协议与流转逻辑，降低跨会话串流和状态互相覆盖风险。

## 目标与非目标

### 目标

- 前后端在同一批次统一状态流转协议。
- 前端保留当前 web phase 语义：`idle/thinking/processing/waiting_confirm/completed/failed/possibly_stuck`。
- 服务端事件保证目标会话可判定，前端不再做 reply context 推断。
- 下拉会话状态展示与未读、宠物状态联动保持一致且可预测。

### 非目标

- 不做向后兼容，不保留旧字段别名分支。
- 不引入新的 phase 枚举。
- 不做与本次状态流转无关的重构。

## 范围

- `packages/server`：事件 payload 字段与发射时机统一。
- `packages/shared`：事件常量与类型契约统一。
- `packages/web`：`web-adapter`、`App` 事件处理、session store、UI 展示对齐。
- 测试：单测、集成测试、`pnpm test:e2e` 回归。

## 统一架构与职责边界

### 1) 服务端（语义生产者）

- 负责决定并输出每个事件的准确 `sessionKey`。
- 负责输出与生命周期一致的 phase 事件节奏（typing、stream、done、error）。
- 对不完整 payload 在服务端拦截并记录，不将脏事件传播到前端。

### 2) 前端适配层（协议入口）

- 仅做基础解析与校验，不做 legacy 字段兼容，不做 session 推断回填。
- 透传服务端给出的 `connectionId/sessionKey/type/payload` 到应用层。

### 3) 前端应用层（状态消费者）

- `App`：按事件推进消息、未读、phase、宠物状态。
- `store`：维护会话、未读、phase 的单一状态源。
- 组件层：仅做展示与交互，不再承载状态推断。

## 数据流转设计（按事件）

### BRIDGE_MESSAGE

- 输入：`connectionId + sessionKey + content`。
- 行为：
  - 消息写入 `makeChatKey(connectionId, sessionKey)`。
  - 若目标会话不可见（chat 未开或非 active）则 unread +1，宠物置 `talking`。
  - 若目标会话可见，清该会话 unread（如有），宠物按全局 unread 结果决定。
  - phase 置 `idle`。

### BRIDGE_STREAM_DELTA

- 输入：`connectionId + sessionKey + delta`。
- 行为：
  - 增量写入目标 chat 的 streaming buffer。
  - 该轮流式首包且目标不可见时 unread +1（整轮仅一次）。
  - phase 置 `processing`。
  - 宠物置 `talking`。

### BRIDGE_STREAM_DONE

- 输入：`connectionId + sessionKey + fullText`。
- 行为：
  - 合并 streaming 内容为正式消息并清空缓存。
  - phase 置 `idle`。
  - 宠物状态按“是否仍有任意 unread”统一回落：有 unread 保持 `talking`，无 unread 回 `idle`。

### BRIDGE_TYPING_START / BRIDGE_TYPING_STOP

- `TYPING_START`：
  - phase 置 `thinking`。
  - 宠物置 `thinking`。
- `TYPING_STOP`：
  - phase 置 `idle`。
  - 宠物不做无条件 `idle` 覆盖，改为走统一决策（优先 unread）。

### BRIDGE_BUTTONS / BRIDGE_FILE_RECEIVED

- 行为与 `BRIDGE_MESSAGE` 一致，均依赖 payload 的 `sessionKey` 精确落点。
- 非 active 会话时增加 unread；可见会话直接展示。
- phase 在消息落盘后归 `idle`。

### BRIDGE_ERROR

- 输入：`connectionId + sessionKey + error`。
- 行为：
  - 错误消息写入目标会话。
  - phase 置 `failed`。
  - 宠物置 `error`，并在短时窗口后按统一决策恢复（避免长期锁死 `error`）。

## 关键状态规则

### 会话路由

- 唯一规则：服务端提供的 `sessionKey` 即目标会话。
- 前端移除基于 `replyCtx/reply_ctx` 的 session 推断路径。

### unread 规则

- 增量条件：目标会话不可见。
- 清理条件：切换到该会话或聊天窗打开且该会话可见。
- 流式场景只在首包计一次 unread。

### 宠物状态规则

- 状态写入集中到统一决策函数，输入为 `eventPhase + hasAnyUnread`。
- 不允许多个事件分支直接互相覆盖最终状态，避免闪烁和回退错误。

### phase 规则

- `typing_start -> thinking`
- `stream_delta -> processing`
- `stream_done/message/buttons/file -> idle`
- `error -> failed`

## 变更清单（实现导向）

### server

- 统一 WS 事件 payload，确保所有会话相关事件包含 `connectionId` 与 `sessionKey`。
- 清理旧字段输出（含 reply context 兼容字段）。
- 将事件发射点与 phase 时机固定，避免重复或乱序发射。

### shared

- 统一 `WS_EVENTS` 与相关 payload 类型，删除旧字段类型分支。
- 保持 `TaskPhase` 为当前 web 语义，不引入新枚举。

### web

- `web-adapter`：
  - 移除 `replyCtx/reply_ctx` 兼容推断入口。
  - 保留最小校验与异常日志。
- `App`：
  - 统一事件到状态更新流程，调用集中化宠物状态决策。
- `session store`：
  - 固化 unread 首包计数、切会话清理、phase 更新接口。
- `SessionDropdown`：
  - 保持当前中文文案映射，仅读取统一状态。

## 风险与缓解

- 同步发布风险：硬切不兼容，必须 server/web 同版本部署。
  - 缓解：同一流水线打包发布，禁止跨版本组合。
- 事件字段缺失导致消息丢失。
  - 缓解：服务端发射前校验 + 前端结构化错误日志。
- 流式与 typing 并发造成宠物状态互抢。
  - 缓解：统一状态决策函数，减少分支直接写状态。

## 验证计划

### 单测

- session 路由仅验证“显式 sessionKey 落点”。
- unread 与宠物状态联动边界（多会话、多连接、切换/打开窗口）。
- phase 更新规则覆盖流式、typing、error。

### 集成测试

- `App.integration.test.tsx` 新增/调整断言：
  - 非 active 会话消息不串会话。
  - 流式首包 unread + done 回落。
  - typing 与 unread 共存下宠物状态正确。
  - error 精确落在目标会话。

### 端到端回归（强制闸门）

- 必跑：`pnpm test:e2e`。
- 通过标准：server 连接与重连链路、web 关键集成链路全部通过。
- 若失败：继续修复并复测，直到通过或明确阻塞原因。

## 发布要求

- server 与 web 同版本发布。
- 合并前通过单测、集成测试与 `pnpm test:e2e`。
- 发布后重点观察会话错投、未读异常增长、宠物状态异常切换日志。
