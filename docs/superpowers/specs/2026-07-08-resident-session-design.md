# cc-pet-web 常驻 Session + 主动提醒 设计文档

- 日期：2026-07-08
- 状态：已评审，待实现计划
- 范围：cc-pet-web（Fastify server + React web）

## 1. 背景与目标

cc-pet-web 是一个作为**客户端主动连出**到多个 cc-connect bridge 的 Web 应用：它转发消息、用 SQLite 存档、并提供宠物 + 聊天 UI。真正的对话记忆活在 cc-connect 侧（`session_key` 绑定的 Claude Code session）。

目标：给 cc-pet-web 引入**常驻 session**，同时承载两类同等重要的用途：

1. **长期记忆助手**：一个永不失忆、置顶常驻的对话入口（记忆由 cc-connect 侧的 reuse session 保持）。
2. **cron 主动任务**：由 **cc-connect 侧自带的 cron/timer** 定时往该 session 发 prompt，回复回流到 cc-pet-web 后主动提醒用户。

### 已定决策

| 决策点 | 选择 |
| --- | --- |
| 核心用途 | 长期记忆助手 + cron 主动任务，两者同等重要 |
| 调度器位置 | 复用 cc-connect 自带 cron（不在 pet-web 侧新建调度器） |
| 常驻 session 范围 | **每个登录 token 一个常驻 session**，绑定一个选定 bridge |
| 主动提醒方式 | 宠物动效 + 未读徒标；以及 PWA 浏览器推送（关页面也能收） |
| 实现范围 | 方案 B（常驻 session + 主动提醒含 Web Push）；cron 管理 UI 留作后续 |

## 2. 现状（关键事实）

- **Bridge 连接**：`packages/server/src/bridge/`。pet-web 作为 WS 客户端连 cc-connect；一个 bridge = 一个 `connectionId`；bridge 内用 `session_key` 区分对话。
- **消息流**：`index.ts` 里 `bridgeManager.on("message", ...)` 处理 reply / reply_stream / card / file / audio 等，存 SQLite 并 `hub.broadcast` 给浏览器。
- **已有发送-收集原语**：`ReplyCollector` + `/api/siri/send` + `/api/siri/poll`（Siri 快捷指令在用），是"程序化发一条并等完整回复"的能力。
- **会话清理**：`SessionsCleanup` 清理 10 天不活跃 session（仅清 pet-web SQLite 档案，不影响 cc-connect 侧记忆）。
- **通知现状**：
  - `packages/web/src/lib/notification.ts` 已有一套**前台通知**（`new Notification()`），在「页面隐藏 或 非当前 session」时弹，但**仅在有 tab 开着时有效**，并含 iOS 手势/权限处理。
  - `vite-plugin-pwa` 已配置（`registerType: autoUpdate`，workbox 生成 SW），但 SW **无 `push` / `notificationclick` 处理**，也无服务端推送。→ 真·PWA 后台推送是本次新建的主要基建。

## 3. 架构总览（新增部分）

```
cc-connect cron ──(定时发 prompt)──▶ 常驻 session (reuse, 记忆持久)
                                          │ 回复回流
cc-pet-web bridge client ◀────────────────┘
   │  ├─ ResidentRegistry：认定/引导常驻 session，豁免清理
   │  ├─ ProactiveDetector：判定是否"主动消息"
   │  ├─ WebPushService：向该 token 的订阅推送
   │  └─ 未读状态 + 广播
   ▼
浏览器：置顶 + 徒标 + 宠物动效  │  Service Worker：push → 系统通知（关页面也收）
```

## 4. 配置 Schema（`cc-pet.config.json`）

每个 token 增加 `residentSession`；server 层增加 `webPush`：

```jsonc
"tokens": [{
  "token": "Zzm011896", "name": "Ziiimo",
  "bridgeIds": ["cs","cc","oc","cx","cdx"],
  "residentSession": { "bridgeId": "cc", "key": "resident", "label": "第二大脑" }
}],
"webPush": {
  "vapidPublicKey": "...",
  "vapidPrivateKey": "...",
  "subject": "mailto:zmzhu@fintopia.tech"
}
```

- `residentSession.bridgeId` 必须 ∈ 该 token 的 `bridgeIds`；启动时校验，非法则告警并忽略该常驻配置（不阻断启动）。
- `residentSession.key` 默认 `resident`；`label` 用于 UI 展示。
- 缺 `webPush` 或密钥非法 → 推送子系统优雅禁用（前端隐藏开关），其余功能照常。
- 对应的类型定义放在 `packages/shared`（`TokenConfig` 增加可选 `residentSession`，新增 `WebPushConfig`）。

## 5. 数据模型（SQLite）

- **复用 `sessions` 表**，新增两列（迁移）：
  - `is_resident INTEGER DEFAULT 0`
  - `unread_count INTEGER DEFAULT 0`
- **新表 `push_subscriptions`**：
  - `id TEXT PRIMARY KEY, token_name TEXT, endpoint TEXT UNIQUE, p256dh TEXT, auth TEXT, created_at INTEGER, last_used_at INTEGER`
  - 按 token 归属；推送时按 `token_name` 查订阅。
- 常驻 session 的 `(connectionId, key)` 集合由 config 计算，作为排除项传给 `SessionsCleanup`（清理时跳过）。`is_resident` 列用于 UI 置顶查询与幂等 bootstrap。

## 6. 后端组件（新增/改动）

新增：
- `resident/registry.ts`：解析 config → 常驻集合；`isResident(conn, key)`；`getResidentForToken(tokenName)`；`residentPairs()`；启动时 `bootstrap()` 把常驻 session upsert 进 `sessions`（`is_resident=1` + 写 label），幂等。
- `resident/proactive-detector.ts`：维护 `lastUserSendAt` per `(conn, key)`；`markUserSend(conn, key)`；`isProactive(conn, key)` = 该常驻 session 近 N 分钟（默认 5min）内无本地用户发送 → true（cron 回复即属此类）。
- `push/web-push-service.ts`：封装 `web-push` npm 库；`sendToToken(tokenName, payload)`；发送失败对 404/410 订阅自动剪除；VAPID 缺失时为 no-op。
- `storage/push-subscriptions.ts`：订阅 CRUD（upsert by endpoint、按 token 列举、删除、剪除死订阅）。
- `api/push.ts`：`GET /api/push/vapid-public-key`、`POST /api/push/subscribe`、`POST /api/push/unsubscribe`（均走现有 auth 中间件；订阅归属当前请求 token）。

改动：
- `index.ts` bridge message handler：当 `reply` / `reply_stream(done)` / `card` / `file` 命中常驻 session →
  - `unread_count++`（写库）；
  - 广播新 WS 事件 `RESIDENT_UNREAD`（携带 connectionId、sessionKey、unreadCount）；
  - 若 `proactiveDetector.isProactive(conn, key)` 为真 → `webPush.sendToToken(ownerToken, payload)`。
- `index.ts` dashboard `SEND_MESSAGE`（及 siri send）命中常驻 session 时 → `proactiveDetector.markUserSend(conn, key)`。
- `cleanup/sessions-cleanup.ts`：接受排除集合（常驻 pairs），清理时跳过。
- `shared` 增加 `WS_EVENTS.RESIDENT_UNREAD` 及相关类型。

## 7. 前端组件（新增/改动）

- **会话列表 / SessionDropdown**：常驻 session 置顶 + 特殊 label + 未读徒标；进入该 session 时清零（调用清零 API 或 WS 事件）。
- **未读状态**：监听 `RESIDENT_UNREAD` 更新徒标；activeSession 切到常驻时清零。
- **宠物动效**：常驻 session 到消息时触发 talking/happy（复用现有 pet 状态驱动路径）。
- **Service Worker**：vite-plugin-pwa 切换到 `injectManifest` 策略，自定义 `sw.ts`：
  - `precacheAndRoute(self.__WB_MANIFEST)`（保留 workbox 预缓存）；
  - `push` 事件 → `showNotification`；
  - `notificationclick` → 聚焦/打开 app 并定位到常驻 session。
- **推送订阅流程**：设置面板（`SettingsPanel`）加「开启后台推送」开关 →
  - 请求通知权限（复用 `notification.ts` 的 iOS 手势/权限逻辑）→
  - `GET /api/push/vapid-public-key` →
  - `PushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` →
  - `POST /api/push/subscribe`。
- **前台 vs 后台去重**：现有 `notification.ts` 前台通知扩展覆盖常驻 session；SW push 通知与前台通知用相同 `tag` 去重（或前台优先：tab 可见时不弹 SW 通知）。

## 8. 数据流

1. **cron 主动**：cc-connect cron → session → 回复回 pet-web → 命中常驻 + `isProactive` → 存档 + `unread++` + 广播 `RESIDENT_UNREAD` +（关页面）Web Push。
2. **正常聊天**：用户在常驻 session 发言 → `markUserSend` → 回复回来 `isProactive=false` → 只更新 UI，不推送。
3. **关页面推送**：SW 收 push → `showNotification` → 点击 → 打开 app 定位到常驻 session。

## 9. cc-connect cron 配置（运维手册，非本仓库代码）

在**承载绑定 bridge 的那台 cc-connect** 上配置 cron：

```bash
cc-connect cron add \
  --cron "0 6 * * *" \
  --prompt "总结今天的 GitHub trending" \
  --session-mode reuse \
  --desc "每日 trending"
```

要点（写入实现产物文档）：
- `session_key` 必须对齐常驻 key（如 `resident`）；
- `--session-mode reuse` 以保持记忆；
- 参考 memory 记录的坑：某些 cc-connect 实例加 cron 后需 restart 才加载。
- 前置：必须先完成 §11 的回流验证，确认该 cc-connect 实例会把 cron 回复广播给 bridge 客户端。

## 10. 错误处理

- VAPID 缺失/无效 → 推送禁用，`vapid-public-key` 返回空，前端隐藏开关。
- push 发送失败：404/410 剪除订阅，其余记日志不崩。
- 通知权限被拒/浏览器不支持：前端展示状态，降级为仅前台通知 / 仅 UI 徒标。
- 绑定 bridge 掉线：cron 回复到不了，UI 显示 bridge 断开（现有能力）。
- 订阅 endpoint 重复：按 endpoint upsert。
- `residentSession` 配置非法（bridgeId 不在 token 的 bridgeIds 内）：告警并忽略，不阻断启动。

## 11. ⚠️ 关键验证点

**必须在动手前验证**：cc-connect 的 cron 触发的回复，能否回流到 pet-web 订阅的那个 bridge `session_key`。

若 cc-connect 只把 cron 回复发给它自己的原生平台（如创建 cron 的群聊）而**不广播给 bridge 客户端**，则本设计主线不成立，需要改用其他触发路径（例如 pet-web 侧新建调度器 + 复用 `ReplyCollector` 发送原语）。

验证方法：在承载 bridge `cc` 的 cc-connect 上配一个测试 cron，target `session_key = resident`，观察 pet-web 的 bridge client 是否收到回复消息。

## 12. 分期计划

- **P0**：验证 cron → bridge 回流（§11）。这是 go/no-go 关卡。
- **P1**：常驻 session —— config schema、`ResidentRegistry`、置顶 UI、豁免清理、未读徒标 + 宠物动效。
- **P2**：Web Push 全链路 —— `push_subscriptions` 存储、`WebPushService`、`api/push`、自定义 SW、订阅 UI、`ProactiveDetector` 接线。
- **后续**：方案 C 的 cron 管理 UI（在 pet 内查看/增删 cc-connect 定时任务）+ 记忆 bootstrap 系统提示 + 定期摘要。

## 13. 测试策略

- 单元：`registry`（解析/校验/bootstrap 幂等）、`proactive-detector`（有/无近期发送）、`web-push-service`（mock web-push、剪除死订阅）、`sessions-cleanup` 排除常驻。
- 存储：`push_subscriptions` CRUD + 迁移。
- 集成：常驻 session 收 reply → `unread++` 且 proactive 时触发 push；近期用户发送后收 reply → 不 push。
