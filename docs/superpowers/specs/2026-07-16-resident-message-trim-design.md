# 常驻会话消息裁剪设计

- 日期: 2026-07-16
- 状态: 已批准，待实现

## 背景与问题

常驻会话（`sessions.is_resident = 1`）在代码里禁止删除（`DELETE /api/history/:chatKey`
对常驻返回 403），因此其消息只增不减。打开常驻会话时刷新很慢，根因在两处均无分页/虚拟化：

1. **服务端** `MessageStore.getByChatKey` 执行 `SELECT * ... ORDER BY timestamp ASC`，无 `LIMIT`，
   一次返回整个会话的全部消息。
2. **前端** `hydrateFromServer` 把整个数组塞进 store，`MessageList`（830 行）直接 `.map()`
   全量渲染，每条还要跑 markdown 解析 + tool-call 渲染，无虚拟列表。渲染是耗时大头。

诊断数据（2026-07-16 生产库）：真正的常驻会话 `bridge::bridge:resident:resident` 当前
237 条 / 0.07MB（7/9~7/14，约每天 50 条），只增不减，数月后必然堆到上万条。

## 决策

- **策略**：自动裁剪——给常驻会话设消息条数上限，超出的老消息直接删除。
- **上限**：500 条（`RESIDENT_MESSAGE_CAP = 500`），约 1~2 周的量，前端渲染流畅。
- **超限处理**：直接从 `messages` 表删除（不归档）。
- **适用范围**：仅常驻会话。普通会话不受影响——它们已有"10 天不活跃整删"机制
  （`SessionsCleanup.cleanupInactiveSessions`）。
- **不做**（YAGNI）：不新增服务端 `getByChatKey` 的 limit、不做前端"向上加载更早"、
  不做归档表、上限不做成可配置项。常驻被 500 封顶、普通会话自删，兜底并非必要。

## 方案

单一改动点：`packages/server/src/cleanup/sessions-cleanup.ts`。不新增定时器、不动 API、不动前端。

### 新增方法 `trimResidentMessages(maxMessages = 500): number`

1. 查所有常驻会话：`SELECT connection_id, key FROM sessions WHERE is_resident = 1`。
2. 对每个会话，用 `@cc-pet/shared` 的 `makeChatKey(connection_id, key)` 拼出 chat_key，执行：

   ```sql
   DELETE FROM messages
   WHERE chat_key = ?
     AND id NOT IN (
       SELECT id FROM messages WHERE chat_key = ?
       ORDER BY timestamp DESC, id DESC LIMIT 500
     )
   ```

   - `timestamp DESC, id DESC`：时间戳相同时用 id 做确定性 tie-break，保证保留的恰是最新 500 条。
   - 全文索引由已有触发器 `messages_fts_ad AFTER DELETE ON messages`（`db.ts:102`）自动清除，
     无需额外处理，删后搜索不会残留幽灵记录。
3. 累加各会话删除条数，返回总数并打印日志。

### 接入调度

复用 `SessionsCleanup.startCleanupSchedule` 里现成的每 24h 任务，在"立即跑一次"与
`setInterval` 回调两处，`cleanupInactiveSessions(...)` 之后各加一行 `trimResidentMessages()`。

### 取舍

- 每天跑一次，两次之间常驻最多涨到 ~550 条（约每天 50 条），渲染无压力，可接受。
- 上限用常量而非配置项。

## 测试

在 `sessions-cleanup` 的单测中新增：

1. 播 600 条常驻会话消息 → 跑 `trimResidentMessages()` → 断言剩最新 500 条、最老的 100 条被删。
2. 断言 `messages_fts` 行数同步降到 500（验证 FTS 触发器联动）。
3. 断言非常驻会话消息一条不少。

## 影响面

- 仅新增一个方法 + 调度里两行接入 + 单测；不改数据库 schema、API、前端。
- 现有生产库首次运行时不会触发裁剪（常驻仅 237 条 < 500）；到达上限后开始生效。
