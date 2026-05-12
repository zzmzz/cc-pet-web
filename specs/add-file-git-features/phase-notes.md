## Phase 0: 连接工作区基础

- **[决策]** 工作区路径统一真实路径化：`resolveConnectionWorkspace()` 返回 `realpath` 后的 `rootPath`，`resolveWorkspacePath()` 对已存在目标同样返回真实路径；后续 API/UI 测试不要假设 macOS `/var` 与 `/private/var` 保持字面一致。
- **[依赖]** 路径安全入口：后续文件/Git API 应通过 `WorkspaceResolutionError.statusCode/code` 映射 HTTP 错误，所有客户端传入路径必须是相对工作区根路径，绝对路径和越界路径会被 resolver 拒绝。
- **[配置]** Phase 0 验证命令：`pnpm --filter @cc-pet/server typecheck`、`pnpm --filter @cc-pet/server exec vitest run tests/storage.test.ts tests/workspace-api.test.ts`、`pnpm test:e2e`。

## Phase 1: User Story 1 - 浏览当前项目文件

- **[依赖]** 工作区只读 API 已注册在 `/api/workspaces/:connectionId`、`/tree`、`/file`；错误响应统一使用 `{ error, message }`，其中 resolver 错误继续透传 `WorkspaceResolutionError.statusCode/code`。
- **[决策]** 文件预览大小上限固定为 `FILE_PREVIEW_MAX_BYTES = 64 * 1024`，大文件返回 `previewable: false` 与 `reason: "FILE_TOO_LARGE"`；后续保存/编辑能力应复用同一上限或显式定义新的编辑上限。
- **[依赖]** 前端 `useWorkspaceStore.loadWorkspace(connectionId)` 会在连接切换时清理当前文件查看器并加载根目录；Phase 2 文件操作完成后应刷新对应目录并保持该 store 的 `treeByConnection[connectionId][path]` 缓存结构。
- **[配置]** Phase 1 验证命令：`pnpm --filter @cc-pet/server typecheck && pnpm --filter @cc-pet/web build`、`pnpm --filter @cc-pet/server exec vitest run tests/workspace-api.test.ts`、`pnpm --filter @cc-pet/web test -- src/components/Layout.test.tsx src/App.integration.test.tsx`、`pnpm test:e2e`。

## Phase 2: User Story 2 - 管理当前项目文件与目录

- **[决策]** 保存文本文件复用 `FILE_PREVIEW_MAX_BYTES = 64 * 1024` 作为内容大小上限，并拒绝编辑当前判定为二进制或超限的文件，避免预览与保存策略不一致。
- **[修正]** 文件预览返回 `etag`，保存时必须带上打开时的 `etag`；服务端写入前重新比对，检测到外部修改时返回 `WORKSPACE_LIST_STALE` 并拒绝覆盖。
- **[决策]** 外部删除、重命名或目标冲突统一向前端暴露“列表已过期，可刷新后继续”的语义；服务端使用 `WORKSPACE_LIST_STALE` 表示源项目已消失，使用 `WORKSPACE_ITEM_ALREADY_EXISTS` 表示目标冲突。
- **[依赖]** Phase 2 文件操作后前端通过 `loadTree(connectionId, parentPath)` 刷新受影响目录；删除当前打开文件或其父目录时会关闭文件查看器，重命名当前打开文件时会同步 viewer 路径。
- **[配置]** Phase 2 验证命令：`pnpm --filter @cc-pet/server typecheck && pnpm --filter @cc-pet/web build`、`pnpm --filter @cc-pet/server exec vitest run tests/workspace-api.test.ts`、`pnpm --filter @cc-pet/web test -- src/components/Layout.test.tsx src/App.integration.test.tsx`、`pnpm test:e2e`。

## Phase 3: User Story 3 - 查看 Git 变更与 Diff

- **[决策]** Git 命令统一由 `runGit()` 使用 Node `spawn("git", args)` 参数数组执行，默认超时 5 秒、输出上限 `GIT_OUTPUT_MAX_BYTES = 128 * 1024`；超限 diff 返回 `DIFF_TOO_LARGE`，二进制 diff 返回 `BINARY_DIFF`。
- **[决策]** 单文件 diff 默认使用 `git diff HEAD -- <path>` 覆盖工作区相对 HEAD 的改动；未跟踪文件用 `git diff --no-index -- /dev/null <path>` 生成新增 diff，保持首版不引入 stage/unstage 概念。
- **[依赖]** 前端文件操作成功后除刷新受影响目录外，也会调用 `loadGitStatus(connectionId)`；`loadGitStatus()` 会把当前 Git 状态重新合并进已缓存文件树条目。

## Phase 4: 总门禁与回归

- **[决策]** 根 `test:e2e` 需要修改：原脚本只覆盖服务端连接回归和 Web `App.integration.test.tsx`，未纳入服务端 workspace API 回归；现已增加 `tests/workspace-api.test.ts`，确保根门禁覆盖新增工作区文件/Git API 链路。
- **[修正]** 根 `test:e2e` 使用 `pnpm --filter ... exec vitest run <files>` 显式选择测试文件，避免 `pnpm --filter ... test -- <files>` 在包脚本中选择器不可靠；Web 段保留 Node 25 时追加 `--no-experimental-webstorage` 的兼容逻辑。
- **[配置]** Phase 4 最终验证命令均已通过：`pnpm --filter @cc-pet/server typecheck && pnpm --filter @cc-pet/web build`、`pnpm --filter @cc-pet/server exec vitest run tests/storage.test.ts tests/workspace-api.test.ts`、`pnpm --filter @cc-pet/web test -- src/components/Layout.test.tsx src/App.integration.test.tsx`、`pnpm test:e2e`。
