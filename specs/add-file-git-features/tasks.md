# Tasks: 文件列表与 Git 变更查看

**Workspace**: `add-file-git-features`  
**Date**: 2026-05-12  
**Spec**: [spec.md](spec.md)  
**Plan**: [plan.md](plan.md)  
**Explore**: [explore.md](explore.md)

---

## Phase 0: 连接工作区基础

### 实现

- [X] T001 扩展连接配置模型，支持每个 Bridge 从配置中携带可选工作区路径，并保持旧配置兼容
  - files: [修改] `packages/shared/src/types/config.ts`, [修改] `packages/server/src/storage/config.ts`
  - symbols: `BridgeConfig`, `normalizeBridge()`, `normalizeAppConfig()`, `ConfigStore.load()`, `ConfigStore.save()`
  - tests: [修改] `packages/server/tests/storage.test.ts`
  - covers: US1-1, US1-8

- [X] T002 新增连接工作区解析器，统一处理 token 授权、连接查找、工作区有效性和路径边界校验
  - files: [新增] `packages/server/src/workspace/resolver.ts`, [新增] `packages/server/tests/workspace-api.test.ts`
  - symbols: `resolveConnectionWorkspace()`, `resolveWorkspacePath()`, `assertWritablePath()`, `getRequestAuthIdentity()`, `ConfigStore.load()`
  - tests: [新增] `packages/server/tests/workspace-api.test.ts`
  - covers: US1-8, US2-8

### 门禁

- [X] 编译通过
- [X] 运行 `pnpm --filter @cc-pet/server exec vitest run tests/storage.test.ts tests/workspace-api.test.ts` → 验证 US1-1, US1-8, US2-8

---

## Phase 1: User Story 1 - 浏览当前项目文件

### 实现

- [X] T003 [US1] 新增工作区文件读取服务与 REST 路由，支持读取工作区元信息、目录直接子项和文件预览
  - files: [新增] `packages/server/src/workspace/file-service.ts`, [新增] `packages/server/src/api/workspace.ts`, [修改] `packages/server/src/index.ts`, [新增] `packages/server/tests/workspace-api.test.ts`
  - symbols: `registerWorkspaceRoutes()`, `listDirectory()`, `readFilePreview()`, `WorkspaceMeta`, `FileEntry`, `FilePreview`
  - tests: [新增] `packages/server/tests/workspace-api.test.ts`
  - covers: US1-1, US1-3, US1-5, US1-6, US1-7, US1-8

- [X] T004 [US1] 新增前端工作区状态 store，按当前连接加载工作区元信息、文件树和文件内容，并在连接切换时刷新上下文
  - files: [新增] `packages/web/src/lib/store/workspace.ts`, [修改] `packages/web/src/lib/store/index.ts`, [修改] `packages/web/src/App.integration.test.tsx`
  - symbols: `useWorkspaceStore`, `loadWorkspace()`, `loadTree()`, `openFile()`, `activeConnectionId`, `getPlatform().fetchApi()`
  - tests: [修改] `packages/web/src/App.integration.test.tsx`
  - covers: US1-1, US1-3, US1-4, US1-8

- [X] T005 [US1] 新增文件树和文件查看 UI，在桌面侧栏展示当前连接工作区，并支持目录展开/折叠、空状态、不可访问项和大文件不可预览提示
  - files: [新增] `packages/web/src/components/workspace/WorkspacePanel.tsx`, [新增] `packages/web/src/components/workspace/FileTree.tsx`, [新增] `packages/web/src/components/workspace/FileViewer.tsx`, [修改] `packages/web/src/components/Layout.tsx`, [修改] `packages/web/src/components/Layout.test.tsx`, [修改] `packages/web/src/App.integration.test.tsx`
  - symbols: `WorkspacePanel`, `FileTree`, `FileViewer`, `Layout`, `useWorkspaceStore`, `useConnectionStore`
  - tests: [修改] `packages/web/src/components/Layout.test.tsx`, [修改] `packages/web/src/App.integration.test.tsx`
  - covers: US1-1, US1-2, US1-3, US1-4, US1-5, US1-6, US1-7, US1-8

### 门禁

- [X] 编译通过
- [X] 运行 `pnpm --filter @cc-pet/server exec vitest run tests/workspace-api.test.ts` → 验证 US1-1, US1-3, US1-5, US1-6, US1-7, US1-8
- [X] 运行 `pnpm --filter @cc-pet/web test -- src/components/Layout.test.tsx src/App.integration.test.tsx` → 验证 US1-1, US1-2, US1-3, US1-4, US1-5, US1-6, US1-7, US1-8

---

## Phase 2: User Story 2 - 管理当前项目文件与目录

### 实现

- [X] T006 [US2] 扩展工作区文件服务与 REST 路由，支持创建文件/目录、重命名、删除和保存文本文件
  - files: [修改] `packages/server/src/workspace/file-service.ts`, [修改] `packages/server/src/api/workspace.ts`, [修改] `packages/server/tests/workspace-api.test.ts`
  - symbols: `createItem()`, `renameItem()`, `deleteItem()`, `writeFileContent()`, `registerWorkspaceRoutes()`
  - tests: [修改] `packages/server/tests/workspace-api.test.ts`
  - covers: US2-1, US2-2, US2-3, US2-4, US2-5, US2-6, US2-7, US2-8

- [X] T007 [US2] 扩展前端工作区 store 和文件树 UI，提供创建、重命名、删除、保存、确认和错误反馈
  - files: [修改] `packages/web/src/lib/store/workspace.ts`, [修改] `packages/web/src/components/workspace/FileTree.tsx`, [修改] `packages/web/src/components/workspace/FileViewer.tsx`, [修改] `packages/web/src/components/workspace/WorkspacePanel.tsx`, [修改] `packages/web/src/components/Layout.test.tsx`, [修改] `packages/web/src/App.integration.test.tsx`
  - symbols: `createItem()`, `renameItem()`, `deleteItem()`, `saveFile()`, `FileTree`, `FileViewer`, `WorkspacePanel`
  - tests: [修改] `packages/web/src/components/Layout.test.tsx`, [修改] `packages/web/src/App.integration.test.tsx`
  - covers: US2-1, US2-2, US2-3, US2-4, US2-5, US2-6, US2-7, US2-8

### 门禁

- [X] 编译通过
- [X] 运行 `pnpm --filter @cc-pet/server exec vitest run tests/workspace-api.test.ts` → 验证 US2-1, US2-2, US2-3, US2-4, US2-5, US2-6, US2-7, US2-8
- [X] 运行 `pnpm --filter @cc-pet/web test -- src/components/Layout.test.tsx src/App.integration.test.tsx` → 验证 US2-1, US2-2, US2-3, US2-4, US2-5, US2-6, US2-7, US2-8

---

## Phase 3: User Story 3 - 查看 Git 变更与 Diff

### 实现

- [X] T008 [US3] 新增 Git 服务与工作区 Git 路由，支持获取 Git 状态列表和单文件 diff，并处理非 Git 仓库、大 diff、二进制 diff 和刷新场景
  - files: [新增] `packages/server/src/workspace/git-service.ts`, [修改] `packages/server/src/api/workspace.ts`, [修改] `packages/server/tests/workspace-api.test.ts`
  - symbols: `getGitStatus()`, `getGitDiff()`, `runGit()`, `GitChange`, `GitStatusResponse`, `GitDiffResponse`, `registerWorkspaceRoutes()`
  - tests: [修改] `packages/server/tests/workspace-api.test.ts`
  - covers: US3-1, US3-2, US3-4, US3-5, US3-6, US3-7

- [X] T009 [US3] 扩展前端工作区 store，支持加载 Git 变更、打开 diff、刷新 Git 状态，并把 Git 状态合并到文件树条目
  - files: [修改] `packages/web/src/lib/store/workspace.ts`, [修改] `packages/web/src/App.integration.test.tsx`
  - symbols: `loadGitStatus()`, `openDiff()`, `gitStatusByConnection`, `treeByConnection`, `getPlatform().fetchApi()`
  - tests: [修改] `packages/web/src/App.integration.test.tsx`
  - covers: US3-1, US3-2, US3-3, US3-4, US3-5, US3-6, US3-7

- [X] T010 [US3] 新增 Git 变更面板和 diff 查看器，在文件树中显示变更提示，并支持无变更、非 Git 仓库和 diff 不可预览状态
  - files: [新增] `packages/web/src/components/workspace/GitChangesPanel.tsx`, [新增] `packages/web/src/components/workspace/DiffViewer.tsx`, [修改] `packages/web/src/components/workspace/FileTree.tsx`, [修改] `packages/web/src/components/workspace/WorkspacePanel.tsx`, [修改] `packages/web/src/components/Layout.test.tsx`, [修改] `packages/web/src/App.integration.test.tsx`
  - symbols: `GitChangesPanel`, `DiffViewer`, `FileTree`, `WorkspacePanel`, `useWorkspaceStore`
  - tests: [修改] `packages/web/src/components/Layout.test.tsx`, [修改] `packages/web/src/App.integration.test.tsx`
  - covers: US3-1, US3-2, US3-3, US3-4, US3-5, US3-6, US3-7

### 门禁

- [X] 编译通过
- [X] 运行 `pnpm --filter @cc-pet/server exec vitest run tests/workspace-api.test.ts` → 验证 US3-1, US3-2, US3-4, US3-5, US3-6, US3-7
- [X] 运行 `pnpm --filter @cc-pet/web test -- src/components/Layout.test.tsx src/App.integration.test.tsx` → 验证 US3-1, US3-2, US3-3, US3-4, US3-5, US3-6, US3-7

---

## Phase 4: 总门禁与回归

### 实现

- [X] T011 汇总回归并确保根 e2e 门禁覆盖新增工作区链路，不引入文档或脚本漂移
  - files: [修改] `package.json`, [修改] `packages/server/tests/workspace-api.test.ts`, [修改] `packages/web/src/App.integration.test.tsx`
  - symbols: `test:e2e`, `registerWorkspaceRoutes()`, `WorkspacePanel`, `GitChangesPanel`
  - tests: [修改] `packages/server/tests/workspace-api.test.ts`, [修改] `packages/web/src/App.integration.test.tsx`
  - covers: US1-1, US1-2, US1-3, US1-4, US1-5, US1-6, US1-7, US1-8, US2-1, US2-2, US2-3, US2-4, US2-5, US2-6, US2-7, US2-8, US3-1, US3-2, US3-3, US3-4, US3-5, US3-6, US3-7

### 门禁

- [X] 编译通过
- [X] 运行 `pnpm --filter @cc-pet/server exec vitest run tests/storage.test.ts tests/workspace-api.test.ts` → 验证 US1-1, US1-8, US2-8, US3-1, US3-2, US3-4, US3-5, US3-6, US3-7
- [X] 运行 `pnpm --filter @cc-pet/web test -- src/components/Layout.test.tsx src/App.integration.test.tsx` → 验证 US1-1, US1-2, US1-3, US1-4, US1-5, US1-6, US1-7, US1-8, US2-1, US2-2, US2-3, US2-4, US2-5, US2-6, US2-7, US2-8, US3-1, US3-2, US3-3, US3-4, US3-5, US3-6, US3-7
- [X] 运行 `pnpm test:e2e` → 验证根回归门禁

---

## 验收覆盖矩阵

| 场景ID | 描述 | 验证方式 |
|--------|------|----------|
| US1-1 | 从连接配置工作区加载根文件列表并区分文件/目录/类型 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US1-2 | 展开/折叠多层目录并保持上下文 | 前端集成测试：`Layout.test.tsx` / `App.integration.test.tsx` |
| US1-3 | 选择文件后展示内容和路径 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US1-4 | 切换连接后重新加载对应工作区 | 前端集成测试：`App.integration.test.tsx` |
| US1-5 | 空目录显示空状态 | 集成测试：`workspace-api.test.ts`；前端集成测试：`Layout.test.tsx` |
| US1-6 | 不可访问项提示且不阻塞浏览 | 集成测试：`workspace-api.test.ts`；前端集成测试：`Layout.test.tsx` |
| US1-7 | 大文件或不可安全预览文件返回不可预览提示 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US1-8 | 未配置或无效工作区提示先配置有效工作区 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US2-1 | 创建文件或目录并刷新列表 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US2-2 | 重命名文件或目录并更新路径展示 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US2-3 | 删除文件或目录并从列表移除 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US2-4 | 修改文本文件并保存成功反馈 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US2-5 | 空名称、重复名称、非法字符被阻止并说明原因 | 集成测试：`workspace-api.test.ts`；前端集成测试：`Layout.test.tsx` |
| US2-6 | 删除非空目录前需要明确确认 | 集成测试：`workspace-api.test.ts`；前端集成测试：`Layout.test.tsx` |
| US2-7 | 外部变更导致列表过期时提示刷新 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US2-8 | 越过连接工作区边界的操作被拒绝 | 集成测试：`workspace-api.test.ts` |
| US3-1 | 展示 Git 变更列表及状态 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US3-2 | 选择变更文件后展示 diff | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US3-3 | 文件树中标识存在 Git 变更的文件 | 前端集成测试：`Layout.test.tsx` / `App.integration.test.tsx` |
| US3-4 | 无未提交变更时显示无变更状态并可刷新 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US3-5 | 非 Git 仓库或 Git 不可用时显示 Git 状态不可用但文件浏览可用 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US3-6 | 大 diff 或二进制文件显示摘要或不可预览提示 | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |
| US3-7 | 文件状态变化后可刷新 Git 状态和 diff | 集成测试：`workspace-api.test.ts`；前端集成测试：`App.integration.test.tsx` |

**覆盖完整性检查**: `spec.md` 中 US1-1 至 US3-7 共 23 个场景均已覆盖，无遗漏。

---

## Notes

- MVP 建议从 Phase 1 的 US1 文件浏览开始，但 Phase 0 必须先做，因为连接工作区是所有后续 API 的安全边界。
- `workspacePath` 是连接配置字段，保持可选以兼容旧配置；未配置时只影响工作区面板，不影响聊天和 Bridge 连接。
- 本地文件系统能力必须以服务端 resolver 为唯一边界校验入口，前端隐藏按钮不能作为安全措施。
- Git 首版只覆盖工作区 status 和单文件 diff，不实现 stage、commit、分支、push/pull 或提交历史。
- 实现完成后必须执行根命令 `pnpm test:e2e`，它是本仓库强制回归门禁。
