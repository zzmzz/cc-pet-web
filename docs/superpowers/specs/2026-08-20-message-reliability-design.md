# 消息可靠性：id 唯一化、发件队列与断线补齐

**日期：** 2026-08-20

## 背景

移动端在网络不稳时会丢消息，双向都有：用户发出的消息消失，Claude 的回复也收不到。
排查后确认这不是一个问题，而是三层独立成因叠加，其中最严重的一层与网络无关。

### 成因一：服务端 message id 碰撞（数据库层真丢失）

`packages/server/src/storage/messages.ts:25` 的写入语句是：

```sql
INSERT OR REPLACE INTO messages (id, chat_key, role, content, timestamp, ...)
```

而所有消息的 id 都由毫秒时间戳拼成 —— `msg-${Date.now()}`，共 8 处：
`packages/server/src/index.ts:270,312,336,367,378,427,476` 与
`packages/server/src/api/siri.ts:50`。

两条消息只要落在**同一毫秒**，id 就完全相同，`OR REPLACE` 会让后者静默覆盖前者。
Bridge 连续推送（例如工具调用回显紧跟文本回复）时这非常容易触发。
消息在数据库层被销毁，任何客户端重试都找不回来。

附带问题：`packages/server/src/storage/messages.ts:31` 查询用
`ORDER BY timestamp ASC`，没有次级排序键，同毫秒消息的返回顺序不稳定。

### 成因二：上行静默丢弃

`packages/web/src/lib/web-adapter.ts:215-224`：

```js
sendWsMessage(msg) {
  if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return; }
  console.error("[cc-pet] ws send skipped: socket is not open", ...);
}
```

socket 不处于 OPEN 时消息直接丢弃，只写一行 console。没有队列、没有重试，
UI 上也没有任何失败提示，用户无法察觉自己的消息从未发出。

### 成因三：重连后不补齐下行

WebSocket 重连本身是健全的（指数退避 + `online` 事件监听，
`packages/web/src/lib/web-adapter.ts:106,119`），但重连成功后不会重新拉取历史。
`/api/history/:chatKey` 在非测试代码中只有两个调用点：
`packages/web/src/lib/hydrateFromServer.ts:98`（启动时）和
`packages/web/src/components/ChatWindow.tsx:109`（切换会话时）。

因此断线期间服务端收到并已入库的消息，客户端不会回头去取，用户永远看不到
（手动切换会话再切回可以让它们出现，这也印证了数据其实在库里）。

该接口目前还是无分页全量返回（`packages/server/src/api/history.ts:5-7`），
不能直接用于频繁的重连补齐。

## 目标

- 消息不再因 id 碰撞被覆盖，任意两条消息在库中都能共存
- 断线期间用户发出的消息不丢失，且发送状态在 UI 上可见
- 重连后自动补齐断线期间产生的下行消息，代价与断线时长成正比而非与会话长度成正比
- 重发不产生重复消息
- 控制类指令（如 `/stop`）不被错误重放

## 方案

### 一、消息 id 与顺序（服务端）

**id 唯一化。** 全部 8 处生成点改用 `randomUUID()`。上行消息优先采用客户端提供的
`clientMsgId`（见第二节），使客户端重发天然幂等。传给 bridge 的 `msg_id`
沿用同一个值，保持 `replyCollector` 的关联逻辑不变。

**写入语义改为 upsert。** 把 `INSERT OR REPLACE` 改成
`INSERT ... ON CONFLICT(id) DO UPDATE SET content=..., extra=...`。
`OR REPLACE` 实际执行 DELETE + INSERT，会让行的 rowid 变化；改成 upsert 后
rowid 与下面的 `seq` 都保持稳定，重发同一条消息不会改变它在序列中的位置。

**引入单调序列 `seq`。** `messages` 表新增 `seq INTEGER` 列，作为增量拉取的游标。

- 由服务端进程内单调计数器分配，启动时以 `MAX(seq)` 初始化（单进程 SQLite，无并发分配问题）
- upsert 更新既有消息时不重新分配，保留原值
- 新增复合索引 `(chat_key, seq)`；现有仅有 `chat_key` 单列索引
- 查询排序改为 `ORDER BY seq ASC`，顺序稳定
- 迁移：先加可空列，按 `ORDER BY timestamp ASC, rowid ASC` 回填历史行，再建索引。
  不能单按 `rowid` 回填 —— 历史上的 `OR REPLACE` 会重新分配 rowid，被更新过的旧消息
  rowid 已被抬到末尾，只按 rowid 回填会让既有消息的展示顺序发生错乱

**为什么不用现成的东西当游标：** SQLite 隐式 rowid 会被 `OR REPLACE` 改变，
一条消息被更新后会跳到序列末尾，游标就会漏掉中间的消息；`timestamp` 有同毫秒
碰撞，用作游标会在边界上丢消息。两者都不可靠，因此需要显式的 `seq`。

### 二、上行发件队列（客户端）

**客户端生成 id。** 发送前用 `crypto.randomUUID()` 生成 `clientMsgId`，随 WS
载荷发出。这是一处协议变更：现在的上行载荷不含 id 字段。

**Outbox。** 新增队列条目 `{ clientMsgId, payload, policy, status, createdAt, retryCount }`，
`status` 取 `pending | sent | failed`。发送时先入队并渲染为 `pending`，
`sendWsMessage` 不再静默丢弃：socket 未就绪即留在队列中。

**重发策略必须分级。** 这是本设计的关键约束 —— 五个发送点语义不同，统一重发会造成危害：

| 调用点 | 内容 | 策略 |
|---|---|---|
| `ChatWindow.tsx:201` | `SEND_MESSAGE` 普通文本 | `auto` |
| `ChatWindow.tsx:179` | `SEND_FILE` 带文件 | `auto` |
| `ChatWindow.tsx:282` | `SEND_MESSAGE` 内容为 `/stop` | **`never`** |
| `AskQuestionCard.tsx:66` | 回答 Claude 的提问 | `manual` |
| `CardMessage.tsx:30` | 卡片交互回复 | `manual` |

- `never`：`/stop` 是控制指令。断线时入队、恢复后重放会掐掉一次全新的生成。
  不入队，socket 未开直接提示失败。
- `manual`：卡片与提问的回复绑定特定上下文，超过 2 分钟窗口后该上下文可能已失效，
  自动重放会答到错误的地方。超窗即转 `failed`，由用户决定是否重试。
- `auto`：重连后按入队顺序自动 flush。

`sendWsMessage` 签名增加**必填**的 policy 参数，五个调用点逐一显式声明，
不设隐式默认值，避免新增发送点时无声继承错误策略。

**确认与超时。** 新增 WS 事件 `MESSAGE_ACK`，服务端 save 成功后回
`{ clientMsgId, seq }`，客户端据此把 outbox 条目转为 `sent`。
15 秒未收到 ack 转 `failed`，UI 给重试入口。

**ack 不得推进下行水位。** ack 里的 `seq` 只用于标记该条目已入库，绝不能用来抬高
第三节的下行水位线。因为断线期间服务端可能已产生若干 assistant 消息占用了中间的
seq：若水位=10、断线期间产生 11-14、用户重连后发的消息拿到 seq=15，一旦用 ack 的
15 推进水位，11-14 就永远不会被拉取。下行水位只能由 history 拉取结果和 WS 推送的
消息推进。

**持久化。** outbox 落 localStorage，使 app 被系统回收后仍能续发。
`SEND_FILE` 的载荷含 base64 文件，体积大，超过 256KB 的条目只保留在内存中不做持久化，
避免重演 localStorage 配额被挤爆的问题（宠物图正是这么把 5MB 配额吃满的）。
这类条目在页面重载后无法续发，恢复时直接标记为 `failed` 并提示用户重新选择文件发送，
不静默丢弃。

**UI。** `pending` 半透明加时钟图标，`failed` 标红并提供重试按钮。

### 三、下行增量补齐

**服务端。** `/api/history/:chatKey` 增加 `afterSeq` 与 `limit` 参数，返回
`{ messages, hasMore }`。`limit` 仅在传了 `afterSeq` 时生效（缺省 200）；不传
`afterSeq` 时保持现有的无分页全量返回，使启动与切换会话的行为完全不变。

**客户端。** 按 chatKey 维护水位线（已收到的最大 `seq`）。WS `onopen` 且判定为重连时，
对当前活跃 chatKey 拉 `afterSeq=<水位>`，`hasMore` 为真则继续翻页直到追平。
非活跃会话不在重连时拉取，等切换过去时按同一路径补齐。

**下行推送必须携带服务端 id 与 seq。** 客户端目前给每条下行消息现编一个本地 id
（`packages/web/src/App.tsx:248,300,322,364,389` 的 `msg-${Date.now()}`），与服务端入库的
id 毫无关系。若不改，补齐拉回的同一条 assistant 消息会因 id 不同被当成新消息，界面上重复一次。
因此 `BRIDGE_MESSAGE` / `BRIDGE_STREAM_DONE` / `BRIDGE_FILE_RECEIVED` / `BRIDGE_CARD` /
`BRIDGE_AUDIO` 五个推送的 payload 都加上 `msgId` 与 `seq`，客户端直接采用。
`BRIDGE_BUTTONS` 服务端本就不入库，保持纯本地消息。

合并时按消息 `id` 去重 —— 上行消息入库时用的就是客户端生成的 `clientMsgId`，下行消息用的是
服务端下发的 `msgId`，两侧 id 都相同，不会重复显示。

去重后按 `timestamp` 排序、`seq` 打破同毫秒的平手。不能单按 `seq`：`BRIDGE_BUTTONS`
这类纯本地消息没有 `seq`，会被塌到序列最前。把 `timestamp` 当排序键与前面否定它当
**游标**并不矛盾 —— 同毫秒碰撞会让游标漏消息，但对展示顺序无害。

## 影响

服务端：
- `packages/server/src/storage/db.ts` — schema 加 `seq` 列与 `(chat_key, seq)` 索引、迁移回填
- `packages/server/src/storage/messages.ts` — upsert 语义、seq 分配、排序、增量查询
- `packages/server/src/index.ts` — 8 处 id 生成、上行采用 clientMsgId、回 `MESSAGE_ACK`、
  五个下行推送带上 `msgId` / `seq`
- `packages/server/src/api/history.ts` — `afterSeq` / `limit` / `hasMore`
- `packages/server/src/api/siri.ts` — id 生成

共享：
- `packages/shared/src/constants/events.ts` — 新增 `MESSAGE_ACK`
- `packages/shared/src/types` — 上行载荷加 `clientMsgId`，消息类型加 `seq`

客户端：
- `packages/web/src/App.tsx` — 五处下行消息改用服务端下发的 `msgId` / `seq`
- `packages/web/src/lib/web-adapter.ts` — 队列化发送、policy 参数、重连补齐钩子
- `packages/web/src/lib/platform.ts` — `sendWsMessage` 接口签名
- 新增 outbox store（`packages/web/src/lib/store/`）
- `packages/web/src/components/ChatWindow.tsx`、`AskQuestionCard.tsx`、`CardMessage.tsx` — 声明策略
- 消息列表组件 — `pending` / `failed` 状态呈现

## 测试要点

- 同一毫秒连续写入两条消息，两条都能查到，均不被覆盖
- 对同一 id 重复 save，消息内容更新但 `seq` 不变、不产生重复行
- socket 关闭时发送普通消息 → 渲染为 `pending`；重连后送达且服务端只有一条
- socket 关闭时点停止 → 不入队，给出失败提示；重连后不发出 `/stop`
- 卡片回复入队后超过 2 分钟窗口 → 转 `failed`，不自动重放
- 断线期间服务端产生若干 assistant 消息 → 重连后自动出现，顺序正确
- 已经在界面上的 assistant 消息 → 补齐后不重复渲染
- 没有 `seq` 的纯本地消息 → 合并后仍在正确的时间位置
- 断线期间既产生了 assistant 消息、重连后用户又发了消息 → 收到 ack 后
  中间那批 assistant 消息仍能被补齐（回归 ack 抬高水位导致漏取的场景）
- 断线期间积压超过 `limit` → 分页循环直至追平
- 不传 `afterSeq` 的历史请求仍返回全量，启动与切换会话行为不变
- 迁移后既有消息的 `seq` 单调且与原 `timestamp` 顺序一致

## 不做

- 不做图片体积与 Cache Storage 迁移。已单独规划为第二轮，与本轮无耦合。
- 不做 iOS 原生外壳。待本轮与第二轮上线后重新评估是否仍有必要。
- 不做多端已读同步、消息撤回、端到端加密。
- 不改动 bridge 协议本身，`msg_id` 语义保持不变。
