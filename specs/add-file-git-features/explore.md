# Explore: 文件列表与 Git 变更查看

**Workspace**: `add-file-git-features`  
**Date**: 2026-05-12  
**Spec**: [spec.md](spec.md)

---

## 配置与连接事实

- **[事实]** `BridgeConfig` 目前只包含 `id/name/host/port/token/enabled`，没有工作区路径字段；类型定义位于 `packages/shared/src/types/config.ts` 的 `BridgeConfig`。
- **[事实]** 服务端配置由 `ConfigStore.load()` 读取，优先读取 `CC_PET_DATA_DIR` 下的 `cc-pet.config.json` 或显式 `configFilePath`，否则读取 SQLite `config` 表；实现位于 `packages/server/src/storage/config.ts` 的 `ConfigStore`、`normalizeAppConfig()`、`normalizeBridge()`。
- **[事实]** `/api/config` 直接返回 `store.load()`，`PUT /api/config` 直接保存 `AppConfig`；路由位于 `packages/server/src/api/config.ts` 的 `registerConfigRoutes()`。
- **[事实]** WebSocket 初始化时，服务端将授权 token 可见的 bridge 列表发送给前端，当前 manifest 只包含 `{ id, name }`；实现位于 `packages/server/src/index.ts` 的 `hub.onClientConnected`。
- **[事实]** 前端连接状态只保存 `id/name/connected`，活跃连接存储在 localStorage key `cc-pet-active-connection-id`；实现位于 `packages/web/src/lib/store/connection.ts` 的 `ConnectionInfo` 和 `useConnectionStore`。
- **[推断]** 每连接工作区最自然的 SSoT 是 `BridgeConfig.workspacePath?: string`：配置本来已按 bridge/connection 建模，`connectionId` 与 `BridgeConfig.id` 一一对应；服务端已有按 `connectionId` 查找 bridge 的模式，见 `packages/server/src/index.ts` 中 `/api/bridges/:id/connect`。

## 认证与边界

- **[事实]** `authGuard()` 保护所有 `/api/*` 与 `/ws` 请求，并把 token 对应的 `bridgeIds` 存入 request weak map；实现位于 `packages/server/src/middleware/auth.ts`。
- **[事实]** 多个现有接口按 `connectionId` 工作，但部分 session/search 接口当前没有逐接口校验 `connectionId` 是否在 token 授权列表中；`packages/server/src/api/search.ts` 和 `packages/server/src/api/sessions.ts` 是现状参考。
- **[推断]** 新增工作区文件/Git API 需要比 session/search 更严格：每个请求必须先通过 `getRequestAuthIdentity(req)` 校验当前 token 是否拥有该 `connectionId`，再解析对应 `workspacePath`，否则本地文件系统能力会扩大权限面。
- **[事实]** 现有文件上传接口 `registerFileRoutes()` 仅管理 `dataDir/files` 下的聊天附件，不涉及项目工作区，也没有路径穿越防护需求；位于 `packages/server/src/api/files.ts`。
- **[推断]** 新增项目文件 API 不应复用 `/api/files` 命名，避免和聊天附件语义混淆；应使用独立 `/api/workspaces/:connectionId/...` 命名。

## 服务端 API 与运行时约束

- **[事实]** 服务端是 Fastify ESM 应用，路由集中在 `packages/server/src/api/*.ts`，由 `packages/server/src/index.ts` 注册。
- **[事实]** 项目依赖中没有 Git 封装库；`packages/server/package.json` 依赖包括 Fastify、better-sqlite3、ws 等，但没有 `simple-git`。
- **[推断]** Git 状态和 diff 可通过 Node 标准库子进程调用 `git` 完成，避免新增依赖；执行时必须使用参数数组而非 shell 字符串，并设置超时和输出大小上限。
- **[推断]** 文件路径应在服务端统一按“连接工作区根 + 相对路径”解析，拒绝绝对路径、`..` 越界、真实路径落在工作区外的 symlink 目标，以及未配置/不存在的工作区。
- **[推断]** 文件读取需要区分文本、二进制、过大文件和不可访问文件；首版可优先支持 UTF-8 文本查看/编辑，二进制和超大文件返回不可预览状态。

## 前端现状与集成点

- **[事实]** 前端通过 `PlatformAPI.fetchApi()` 统一请求服务端；定义位于 `packages/web/src/lib/platform.ts`，浏览器实现位于 `packages/web/src/lib/web-adapter.ts`。
- **[事实]** `Layout` 的桌面侧栏包含 `SearchPanel`、`SessionDropdown` 和一个空的 `flex-1 overflow-y-auto` 区域；适合作为工作区面板入口，见 `packages/web/src/components/Layout.tsx`。
- **[事实]** 移动端布局顶部已有搜索和设置按钮，主体区域由 `children` 占满；见 `packages/web/src/components/Layout.tsx`。
- **[事实]** 当前主要业务状态通过 Zustand store 管理并从组件中消费，例如 `useSearchStore` 位于 `packages/web/src/lib/store/search.ts`，`useConnectionStore` 位于 `packages/web/src/lib/store/connection.ts`。
- **[推断]** 文件树、打开的文件、Git 状态和 diff 适合新增独立 `workspace` store，避免塞进 connection/session store。
- **[推断]** 文件内容和 diff 不宜直接塞进现有聊天主区域；更稳妥的方案是在 Layout 中新增可关闭的工作区查看器面板，与 ChatWindow 并列展示，避免影响聊天输入与消息滚动。

## 测试事实

- **[事实]** 根 `test:e2e` 脚本运行 server e2e 和 web 集成测试：`package.json` 的 `test:e2e`。
- **[事实]** 服务端测试已有临时配置文件模式：`packages/server/tests/storage.test.ts` 用 `ConfigStore(db, { configFilePath })` 覆盖配置读取；`packages/server/tests/e2e-connect-regression.test.ts` 在临时 `CC_PET_DATA_DIR` 写入 `cc-pet.config.json`。
- **[事实]** 前端集成测试用 `FakeAdapter` mock `PlatformAPI.fetchApi()` 与 WebSocket 事件；位于 `packages/web/src/App.integration.test.tsx`。
- **[事实]** Layout 测试直接渲染 `Layout` 并检查桌面/移动布局；位于 `packages/web/src/components/Layout.test.tsx`。
- **[推断]** 新增测试应覆盖：配置归一化保留 `workspacePath`；未授权 connectionId 被拒绝；路径越界被拒绝；文件树/读写/重命名/删除；Git 非仓库空态与仓库 status/diff；前端切换连接时重新拉取对应工作区。

## 决策收敛

- **[推断]** 配置字段最终采用 `workspacePath`。依据是 `BridgeConfig` 已是连接级配置 SSoT，且字段语义比 `cwd` 或 `projectPath` 更明确；保持可选即可兼容已有配置。依据文件：`packages/shared/src/types/config.ts` 的 `BridgeConfig`、`packages/server/src/storage/config.ts` 的 `normalizeBridge()`。
