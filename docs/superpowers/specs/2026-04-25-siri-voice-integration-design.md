# Siri 语音集成设计

通过 Apple Shortcuts + cc-pet-web REST API，实现 iPhone 上用 Siri 与 Claude Code 纯语音对话。

## 需求

- iPhone 上对 Siri 说话，消息发送给 Claude Code
- Claude 回复经过智能清洗后由 iOS 系统 TTS 朗读
- 对话历史与 cc-pet-web 网页端共享同一 session
- 可接受 3 秒轮询间隔，最长等待约 90 秒

## 架构

```
用户语音 → Siri(STT) → Apple Shortcut
  → POST /api/siri/send (文字 + token)
  → cc-pet-web Server (注入语音提示词 → bridge → Claude Code)
  → Shortcut 轮询 GET /api/siri/poll?msgId=xxx (每 3 秒)
  → 返回 ttsText
  → iOS 系统 TTS 朗读
```

## 新增 API

### POST /api/siri/send

发送消息并创建回复收集器。

**Headers:** `Authorization: Bearer <token>`

**请求体:**

```json
{
  "content": "今天有什么待办",
  "connectionId": "my-bridge",
  "sessionKey": "default"
}
```

- `connectionId` 可选，默认取 token 关联的第一个 bridge
- `sessionKey` 可选，默认 `"default"`

**响应:**

```json
{
  "msgId": "msg-1714012800-abc",
  "sessionKey": "default",
  "connectionId": "my-bridge"
}
```

**服务端逻辑:**

1. 验证 token
2. 在用户消息前拼接语音模式提示词
3. 通过现有 bridge 通道发送（复用 send-message 逻辑）
4. 创建 ReplyCollector 绑定到该 msgId，监听回复事件
5. 消息写入 SQLite 历史记录（网页端可见）

### GET /api/siri/poll

轮询回复状态。

**参数:** `?msgId=msg-1714012800-abc`

**Headers:** `Authorization: Bearer <token>`

**响应:**

```json
{
  "status": "waiting | streaming | done | error",
  "ttsText": "已经帮你检查了，今天有三个待办事项...",
  "rawLength": 1520,
  "truncated": true
}
```

**状态:**

- `waiting` — 已发送，未收到回复
- `streaming` — Claude 正在流式回复
- `done` — 回复完成，ttsText 已就绪
- `error` — 出错，ttsText 包含错误信息

未知 msgId 返回 404。

## 语音模式提示词

当消息来自 Siri 通道时，服务端在用户消息前自动拼接：

```
[语音模式] 用户正在通过语音与你对话，请注意：
- 回复简洁口语化，控制在3句话以内
- 不要使用Markdown格式、代码块、列表或链接
- 如果涉及代码或复杂内容，只说结论和关键信息
- 用"完成了"、"出错了"等简短状态词汇
```

仅在 Siri 通道注入，网页端不受影响。聊天记录保存用户原始文本（不含提示词）。

## TTS 文本清洗

后处理兜底，防止 Claude 未完全遵守语音模式提示：

1. 去掉代码块（\`\`\`...\`\`\`）→ 替换为"代码已省略"
2. 去掉 Markdown 符号（#、**、\`、> 等）
3. 去掉 URL → "链接已省略"
4. 去掉工具调用/活动日志块
5. 超过 300 字截断 + "详细内容可在聊天记录中查看"

## ReplyCollector

内存中维护两个索引：

- `Map<msgId, Collector>` — 供 poll 接口按 msgId 查询
- `Map<connectionId::sessionKey, Collector>` — 供事件匹配时按 session 定位

匹配逻辑：bridge 回复只携带 `session_key`，不带原始 `msg_id`。由于 Claude Code 每个 session 同一时间只处理一条消息，按 `connectionId + sessionKey` 即可唯一匹配到活跃的收集器。同一 session 有未完成的收集器时，`/send` 返回 409 拒绝新请求。

生命周期：

- 创建于 `/send` 调用时，同时写入两个索引
- 监听 bridge:message、bridge:stream-delta、bridge:stream-done 事件
- 收到 stream-done 或完整 reply 时标记 done，生成 ttsText
- 超过 120 秒未完成自动标记 error（"回复超时"）
- 标记 done/error 后保留 60 秒供最后一次 poll 读取，然后从两个索引中清理
- 同一时间最多 5 个活跃收集器（跨所有 session），超出返回 429

## Apple Shortcut 流程

```
1. Siri 语音输入 → 变量 userText
2. POST /api/siri/send  body: { content: userText }
3. 取返回的 msgId
4. Repeat 循环（最多 30 次）:
   a. Wait 3 seconds
   b. GET /api/siri/poll?msgId=xxx
   c. If status == "done" or status == "error": 退出循环
5. Speak ttsText（iOS 系统 TTS）
```

最长等待约 90 秒。

## 消息来源标记

Siri 发送的消息在 metadata 中标记 `source: "siri"`，与网页消息共存于同一 session。前端可后续添加来源图标区分（非本次范围）。

## 不做的事情

- 不做推送通知（Shortcut 内轮询足够）
- 不做 Siri Intent / App Clip（Apple Shortcuts 够用）
- 不做服务端 TTS（用 iOS 系统 TTS）
- 不做多轮连续对话特殊处理（共享 session 天然支持上下文）
- 不做前端来源图标展示（后续再加）

## 改动范围

1. **服务端 (packages/server):** 新增 `/api/siri/send`、`/api/siri/poll` 路由 + ReplyCollector 模块 + TTS 文本清洗函数 + 语音提示词注入逻辑
2. **Apple Shortcut:** 一个 Shortcut，包含 HTTP 请求 + 轮询循环 + TTS 朗读
