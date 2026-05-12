import { useWorkspaceStore } from "../../lib/store/workspace.js";

function diffMessage(reason?: string, fallback?: string): string {
  if (reason === "DIFF_TOO_LARGE") return "Diff 过大，无法直接预览。";
  if (reason === "BINARY_DIFF") return "二进制 diff 无法直接预览。";
  if (reason === "GIT_UNAVAILABLE") return "Git 状态不可用，无法展示 diff。";
  return fallback ?? "Diff 无法直接预览。";
}

function lineClassName(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-green-400";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-red-400";
  if (line.startsWith("@@")) return "text-accent";
  return "text-text-secondary";
}

export function DiffViewer({ variant = "desktop" }: { variant?: "desktop" | "mobile" }) {
  const activeDiff = useWorkspaceStore((s) => s.activeDiff);
  const loadingDiff = useWorkspaceStore((s) => s.loadingDiff);
  const closeDiff = useWorkspaceStore((s) => s.closeDiff);

  if (!activeDiff && !loadingDiff) return null;
  const containerClass = variant === "mobile"
    ? "flex min-h-0 max-h-[55vh] w-full flex-col border-t border-border bg-surface-secondary"
    : "flex w-[34rem] max-w-[45%] shrink-0 flex-col border-l border-border bg-surface-secondary";

  return (
    <aside className={containerClass}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">Diff 查看</div>
          {activeDiff?.path && (
            <div className="truncate text-[11px] text-text-secondary">{activeDiff.path}</div>
          )}
        </div>
        <button
          type="button"
          onClick={closeDiff}
          className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface"
        >
          关闭
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loadingDiff && <div className="text-sm text-text-secondary">Diff 加载中...</div>}
        {!loadingDiff && activeDiff?.previewable && (
          <pre className="min-h-full overflow-auto rounded-lg bg-surface p-3 font-mono text-xs leading-5">
            {(activeDiff.diff ?? "").split("\n").map((line, index) => (
              <div key={`${index}:${line}`} className={lineClassName(line)}>
                {line || " "}
              </div>
            ))}
          </pre>
        )}
        {!loadingDiff && activeDiff && !activeDiff.previewable && (
          <div className="rounded-lg border border-border bg-surface p-3 text-sm text-text-secondary">
            {diffMessage(activeDiff.reason, activeDiff.message)}
          </div>
        )}
      </div>
    </aside>
  );
}
