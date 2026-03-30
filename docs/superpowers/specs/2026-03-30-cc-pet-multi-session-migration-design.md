# cc-pet 多连接会话与存储迁移设计

## 背景与目标

将 `../cc-pet` 中“多连接会话管理 + 会话存储 + 消息归属规则 + 会话下拉交互”完整迁移到当前项目 `cc-pet-web`，并满足以下约束：

- 行为层面与 `../cc-pet` 对齐（用户确认 A）
- 会话 UI 交互细节完整对齐（用户确认 A）
- 当前项目 API/类型保持兼容，不做破坏性改动（用户确认 B）

本设计只覆盖会话相关行为迁移，不引入无关重构。

## 范围

### 包含

- 消息归属解析：`payloadSessionKey > replyCtx > active > knownSessions[0] > default`
- 多连接会话状态管理：active、session list、label、lastActive、unread、taskState
- 会话创建/切换/删除的端到端一致性流程
- SessionDropdown 完整交互迁移（分组、未读、状态文案、二次确认删除、显示更多）
- 服务端会话存储行为补齐（排序、touch、label、删除）
- 单测与集成回归补齐

### 不包含

- 新协议或新 REST endpoint 设计
- 大规模 store 架构重写
- 与会话无关的 UI/服务端重构

## 方案总览（路径 2：行为移植，接口兼容）

### 1) 路由归属层

新增 `packages/web/src/lib/sessionRouting.ts`，迁移 `../cc-pet/src/lib/sessionRouting.ts` 的纯函数逻辑：

- `sessionFromReplyCtx(replyCtx?: string): string | null`
- `resolveIncomingSessionKey(input): string`

该层不依赖适配器，仅负责会话 key 归属判定。

### 2) 状态层

沿用当前 `packages/web/src/lib/store/index.ts` 的对外接口，补齐并对齐行为：

- `setSessions` 的 active 选择规则
- `ensureSession` 的幂等补会话
- `markSessionUnread/clearSessionUnread` 的 pet 状态联动
- `removeSession` 的级联清理（messages/labels/lastActive/unread/taskState）
- 自动标题（首条用户文本、历史回填）策略

### 3) 事件接入层

保持当前 adapter 与通信链路不变，在入站事件消费处统一接入 `resolveIncomingSessionKey`：

- 文本消息
- 按钮消息
- 文件消息

每条入站事件流程固定为：

1. resolve session key
2. ensure session
3. 判断 unread
4. 落消息并更新 lastActive

### 4) UI 层

在 `packages/web/src/components/SessionDropdown.tsx` 对齐 `../cc-pet` 行为：

- 当前会话 / 最近会话分组
- 总未读角标与会话未读
- 会话 phase 文案
- 删除会话二次确认
- 最近会话折叠与“显示更多”

### 5) 服务端会话存储层

保持现有 API 兼容，补齐持久化行为，不新增破坏性字段：

- 表：`sessions(connection_id, key, label, created_at, last_active_at)`
- 唯一键：`(connection_id, key)`
- 列表查询按 `last_active_at DESC`
- 写入规则：
  - create：初始化 `created_at/last_active_at`
  - 发送或接收消息后 touch active
  - 改名只更新 `label`
  - 删除会话删除记录并联动前端状态清理

不新增独立 `active_session` 持久化，避免与 bridge active 形成双真相源冲突。

## 核心数据流

### 收消息归属

对 `bridge-message` / `bridge-buttons` / `bridge-file-received` 统一：

1. `sessionKey = resolveIncomingSessionKey(...)`
2. `ensureSession(connectionId, sessionKey)`
3. 若 `!chatOpen || activeSession !== sessionKey`，`markSessionUnread`
4. `addMessage(...)`
5. 更新 `sessionLastActive`

### 创建会话

1. 前端调用 `createBridgeSession`
2. 立即 `listBridgeSessions` 拉取全量
3. `setSessions` 同步本地 session 列表
4. 取 `activeSessionId`（无则取新增会话）并本地 `setActiveSessionKey`
5. 调 `switchBridgeSession` 与 bridge 侧对齐

### 切换会话

1. 本地先切 `setActiveSessionKey`
2. 清该会话未读 `clearSessionUnread`
3. 异步调用 `switchBridgeSession`，失败仅记录日志（保持当前项目风格）

### 删除会话

1. UI 二次确认
2. 本地 `removeSession` 先行
3. 异步 `deleteBridgeSession`
4. 若删的是 active，会自动切换到剩余会话首个（无则空）

## 错误处理策略

- `resolveIncomingSessionKey` 永不抛异常，解析失败走 fallback
- 远端调用失败：`console.error` + 保持可继续操作，不阻断主流程
- 空会话态：UI 回退为连接名/默认展示，不抛空引用错误
- 服务端存储异常：返回现有错误通道，不改变接口形状

## 测试与回归

### 单测

- `sessionRouting`：优先级、replyCtx 提取、fallback
- store：ensure/remove 级联、unread 清理、auto-title
- `SessionDropdown`：分组、未读、phase 文案、删除二次确认、显示更多
- server `SessionStore`：create/list/touch/updateLabel/delete

### 集成与 E2E

- 补强 `packages/web/src/App.integration.test.tsx` 的跨会话归属场景
- 执行并通过根回归：
  - `pnpm test:e2e`
  - 覆盖 server 连接回归与 web 关键集成链路

## 验收标准

- 消息归属严格遵循：`payload > replyCtx > active > firstKnown > default`
- 多连接并行下无会话串扰
- SessionDropdown 交互与 `../cc-pet` 一致
- 创建/切换/删除后，bridge 与前端 active 最终一致
- 单测、集成、E2E 均通过

## 实施顺序建议

1. 新增 `sessionRouting` 与对应单测
2. 在事件接入层统一 session 归属
3. 补齐 store 行为一致性
4. 对齐 SessionDropdown 交互
5. 补齐 server store 行为
6. 跑完整测试并修复回归
