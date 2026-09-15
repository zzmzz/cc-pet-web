# cc-pet 鸿蒙原生客户端 · 设计文档

- 日期：2026-09-15（2026-09-15 修订：对齐 `origin/main` 的消息可靠性改造）
- 状态：设计已确认，待转实现计划
- 目标平台：HarmonyOS NEXT，API 26（与 Tailscale-OHOS 同基线）
- 基线提交：`e525167`（本文档首版基于 `b2c3e59`，落后 115 个提交，以下小节已按新代码重写）

## 1. 背景与目标

cc-pet-web 目前由 React PWA 提供移动端体验。本项目为它做一个**原生 ArkTS 客户端**，诉求是拿到 PWA 给不了的东西：原生交互手感与 HarmonyOS 系统能力（首版为本地通知）。

参照项目是同机器上的 `Tailscale-OHOS`。需要明确的是：**cc-pet 鸿蒙端不需要任何 native 层**。Tailscale 那边的 Node-API + Go c-shared 桥是为了嵌入 VPN 引擎，cc-pet 只需要 WebSocket + REST + 图片，纯 ArkTS 即可。可借鉴的是它的上层工程范式，不是底层桥接。

## 2. 首版范围

**做**：Token 登录、会话列表与切换、消息收发（含 `message-ack` 可靠投递）、markdown 渲染、接收图片预览、宠物五态动效、断线重连、本地通知、slash command 菜单。

**不做**（明确推迟，非遗漏）：全文搜索、AI 用量面板、workspace 的 git 与文件浏览、卡片/按钮消息、音频消息、**附件上传**、Push Kit 推送、后台长时任务保活。

附件上传推迟的理由：web 端的上传走 WS 流式分片，且带 `uploading` / `uploadProgress` / `uploadError` 三种中间态与失败重试（见 `packages/web/src/lib/attachment-upload.ts`）。这是独立一块可靠性工作，与首版的聊天闭环正交。首版只**接收并预览**图片。

**服务端改动：零。** 现有 `/ws` 与 `/api/*` 已满足全部需求。

## 3. 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 客户端形态 | 原生 ArkTS 重写 | 诉求是原生体验 + 系统能力；WebView 套壳与之直接相悖 |
| 工程落位 | cc-pet-web 仓库根级 `harmony/` | 与 `packages/shared` 同仓，协议漂移当场可见。不放 `packages/` 是因为 `pnpm-workspace.yaml` 扫描 `packages/*`，会试图管理一个非 Node 工程 |
| 服务端可达性 | 公网域名 + HTTPS | 直接 `wss://`，无需内网探活或多地址切换 |
| 通知档位 | 本地通知 | 不改服务端、不需 AGC 配置。代价是应用被系统回收后收不到。服务端已有 web-push 订阅与下发链路，日后接 Push Kit 是加一个 provider，不是从零搭 |
| 后台策略 | 不主动断连，也不申请长时任务 | `DATA_TRANSFER` 长时任务用于保活聊天连接属于擦边用法，有上架审核风险且耗电 |
| markdown | 自写受控子集渲染器 | ArkUI 无内置 markdown 能力；第三方库生态不可靠；Web 组件渲染等于核心体验退回网页 |
| 宠物呈现 | 所有断点均为顶栏 mini | 规则最简单，一套代码，测试面最小 |

## 4. 架构

### 4.1 目录与分层

```
harmony/entry/src/main/ets/
  entryability/EntryAbility.ets      前后台生命周期 → 驱动连接策略
  gateway/                           唯一碰网络的层
    ConnectionGateway.ets            WS 单例：建连 / 退避重连 / 事件分发
    RestClient.ets                   Bearer 封装 + 401 统一处理
    SessionApi.ets  HistoryApi.ets  PetImageApi.ets
    NotificationGateway.ets          本地通知（接口化，将来换 Push Kit 不动业务层）
  store/                             状态：@ObservedV2 单例；组件用 @Local 持有引用后访问
    ConnectionStore  SessionStore  ChatStore  TaskStore
  model/
    Protocol.ets                     协议类型，对齐 packages/shared
    Markdown.ets                     MdNode 类型定义
  logic/                             纯函数，单测主战场
    normalizeEvent.ets               WS 事件归一化
    derivePetState.ets               宠物状态派生
    parseMarkdown.ets                markdown → MdNode[]
    backoff.ets                      重连退避计算
    slashCommands.ets                命令表合并 + 前缀匹配 + 分类排序
    outbox.ets                       发送可靠性：clientMsgId / ack 超时 / 重试策略
  pages/Index.ets
  components/
    AppShell.ets  ResponsiveLayout.ets   （自 Tailscale-OHOS 移植）
    PetMini.ets  ChatWindow.ets  MessageList.ets  MarkdownView.ets
    MessageInput.ets  SlashCommandMenu.ets  SessionSheet.ets  SessionSidebar.ets
    ConnectionBadge.ets  LoginGate.ets
```

**依赖规则：Gateway 不碰 UI，Store 不碰网络，组件只读 Store。** 违反此规则的代码一律不合入。

### 4.2 自 Tailscale-OHOS 移植的资产

`ResponsiveLayout.ets`（断点纯函数）、`AppShell.ets`（应用外壳）、`MotionTokens.ets`（动效常量）、`resources/` 的中英双语与深色目录结构、`scripts/build.sh` 与签名流程。

**不移植其测试实践**：Tailscale-OHOS 有 0 个 `.test.ets`，测试全压在 Go 单测与 PowerShell 真机探针上。cc-pet-web 有 vitest 传统，鸿蒙端应当建立 ArkTS 单测。

## 5. 协议对接

鉴权：REST 走 `Authorization: Bearer <token>`，WS 走 `/ws?token=<token>` query。与现有 web 端完全一致。

首版消费的 WS 事件：`bridge:manifest`、`bridge:connected`、`bridge:error`、`bridge:message`、`bridge:stream-delta`、`bridge:stream-done`、`bridge:typing-start`、`bridge:typing-stop`、`bridge:skills-updated`、`resident:unread`、`message-ack`；发送 `send-message`。

首版调用的 REST：`POST /api/auth/verify`（**token 放在请求体，不是 Authorization 头**——该路由注册在鉴权守卫之前，是唯一按载荷验证的端点；响应 `{valid, name, bridgeIds}`）、、`/api/sessions`、`/api/history/:chatKey`、`/api/pet-images/:state`、`/api/files/:fileId`、`/api/bridges/:id/connect`、`/api/bridges/:id/disconnect`。

**防协议漂移**：`packages/server/tests/harmony-protocol-alignment.test.ts` 读取 `harmony/.../model/Protocol.ets`，双向比对 `WS_EVENTS` 的事件名集合，不一致则 `pnpm test` 失败。

这个守卫已经证明过自己：本设计首版基于 `b2c3e59` 写成，当代码更新到 `e525167` 后，守卫立即因缺少 `resident:unread` 与 `message-ack` 而变红——正是它把这次协议漂移拦了下来。**任何时候都不要因为"只是加个事件"而绕过它。**

### 5.1 平台抽象对齐

web 端已有 `PlatformAPI` 接口（`packages/web/src/lib/platform.ts`），`web-adapter.ts` 是它的 web 实现。鸿蒙端的 `ConnectionGateway` **不自创语义**，按同一组职责切分：

| `PlatformAPI` | 鸿蒙端对应 |
|---|---|
| `connectWs()` / `disconnectWs()` | `ConnectionGateway.start()` / `.stop()` |
| `onWsEvent(handler)` | 内部 `dispatch()` 分发到 store |
| `sendWsMessage(msg, policy)` | `Outbox.enqueue()` + `transmit()`，返回 `clientMsgId` |
| `flushOutbox(clientMsgId?)` | `Outbox.flush()`：无参为重连全量补发，带参为单条重试 |
| `uploadAttachment(...)` | 首版不实现（附件上传推迟） |

保持同构的收益：将来 web 端调整重试语义时，两端的差异是可比对的，而不是各写一套后靠人记得。

## 6. 连接与数据流

### 6.1 连接状态机

```
DISCONNECTED → CONNECTING → CONNECTED
                    ↑            ↓ (onClose / onError)
                    └─── BACKOFF ─┘
```

退避沿用 web 端策略：`min(30s, 1s × 2ⁿ)`。同时订阅 `@kit.NetworkKit` 的 `netAvailable`，网络恢复立即重连并将 attempt 归零（对应 web 端的 `online` 监听）。

### 6.2 前后台

`EntryAbility.onForeground / onBackground` 只做一件事：`gateway.setForeground(bool)`。

后台**不主动断连**，靠系统自然存活；期间收到 assistant 完成事件即发本地通知。应用被回收后重开，重连成功即按 `ChatMessage.seq` 调 `/api/history/:chatKey` 补齐断档，不实现任何本地补偿逻辑。

### 6.3 事件处理

web 端 `App.tsx` 现为 671 行的巨型 `useEffect`，把消息存储、未读、任务阶段、宠物状态、通知五件事连同若干 timer 揉在一起，宠物状态有 **20 处**命令式 `setPetState`，并需要 `shouldForceThinking` 补丁纠正时序。**鸿蒙端不照抄此结构。**

（首版设计时这里是 532 行 / 12 处；两个月内涨到 671 行 / 20 处。这个趋势本身就是不照抄的理由。）

WS 事件先经 `normalizeEvent` 解出 `connectionId / sessionKey / chatKey`（一次解析，而非在每个 case 里各解一遍），再分发给互不知情的消费者：

| 消费者 | 职责 |
|---|---|
| `ChatStore` | 追加消息、累积 stream delta、finalize |
| `SessionStore` | 未读计数、会话活跃时间 |
| `TaskStore` | `TaskPhase` 流转（沿用 `packages/shared` 定义） |
| `NotificationGateway` | 仅当「应用在后台」或「非当前会话」时发通知 |

**未读有两个来源，权威性不同**（对齐 `packages/web/src/lib/store/session.ts`）：

- **常驻会话**（`Session.isResident`）：未读由服务端持久化并通过 `resident:unread` 事件下发，`SessionStore` 维护一个 `residentChatKeys` 集合，对集合内的 chatKey **忽略一切本地自增**，只接受 `setUnread(chatKey, count)`。服务端是唯一真相。
- **非常驻会话**：无服务端未读，沿用本地判定——消息所属会话不是当前打开的会话，**或**应用处于后台时，本地计数加一。

「是否发通知」用的仍是本地那条判定（`chatKey !== currentChatKey || !foreground`），与未读计数解耦：通知关心的是「用户此刻有没有在看」，未读计数关心的是「累计欠了多少条」，常驻会话下这两者本就不该是同一个数。

### 6.4 宠物状态派生

宠物状态不再命令式设置，改为派生：

```
petState = f(taskPhase, hasUnread, bridgeConnected, justConnectedWithin(3s))
```

`thinking` 是 `taskPhase` 处于 working 的自然结果，`happy` 是刚连上 3 秒窗口内的自然结果。`shouldForceThinking` 补丁与 `happyAfterConnectTimer` 的竞态因此不存在。用户可见行为不变。

### 6.5 发送可靠性（Outbox）

首版不自创发送队列，移植 web 端 `packages/web/src/lib/store/outbox.ts` 的语义：

- 每条发出的消息带一个 `clientMsgId`（UUID）。服务端收到后回 `message-ack`，携带 `clientMsgId`、服务端 `id` 与 `seq`。
- 条目状态 `pending | sent | failed`，重试策略 `auto | manual | never`。
- `ACK_TIMEOUT_MS = 15000`：超时未收到 ack 即判定失败。
- `MANUAL_WINDOW_MS = 120000`：manual 策略的时效窗口，超过则不再自动补发，避免把两小时前的消息突然发出去。
- **`transmittedAt` 与 `createdAt` 必须分开**：前者是 ack 超时预算的起点，后者记录用户的发送意图有多旧。合用一个字段会让每次重传都顺延时效窗口，manual 消息永不过期——web 端的注释专门记了这个坑，移植时照搬，不要"简化"。
- 重连成功后 `flush()` 全量补发可发送条目；用户点单条重试时只动那一条。

鸿蒙端的差异：web 端持久化到 `localStorage`（`PERSIST_MAX_BYTES = 262144` 上限），鸿蒙端持久化到应用沙箱首选项，容量上限沿用同一数值以保持行为一致。

## 7. UI

### 7.1 断点

沿用 Tailscale-OHOS 的 `ResponsiveLayout`：600 / 840 vp 三档。**按窗口宽度而非设备类型判断**——鸿蒙 PC 窗口可自由缩放，折叠屏会中途展开，只有纯视口规则在这些场景下不会失灵。

| 断点 | 场景 | 会话切换 | 宠物 |
|---|---|---|---|
| COMPACT `<600vp` | 手机竖屏、折叠屏外屏 | 底部半模态 `bindSheet`（拇指可达） | 顶栏 mini |
| MEDIUM `600–840vp` | 折叠屏内屏、小平板、手机横屏 | 左侧常驻会话列表 | 顶栏 mini |
| EXPANDED `≥840vp` | 平板横屏、鸿蒙 PC 窗口 | 左侧常驻会话列表 | 顶栏 mini |

EXPANDED 下聊天内容宽度封顶 1240vp，两侧留白——否则窗口拉宽后气泡跟着拉长，一行几十字无法阅读。

同一份 `SessionStore` 支撑两种会话切换壳。

### 7.2 页面结构（COMPACT）

```
Index
├─ LoginGate      无 token 时全屏；POST /api/auth/verify 验证后存入首选项
├─ 顶栏           PetMini + 会话名（点击唤起半模态）+ 连接状态徽标 + 设置
├─ MessageList    LazyForEach 懒加载，历史向上分页
└─ MessageInput   多行输入、发送（首版无附件上传）
```

相对 web 移动端顶栏的五个控件（PetMini / 会话下拉 / 工作区 / 搜索 / 设置），首版降为三项——工作区与搜索不在范围内。将来加回时走底部导航，不再挤顶栏。

新增常驻连接状态徽标（已连接 / 重连中 / 未登录）：后台保活本就不稳，连接状态必须始终可见。

### 7.3 markdown 渲染

拆成两半，这是能否测得动的关键：

- `parseMarkdown(text): MdNode[]` —— 纯函数，零 ArkUI 依赖，单测覆盖
- `MarkdownView` —— 只负责把 `MdNode[]` 摆成组件树

支持子集：标题、段落、有序/无序列表、粗体、斜体、行内代码、代码块、链接、图片、引用、表格。代码块首版不做语法高亮：等宽字体 + 横向滚动 + 右上角复制按钮。

**回复到达有两条路径，首版设计时搞错过，这里更正**：

1. **真流式**：部分 bridge 会持续下发 `bridge:stream-delta`。此时累积纯文本、不解析 markdown（每几十毫秒重解析整段会掉帧），`bridge:stream-done` 时做一次完整解析。
2. **整块到达**：cc-connect 的 claudecode 回复**没有 token 级流**（它未向 Claude CLI 传 `--include-partial-messages`，见 `packages/web/src/lib/typewriter.ts` 的注释），回复是一整块 `bridge:message`。web 端为此写了 `typewriter.ts`，把已经完整的文本逐字揭示出来，纯粹是视觉效果。

**鸿蒙端首版不实现本地打字机**：它不传递任何信息，只是把已到达的内容延迟呈现给用户。整块到达即直接渲染 markdown。若日后觉得少了"活着"的感觉再补——`typewriter.ts` 的实现可以直译，且因为提交的最终文本与原文逐字节相同，补它不影响持久化与历史。

### 7.4 slash command

命令来源三处，在 `logic/slashCommands.ets` 里合并：

| 来源 | 类型 | 行为 |
|---|---|---|
| 内置命令（`/clear` `/settings` `/connect` `/disconnect`） | `local` | 客户端自己执行，不发给 bridge。`/connect` `/disconnect` 调 `/api/bridges/:id/(dis)connect` |
| cc-connect 会话与 agent 命令（`/new` `/list` `/model` `/mode` 等） | `send` | 原样作为消息发出 |
| skills 动态命令 | `send` | 由 `bridge:skills-updated` 事件推送，随 bridge 变化 |

输入框内容以 `/` 开头时，在输入框**上方**弹出候选浮层（手机上输入框贴近键盘，浮层向下会被键盘遮挡），按分类分组、前缀匹配过滤，点击即填入。

合并、匹配、分类排序全部在纯函数内完成，浮层组件只渲染结果。

## 8. 错误处理与降级

| 情况 | 行为 |
|---|---|
| 401 | 清 token，弹回 LoginGate，不静默重试 |
| WS 断开 | 徽标转「重连中」，输入框保持可用，消息进 Outbox，重连后 `flush()` 按序补发 |
| ack 超时（15s） | 条目转 `failed`，气泡标红 + 重试按钮。`auto` 策略自动补发，`manual` 仅在 120s 时效窗口内补发 |
| 载荷过大未能持久化 | 标记 `payloadDropped`，重启后明确告知该条无法续发，而不是假装还在队列里 |
| 图片 / 宠物图拉取失败 | 回落内置 5 张 PNG；宠物图按 token 缓存至应用沙箱（对应 web 的 localStorage 缓存） |
| 历史补齐失败 | 顶部提示条 + 手动重试，不阻塞当前会话 |

## 9. 测试

- **ArkTS 单测**（`@ohos/hypium`，hvigor LocalTest）覆盖 `logic/` 全部纯函数：`parseMarkdown`、`normalizeEvent`、`derivePetState`、`backoff`、`slashCommands`、`outbox`。把逻辑从 UI 抽出来的回报即在此。
- **协议对齐测试**：见 5 节，跑在 `pnpm test` 内。
- **真机探针**：照 Tailscale-OHOS 的路子，但用 **bash 而非 PowerShell**（开发主力在 macOS）。四条：登录、收发、断网重连、后台通知。

## 10. 风险

| 风险 | 应对 |
|---|---|
| 本地通知到达率不足（应用被系统回收） | 首版接受。`NotificationGateway` 已接口化，切 Push Kit 不动业务层 |
| markdown 渲染器是最大单点工作量 | 子集受控，纯函数可测；复杂语法（嵌套列表、HTML 内联）首版直接降级为纯文本显示 |
| 签名证书需新申请（bundleName 不同，无法复用 Tailscale-OHOS 的） | 实现前先跑通空工程的签名安装，避免临到真机验证才发现卡住 |
| ArkTS WebSocket 在后台被系统冻结的时机不可控 | 属于既定约束，靠重连 + 历史补齐兜底，不与系统对抗 |
| **web 端仍在高速演进**：两个月内 115 个提交，期间协议新增 2 个事件、消息与会话类型各加若干字段 | 协议漂移守卫（第 5 节）是硬保障，必须每次 `pnpm test` 都跑。语义层面的漂移（如未读从本地判定改为服务端驱动）守卫抓不到，需在每个里程碑开始前重读 `packages/web/src/lib/store/` 与 `packages/shared/src/types/` |

## 11. 首版之后

按优先级：**附件上传**（对齐 `attachment-upload.ts` 的流式分片与三种中间态）→ Push Kit 推送（在服务端已有的 web-push 链路上加一个 provider）→ 卡片/按钮/音频等富消息形态 → 全文搜索 → workspace 文件与 git 浏览 → AI 用量面板 → 桌面卡片与实况窗（需官方 LiveView 权限）。

可选的小补充：本地打字机（直译 `typewriter.ts`），纯视觉，随时可加。
