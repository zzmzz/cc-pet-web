import { useWorkspaceStore } from "../../lib/store/workspace.js";

function statusLabel(status: string): string {
  if (status === "??") return "新增";
  if (status === "M") return "修改";
  if (status === "A") return "新增";
  if (status === "D") return "删除";
  if (status === "R") return "重命名";
  if (status === "C") return "复制";
  return status;
}

export function GitChangesPanel({ connectionId }: { connectionId: string }) {
  const gitStatus = useWorkspaceStore((s) => s.gitStatusByConnection[connectionId]);
  const loading = useWorkspaceStore((s) => s.loadingGitStatusByConnection[connectionId] ?? false);
  const loadGitStatus = useWorkspaceStore((s) => s.loadGitStatus);
  const openDiff = useWorkspaceStore((s) => s.openDiff);

  const changes = gitStatus?.changes ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-2">
        <button
          type="button"
          onClick={() => void loadGitStatus(connectionId)}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary hover:bg-surface"
        >
          刷新 Git 状态
        </button>
        {loading && <span className="text-[11px] text-text-secondary">加载中...</span>}
      </div>
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
