**Workspace**: `git-subdir-scope`
**Created**: 2026-05-12
**Input**: 用户描述: "现在工作区的 git 只能查看根目录的 git 状态，能否查看各个子目录的 git 情况"

**已确认方向**：
- 场景：在工作区内可切换 git 视图的「范围根（scope）」——若该子目录本身是独立 git repo 就以它为根，否则按子路径过滤当前 repo 的 changes
- UI：`GitChangesPanel` 顶部增加一个范围选择器
- 改动范围：前后端都做，跑通完整链路

---

## 目标

把"workspace 只能看根目录 git 状态"扩展为：用户可以在 Git 面板顶部切换 scope，看到所选子目录上下文下的 git 状态与 diff。两类子目录都覆盖：
1. **nested repo**：子目录本身含 `.git`（如 submodule、workspace 中并列放置的多个 repo）→ 以该子目录为 git 根
2. **monorepo 子路径**：子目录隶属于 workspace root 的同一 git repo → 仅展示该路径下的 changes/diff

## 推荐方案

后端在现有 `git-service` 增加 scope 解析层，让 `getGitStatus` / `getGitDiff` 接受一个可选 `scope`（相对 workspace root 的子路径），并新增「扫描可用 scope 列表」接口。前端在 `workspace` store 中按 `connectionId + scope` 维度存 git 状态，`GitChangesPanel` 顶部加 scope 选择器，文件树标记 git 状态时遵循当前激活 scope。

### scope 解析规则（后端）

- `scope = ""` → 以 workspace root 为 git cwd（与现状一致）
- `scope = "<subpath>"`：先 `resolveWorkspacePath` 校验路径合法，再以子目录绝对路径为 cwd 执行 `git rev-parse --show-toplevel`：
  - toplevel 等于子目录自身 → **nested repo 模式**：以该子目录作为 git cwd；返回的 `path` 加上 `<subpath>/` 前缀，使其相对 workspace root 仍然可用
  - toplevel 等于 workspace root（或其祖先） → **subpath 过滤模式**：cwd 仍是 workspace root，执行 `git status --porcelain=v1 -- <subpath>`、`git diff ... -- <path>` 时叠加 pathspec 限制
  - toplevel 落在 workspace root 之外 → 报 `WORKSPACE_PATH_OUTSIDE_ROOT`，与现有 resolver 行为一致

返回结构追加（向后兼容）：

```ts
interface GitStatusResponse {
  gitAvailable: boolean;
  changes: GitChange[];
  message?: string;
  scope: string;            // 新增，回显请求 scope
  repoMode: "root" | "nested" | "subpath"; // 新增
  repoRoot: string;         // 新增，相对 workspace root 的 git 根路径，空串表示就是 workspace root
}
```

### 新增「scope 列表」接口（后端）

`GET /api/workspaces/:connectionId/git/scopes` → 返回：

```ts
interface GitScopesResponse {
  scopes: Array<{ path: string; repoMode: "root" | "nested"; label?: string }>;
}
```

- 始终包含 `{ path: "", repoMode: "root" }`（除非 workspace root 不是 git 工作树，那就退化为空列表）
- 通过有限深度（默认 2 层，可调）扫描 workspace 子目录，命中 `.git`（文件或目录均可，兼容 submodule worktree）则加入；跳过 `node_modules`、`.git`、`dist`、`build` 等噪声目录
- 不扫描 subpath 过滤候选——subpath 由前端通过文件树交互临时加入（见下文）

### 前端改造

- `workspace` store
  - 新增 `activeGitScopeByConnection: Record<connectionId, string>`（默认 `""`）
  - 把 `gitStatusByConnection` 改为 `gitStatusByConnection: Record<connectionId, Record<scope, GitStatusResponse>>`
  - 新增 `gitScopesByConnection`，以及 `loadGitScopes(connectionId)`、`setActiveGitScope(connectionId, scope)`、`addCustomGitScope(connectionId, subpath)` 等 action
  - `loadGitStatus(connectionId, scope?)` 透传 `scope`（默认取 activeGitScope），URL 拼 `?scope=…`
  - `openDiff(connectionId, path)` 也带上当前 activeGitScope，请求 `git/diff?path=&scope=`
  - 文件树标 git status 的 `mergeTreeWithGitStatus` 改成基于当前 active scope 的 status；nested repo 模式下 changes 的 path 已是相对 workspace root（见后端规则），匹配逻辑无需改

- `GitChangesPanel`
  - 顶部新增范围选择器（`<select>` 或按钮组），选项 = `gitScopesByConnection` ∪ 当前 active scope（若是临时自定义路径要进入选项以便用户回切）
  - 选项标签：`""` 显示为「（工作区根）」，nested repo 显示 `路径 · nested`，自定义 subpath 显示 `路径 · 子路径`
  - 切换 → `setActiveGitScope` → 自动触发 `loadGitStatus`
  - 现有「刷新 Git 状态」按钮保留，刷新当前 scope

- `FileTree`
  - 在目录条目操作栏新增一个图标按钮「在 Git 面板查看」，点击 → `addCustomGitScope(connectionId, entry.path)` + `setActiveGitScope` + 切换 WorkspacePanel 的 tab 到 `git`
  - 这是 v1 提供"context-switch"心智的关键入口；没有它，用户只能从下拉里选 nested repo

## 改动点

后端：
- `packages/server/src/workspace/git-service.ts`
  - 重构 `getGitStatus` / `getGitDiff`：参数 `(workspace, options: { scope?: string; relativePath?: string })`；新增内部辅助 `resolveScopeContext(workspace, scope)` 返回 `{ cwd, repoMode, repoRoot, pathspec }`
  - 路径前缀工具：nested repo 模式下把 `parseStatusLine` 的输出路径加上 `repoRoot` 前缀（含 `previousPath`）
  - diff 路径在 nested 模式下，剥掉前缀给 git 命令、再回填到响应里
  - 暴露 `listGitScopes(workspace, options?)`：浅层目录扫描 + `.git` 探测；忽略列表硬编码 + 可配置上限（默认 2 层、200 目录）
- `packages/server/src/api/workspace.ts`
  - `GET /git/status` / `GET /git/diff` 新增 `scope` query 透传
  - 新增 `GET /git/scopes` 路由
- `packages/server/tests/workspace-api.test.ts`
  - 新增三组用例：nested repo scope 返回的 path 含前缀；subpath scope 仅返回该子路径下的 changes；scope 解析失败/越界报 400；`/git/scopes` 能扫描到 nested repo

前端：
- `packages/web/src/lib/store/workspace.ts`
  - 类型与状态结构扩展（如上）；`loadGitStatus` / `openDiff` 携带 scope
- `packages/web/src/components/workspace/GitChangesPanel.tsx`
  - 顶部 scope 选择器，change item 渲染保留现状（path 已相对 workspace root）
- `packages/web/src/components/workspace/FileTree.tsx`
  - 目录条目新增「在 Git 面板查看」按钮，调用 store action
- `packages/web/src/components/workspace/WorkspacePanel.tsx`
  - 暴露一个最小的 tab 切换 action 或通过 store 中转，允许 FileTree 触发 tab 跳转到 `git`（最小入侵：用一个轻量 zustand 切面，或者直接在 store 里加 `pendingWorkspaceTabByConnection`，WorkspacePanel 监听并切换）
- `packages/web/src/App.integration.test.tsx`
  - 增补一个集成场景：切换 scope 后 `Git 变更` 面板请求带 scope；选 nested repo 后 changes 列表更新

## 验证方式

> 主验证：`pnpm test:e2e`（项目 e2e 闸门），覆盖 server 侧 workspace-api 用例与 web 侧集成测试。

具体动作：
1. 在 `packages/server/tests/workspace-api.test.ts` 中以 `initGitRepo()` 扩展两个 fixture：
   - 在 workspace 子目录 `sub/embedded/` 下再 `git init` 制造 nested repo，制造一处改动，验证 `/git/status?scope=sub/embedded` 返回 `repoMode: "nested"`、`changes[0].path` 形如 `sub/embedded/...`
   - 在同一个 root repo 内 `packages/a/` 与 `packages/b/` 各放一个改动，验证 `/git/status?scope=packages/a` 仅返回 `packages/a/...` 下的 change，`repoMode: "subpath"`
2. `/git/scopes`：构造一个 nested repo，断言返回包含 `{ path: "sub/embedded", repoMode: "nested" }`，不包含 `node_modules`
3. 边界：`scope=../outside` 返回 400 `WORKSPACE_PATH_OUTSIDE_ROOT`；`scope=non-existing` 返回 404 等价错误
4. 在 `App.integration.test.tsx` 中 mock `/git/scopes` 与多 scope 的 `/git/status`，断言：
   - 初次渲染 Git 面板默认 scope 为 ""，请求 URL 不含或含 `scope=`
   - 切换 selector → 请求带新的 `scope=`，列表内容随之更新
5. 命令：`pnpm test:e2e`；必要时本地补跑 `pnpm --filter @cc-pet/server test` 单测以快速迭代

## 已知风险与假设

- `git status --porcelain -- <pathspec>` 在 root repo 下能正确过滤；但**未跟踪文件**在 pathspec 是目录时的输出格式需验证（应当输出目录下每个新文件，但行为版本相关），实施时需在测试中明确断言
- nested repo 路径前缀拼接要注意 rename 行（`R` 状态的 `previousPath` 也要前缀），否则前端 git 状态匹配会丢失重命名
- scope 扫描需要 IO 上限，避免大 workspace 阻塞；默认深度 2 + 目录上限 200，超出截断并在响应里标记 `truncated: true`（前端给个提示）
- 文件树「在 Git 面板查看」按钮需要 store 层做 tab 跳转中介，避免 FileTree 直接耦合 WorkspacePanel 的本地 state；这是新增的小架构点，实施时确认是否接受
