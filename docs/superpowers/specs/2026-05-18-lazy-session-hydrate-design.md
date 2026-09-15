# 启动期会话懒加载

**日期：** 2026-05-18

## 背景

cc-pet-web 在用户首次打开 web 时启动较慢。性能瓶颈位于
`packages/web/src/lib/hydrateFromServer.ts:104-161` 的 `hydrateSessionsAndHistory`：

- 对每个 connection，**串行** 执行：先拉 `/api/sessions?connectionId=...` 拿到
  session 列表，然后对每个 session 都调用一次 `/api/history/:chatKey` 拉全量历史。
- 全部完成前，`packages/web/src/App.tsx:522` 的 `if (!ready) return null` 阻塞 UI。
- session 数为 N 时，启动至少要做 N+1 次顺序请求。

实际上启动只需要展示「当前活跃 session」的内容，其它 session 历史完全可以在用户
点击切换时再拉。

## 目标

- 启动期请求数从 N+1 降到 2（无论有多少 session）。
- 用户切换到尚未加载的 session 时，按需拉取一次历史；已加载过的 session 在
  本次会话期内不再重复拉取，由 WebSocket 增量更新维持同步。
- UI 阻塞行为保持不变（hydrate 完成前 `ready=false`），但 hydrate 的"完成"语义
  变为：会话列表 + 当前活跃 session 历史 已就绪。

## 方案

### 启动 hydrate（重写 `hydrateSessionsAndHistory`）

对每个 connection：

1. 拉取 `/api/sessions?connectionId=...`，得到 `Session[]`（轻量元数据）。
2. 决定本连接的"活跃 session"：
   - 优先使用 `useSessionStore.activeSessionKey[connectionId]`（来自 localStorage 持久化），
     条件：该 key 存在于 server 返回的 session 列表中。
   - 否则使用列表里 `lastActiveAt` 最大的一项。
   - 否则若列表为空则跳过本连接（保留现有 orphan-default 处理：当 server 没有
     session 但 `default` chatKey 还有历史消息时，临时合成一个 default session）。
3. 仅为「活跃 session」拉一次 `/api/history/:chatKey`，写入 message store，并把
   chatKey 标记为已加载。
4. 把会话列表写入 session store；其它 session 不预取历史。

orphan-default 兜底：现有逻辑保留，但只针对"活跃 session 是否落到 default"做
判断；不再为了检测 orphan 而强制拉一次 default 的历史（如果 default 不是活跃
session，跳过即可，让懒加载机制处理）。

### 默认聚焦（`applyDefaultFocusAfterHydrate`）

当前实现依赖 `messagesByChat` 里有消息来挑"最新有消息的 session"。懒加载后大部分
session 没加载消息，需要改造：

- 每个连接的默认 active session：优先用 localStorage 持久化值；否则用
  server 返回的 `session.lastActiveAt` 最大者；否则 `list[0]?.key ?? "default"`。
- 全局 active connection：优先用 store 当前的 `activeConnectionId`；否则选
  各连接 `max(lastActiveAt)` 最大的那个连接。
- 不再调用 `pickLatestMessagedSessionForConnection` / `pickLatestMessagedChat`。

### Message store 加载追踪

`packages/web/src/lib/store/message.ts` 新增：

- `loadedChatKeys: Set<string>`（普通 Set，存于 store state）。
- `markChatLoaded(chatKey)` / `isChatLoaded(chatKey) => boolean`。
- `setMessages` 仍只写 messages，不动 loadedChatKeys。loaded 标记由调用方在
  fetch 成功后显式 mark；这样测试代码 pre-seed 消息时不会被误判为"已加载"
  从而错过实际 fetch。
- `purgeChat(chatKey)` 同时清掉 loaded 标记，让删除的 session 重建后能重新拉。

新增 thunk：`ensureChatLoaded(chatKey)`：
- 如果已 loaded，直接返回。
- 否则用当前 platform adapter 拉 `/api/history/:chatKey`，写入消息，mark loaded，
  并在 session store 上 sync auto title。
- in-flight 去重：用一个模块级 `Map<chatKey, Promise<void>>`，并发调用复用同一个
  Promise。

放在 `packages/web/src/lib/hydrateFromServer.ts` 里以复用 platform adapter，
导出 `ensureChatLoaded`。

### Session 切换触发懒加载

`packages/web/src/lib/store/session.ts` 的 `setActiveSession`：
- 先持久化 active map（保持现有行为）。
- 在 set 之后调用 `ensureChatLoaded(makeChatKey(connectionId, key))`（fire-and-forget，
  不 await，错误打日志）。

注意：session store 不能直接 import platform adapter（会形成循环）。把
`ensureChatLoaded` 实现放在 `hydrateFromServer.ts`，session store 通过一个轻量
"加载回调"注册的方式调用：

- `hydrateFromServer.ts` 在 hydrate 时调用 `useSessionStore.getState().setLazyLoader(loader)`，
  传入一个 `(chatKey: string) => Promise<void>` 闭包（已捕获 adapter）。
- session store 增加 `lazyLoadChat?: (chatKey: string) => Promise<void>`，
  `setActiveSession` 末尾若存在则触发。
- 这样依赖方向仍是 hydrate -> session store，无循环。

### UI 状态指示

按照已确认的"继续阻塞"策略：
- 保持 `App.tsx` 现有 `if (!ready) return null`，hydrate 完成后才渲染。
- 切换 session 期间不阻塞主 UI；ChatWindow 在 `messagesByChat[chatKey]` 为
  undefined 但 `loadedChatKeys` 不含此 key 时，可显示一个轻量"加载中"占位
  （如沿用现有空态文案即可，不引入新组件）。

### SessionDropdown 时间显示兜底

`packages/web/src/components/SessionDropdown.tsx:50-58` 的 `lastMessageOrCreatedAt`
当前在消息为空时回退到 `createdAt`。改为：消息为空时回退到 `session.lastActiveAt`，
后者在 server 端由 cleanup/touch 维护，更接近"最近一条消息时间"。

### Server 端

不修改 server。`/api/sessions` 和 `/api/history/:chatKey` 已经满足需求；
`session.lastActiveAt` 也已经存在。

## 影响

- 启动请求数：N+1 → 2（每个 connection 2 次：sessions + 当前 session 的 history）。
- 切换到未加载 session 时多 1 次请求；切换回已加载 session 时 0 请求。
- WebSocket 增量更新逻辑不变。
- 已写入消息的 session（包括 pre-seeded 测试场景）不会被误判，因为 loaded 标记
  是显式的。

## 测试要点

- 单 connection 多 session：启动后只有"活跃 session"消息存在，列表完整；点击其它
  session 后历史出现并不再重复拉取。
- localStorage 中的 active session 在 server 列表中已被删除：回退到 `lastActiveAt`
  最大者。
- 列表为空但 default chatKey 有 pre-seeded 消息（现有 orphan 测试）：不破坏。
- 切换 session 期间网络失败：抛错被捕获，不阻塞 UI；下次切换可重试。
- 删除 session 后重建同名 key：`purgeChat` 已清 loaded 标记，重新拉历史。

## 不做

- session 内部消息分页（用户已拒绝）。
- 启动并发拉取所有 history（用户已拒绝）。
- 骨架屏（用户选择"继续阻塞"）。
