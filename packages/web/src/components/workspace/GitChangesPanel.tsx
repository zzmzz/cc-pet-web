import type { ChangeEvent } from "react";
import { useWorkspaceStore } from "../../lib/store/workspace.js";
import type { GitScopeEntry } from "../../lib/store/workspace.js";

function statusLabel(status: string): string {
  if (status === "??") return "新增";
  if (status === "M") return "修改";
  if (status === "A") return "新增";
  if (status === "D") return "删除";
  if (status === "R") return "重命名";
  if (status === "C") return "复制";
  return status;
}

function scopeOptionLabel(scope: GitScopeEntry): string {
  if (scope.path === "") return scope.label ?? "（工作区根）";
  const suffix = scope.repoMode === "nested" ? "（独立仓库）" : scope.repoMode === "custom" ? "（子路径）" : "";
  return `${scope.label ?? scope.path}${suffix}`;
}

export function GitChangesPanel({ connectionId }: { connectionId: string }) {
  const activeScope = useWorkspaceStore((s) => s.activeGitScopeByConnection[connectionId] ?? "");
  const gitStatus = useWorkspaceStore((s) => s.gitStatusByConnection[connectionId]?.[activeScope]);
  const loading = useWorkspaceStore(
    (s) => s.loadingGitStatusByConnection[connectionId]?.[activeScope] ?? false,
  );
  const scopes = useWorkspaceStore((s) => s.gitScopesByConnection[connectionId] ?? []);
  const scopesTruncated = useWorkspaceStore((s) => s.gitScopesTruncatedByConnection[connectionId] ?? false);
  const loadGitStatus = useWorkspaceStore((s) => s.loadGitStatus);
  const setActiveGitScope = useWorkspaceStore((s) => s.setActiveGitScope);
  const openDiff = useWorkspaceStore((s) => s.openDiff);

  const changes = gitStatus?.changes ?? [];

  const options: GitScopeEntry[] = (() => {
    const merged = scopes.length > 0 ? [...scopes] : [{ path: "", repoMode: "root" as const, label: "（工作区根）" }];
    if (!merged.some((scope) => scope.path === activeScope)) {
      merged.push({ path: activeScope, repoMode: "custom", label: activeScope || "（工作区根）" });
    }
    return merged;
  })();

  const handleScopeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    void setActiveGitScope(connectionId, event.target.value);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-2">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-text-secondary">
          <span className="shrink-0">范围</span>
          <select
            aria-label="Git 范围"
            value={activeScope}
            onChange={handleScopeChange}
            className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text-primary"
          >
            {options.map((scope) => (
              <option key={`scope:${scope.path}`} value={scope.path}>
                {scopeOptionLabel(scope)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void loadGitStatus(connectionId, activeScope)}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary hover:bg-surface"
        >
          刷新
        </button>
        {loading && <span className="text-[11px] text-text-secondary">加载中...</span>}
      </div>
      {scopesTruncated && (
        <div className="rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
          子目录较多，仅展示扫描到的部分范围。
        </div>
      )}
      {!loading && gitStatus?.gitAvailable === false && (
        <div className="rounded-md bg-surface px-2 py-2 text-xs text-text-secondary">
          {gitStatus.message ?? "Git 状态不可用，文件浏览仍可继续使用。"}
        </div>
      )}
      {!loading && gitStatus?.gitAvailable !== false && changes.length === 0 && (
        <div className="rounded-md bg-surface px-2 py-2 text-xs text-text-secondary">
          暂无 Git 变更。
        </div>
      )}
      {changes.map((change) => (
        <button
          key={`${change.status}:${change.path}`}
          type="button"
          onClick={() => void openDiff(connectionId, change.path)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-primary hover:bg-surface"
        >
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
            {statusLabel(change.status)}
          </span>
          <span className="min-w-0 flex-1 truncate">{change.path}</span>
        </button>
      ))}
    </div>
  );
}
