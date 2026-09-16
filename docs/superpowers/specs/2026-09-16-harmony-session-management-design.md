# 鸿蒙客户端会话管理设计

**日期：** 2026-09-16
**状态：** 待实现
**前置：** `2026-09-15-harmony-client-design.md`（首发版本，已合并）
**对齐目标：** `packages/web` 的会话能力
**约束：** 服务端零改动（沿用首发版本的定义性约束）

---

## 1. 背景

首发版本的鸿蒙客户端**只建模了「连接」，没有建模「会话」**。真机验证暴露出两个症状，根因是同一个：

- **会话列表不存在。** `SessionSheet` / `SessionSidebar` 遍历的是 `SessionStore.bridges`，一个 bridge 一行，chatKey 由 `chatKeyForBridge()` 写死为 `${bridgeId}::default`。`GET /api/sessions` 拉回的 `Session[]` 只被 `labelOf()` 拿去当标签，从未被列出。
- **历史拉取不到。** 客户端永远只请求 `${bridgeId}::default` 的历史。用户真实对话若在其他 session key 下，该 chatKey 自然为空。回填机制本身正常——真机上 `claude::default` 的历史能正确回填——它只是在向一个空房间要数据。

web 端的模型是两层：`connection × session`。本设计把鸿蒙端补齐到同一模型。

### 1.1 一个必须先说清楚的发现

`packages/web` 的会话逻辑里有三块 **UI 上不可见、但不照搬就会产生真实缺陷**的机制。它们不在任何组件里，散落在 `lib/web-adapter.ts`、`lib/sessionRouting.ts`、`lib/store/session.ts`：

1. **入站会话路由**（§4）——决定一条不带 `sessionKey` 的回复落到哪个会话。鸿蒙端目前完全没有：`chatKeyOf()` 在 `sessionKey` 缺失时返回空串。今天不可见，因为只有一个 `default` 会话；**一旦支持多会话，回复会串到错误的会话里**。
2. **sticky session**——「本轮对话属于哪个会话」的记忆，使迟到的无 key 回复不会漏进用户刚切换到的新会话。
3. **新建前清残留**——新 key 在服务端没有历史，客户端同名 key 下的旧状态是别的对话的残渣。

这三块是本设计的正确性核心，优先级高于 UI。

---

## 2. 范围

**做：**

- `connection × session` 两层数据模型
- 会话列表、切换、新建、删除
- 常驻会话（resident）的独立入口与服务端权威未读
- 入站会话路由 + sticky session + 残留清理
- 会话自动命名（首条用户消息）
- 切换会话时按需加载该会话历史

**不做（本轮）：**

- 会话手动重命名——web 也只有自动命名，没有手动入口
- 跨连接会话搜索、会话导出
- 富消息渲染、设置面板、附件上传、链接预览——按既定顺序在后续各轮单独立项
- workspace 子系统、音频消息、配额图表、搜索面板——本阶段整体不做

---

## 3. 数据模型

`SessionStore` 从一层扩展为两层。现有字段保留语义，新增：

```typescript
/** 每个连接下的会话列表。当前仅被 labelOf() 使用，本设计起成为列表数据源。 */
@Trace private sessions: Map<string, Session[]>        // connectionId -> Session[]

/** 每个连接各自记住停在哪个会话。缺省 'default'。 */
@Trace private activeSessionKey: Map<string, string>   // connectionId -> sessionKey

/** 无 key 回复的归属记忆。见 §4.2。 */
@Trace private stickySession: Map<string, string>      // connectionId -> sessionKey
```

`currentChatKey` 的推导从写死改为：

```
currentChatKey = chatKeyOf(activeConnectionId, activeSessionKey.get(activeConnectionId) ?? 'default')
```

`TaskStore` 无需改动——它已按 chatKey（即 `connectionId::sessionKey`）存储，天然是每会话一份。

`Session` 类型沿用服务端 `GET /api/sessions` 返回的形状：`key` / `connectionId` / `label?` / `createdAt` / `lastActiveAt` / `isResident`。

---

## 4. 入站会话路由（正确性核心）

### 4.1 解析优先级

镜像 `packages/web/src/lib/sessionRouting.ts` 的 `resolveIncomingSessionRouting`。实现为鸿蒙端 `logic/` 下的纯函数，与既有纯逻辑模块同构，单测覆盖每一条分支：

```
payloadSessionKey > replyCtx > activeSessionKey > knownSessions[0] > 'default'
```

对应的来源标记 `source`：`'payload' | 'reply_ctx' | 'active' | 'known' | 'fallback'`。

`replyCtx` 的解析规则（web 的 `sessionFromReplyCtx`）：

- 必须以 `ccpet:` 开头，否则返回 null
- 去掉前缀后取**最后一个** `:` 之前的部分作为 sessionKey
- 该 key 仅在 `knownSessions` 为空、或 `knownSessions` 包含它时被采纳

`replyCtx` 同时接受 `replyCtx` 与 `reply_ctx` 两种字段名（web 两者都读）。

### 4.2 sticky session

- **写入**：当 `source` 为 `'payload'` 或 `'reply_ctx'`（即会话身份是被明确告知的）时，记录 `stickySession[connectionId] = resolvedSessionKey`
- **读取**：当 `source` 为 `'active'` / `'known'` / `'fallback'`（即只能靠猜）时，若 `stickySession[connectionId]` 存在，用它覆盖解析结果
- **新建会话时**：若离开的会话 key 与新 key 不同、且 sticky 当前为空，则把离开的 key 写入 sticky——否则一条迟到的无 key 回复会跟着 active 指针漏进刚建的新会话
- **删除会话时**：若 sticky 指向被删会话，清除该条

**持久化**：web 用 localStorage 持久化 sticky 与 activeSessionKey（重载后仍在）。鸿蒙端用首发版本已有的 preferences 通道持久化这两张表。

### 4.3 适用事件

路由只作用于携带内容的事件。web 的集合为 11 项：

`bridge:message`、`bridge:stream-delta`、`bridge:stream-done`、`bridge:buttons`、`bridge:file-received`、`bridge:typing-start`、`bridge:typing-stop`、`bridge:preview-start`、`bridge:preview-update`、`bridge:preview-delete`、`bridge:error`

以上 11 项已逐一对照 `packages/shared/src/constants/events.ts` 核验，非臆造。

鸿蒙端首发只消费其中一部分事件；**未消费的事件仍需列入路由集合**，否则后续轮次接入富消息时会遗漏路由。集合本身纳入既有的协议漂移守卫。

**一个待确认的差异：** 常量表里还有两个携带内容的事件——`bridge:audio` 与 `bridge:card`——**不在** web 的路由集合内。它们和 `bridge:message` 一样承载会话内容，按同样的理由本应参与路由。这可能是 web 侧的疏漏，也可能有意为之（例如这两类事件在服务端保证必带 `sessionKey`）。本设计**照 web 现状执行，不擅自扩大集合**，但在实现时需验证这两个事件在鸿蒙端的实际行为；若确认是 web 疏漏，应作为 web 侧缺陷单独上报，而不是在鸿蒙端静默分叉。

---

## 5. UI 形态

照搬 web `SessionDropdown` 的结构，不另行设计。web 呈现的**不是**「所有连接 × 所有会话」的大列表，而是：

1. **常驻会话**单独置顶。它可能挂在任意连接下（不一定是当前激活连接），点击时连带切换连接，并额外发 `POST /api/sessions/:connectionId/:key/read`
2. **当前连接的会话列表**，按「最后一条消息时间，缺失时回退 `lastActiveAt` / `createdAt`」倒序。常驻会话从此列表中剥离
3. 默认只显示 `RECENT_VISIBLE = 2` 条非激活会话，其余折叠进「显示全部」
4. **其他连接**列在下方，点击只切换连接
5. **新建会话**入口
6. **删除**：两段式确认——第一次点击进入确认态，第二次才真正删除。常驻会话不显示删除入口（服务端也会以 403 兜底）

**壳子映射**：COMPACT 装进现有底部半屏面板（`SessionSheet`），MEDIUM/EXPANDED 装进现有左侧栏（`SessionSidebar`）。两个壳子共用同一份行逻辑——`SessionRow.ets` 已是这个结构，扩展它而不是新增第三份实现。

**连接排序**：按该连接下最新消息时间倒序，时间相同则保持 manifest 原序。

---

## 6. 端点

三个端点服务端**均已存在**，客户端首发版本未调用。加入 `model/Endpoints.ets` 后自动被对齐守卫覆盖（含「声明的端点必须有调用者」那条断言）：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/sessions` | 新建会话，body `{connectionId, key, label?}` |
| DELETE | `/api/sessions/:connectionId/:key` | 删除会话（常驻返回 403） |
| POST | `/api/sessions/:connectionId/:key/read` | 标记常驻会话已读 |

新建会话的 key 沿用 web 的生成规则：`session-${Date.now()}`。

**服务端零改动的保证继续成立。**

---

## 7. 启动与历史加载

- **启动**：`bridge:manifest` 到达后，对每个 bridge 拉 `GET /api/sessions?connectionId=…`（首发版本已实现此调用），再应用默认聚焦
- **切换会话**：切换后触发该 chatKey 的历史回填。首发版本的 `HistoryBackfill` 已具备按 chatKey 回填与 `afterSeq` 增量的能力，本设计只是把触发点从「manifest 时的单一 chatKey」扩展到「每次会话切换」
- **新建会话**：先清该 key 的客户端残留（消息、任务状态、未读），再聚焦。新 key 服务端无历史，不触发回填

---

## 8. 未读

首发版本已实现的两套未读权威继续成立并在此扩展：

- 普通会话：本地增量 + 切入时清零
- 常驻会话：服务端 `resident:unread` 为唯一真相，本地增量一律忽略。首发版本此不变量已完整编码但因 `residentKeys` 从未被填充而从未生效——本设计通过真正列出会话使其生效

---

## 9. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 入站路由实现与 web 有偏差 | 回复落到错误会话，用户数据看起来"丢了" | 纯函数 + 逐分支单测；测试用例直接对照 `packages/web/src/lib/sessionRouting.ts` 的分支 |
| sticky 未持久化 | 冷启动后迟到回复错投 | 与 activeSessionKey 一同走 preferences |
| 多会话放大历史回填量 | 首发版本已知的 `MAX_DRAIN_ITERATIONS = 25` 截断风险被放大 | 按需加载（切到才拉），不预拉全部会话 |
| 路由事件集合遗漏 | 后续接富消息时静默漏路由 | 集合纳入协议漂移守卫 |

---

## 10. 验收

- 会话列表在真机上列出某连接的多个会话，切换后该会话历史正确加载
- 新建会话后立即可用，且不含任何前一会话的残留
- 删除非常驻会话生效；常驻会话无删除入口
- 无 `sessionKey` 的回复落入正确会话——需构造真实场景验证，不接受仅单测通过
- 常驻会话未读以服务端为准
- 既有单测与协议守卫保持全绿，服务端仍零改动
