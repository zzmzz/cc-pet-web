import { useState } from "react";
import { useWorkspaceStore } from "../../lib/store/workspace.js";
import type { FileEntry } from "../../lib/store/workspace.js";

function entryIcon(entry: FileEntry): string {
  if (entry.kind === "directory") return ">";
  if (entry.extension === ".md") return "MD";
  if (entry.extension === ".ts" || entry.extension === ".tsx") return "TS";
  return "FILE";
}

function gitStatusLabel(status?: string): string | null {
  if (!status) return null;
  if (status === "??") return "Git 新增";
  if (status === "M") return "Git 修改";
  if (status === "A") return "Git 新增";
  if (status === "D") return "Git 删除";
  if (status === "R") return "Git 重命名";
  return `Git ${status}`;
}

export function FileTree({
  connectionId,
  path = "",
  level = 0,
}: {
  connectionId: string;
  path?: string;
  level?: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const entries = useWorkspaceStore((s) => s.treeByConnection[connectionId]?.[path]);
  const loading = useWorkspaceStore((s) => s.loadingTreeByConnection[connectionId]?.[path] ?? false);
  const error = useWorkspaceStore((s) => s.treeErrorByConnection[connectionId]?.[path]);
  const loadTree = useWorkspaceStore((s) => s.loadTree);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const createItem = useWorkspaceStore((s) => s.createItem);
  const renameItem = useWorkspaceStore((s) => s.renameItem);
  const deleteItem = useWorkspaceStore((s) => s.deleteItem);

  const handleCreate = async (kind: FileEntry["kind"]) => {
    const label = kind === "directory" ? "目录" : "文件";
    const name = window.prompt(`请输入${label}名称`);
    if (name === null) return;
    await createItem(connectionId, path, name, kind);
  };

  return (
    <div className="space-y-1">
      <div className="flex gap-1 px-2">
        <button
          type="button"
          onClick={() => void handleCreate("file")}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary hover:bg-surface"
        >
          新建文件
        </button>
        <button
          type="button"
          onClick={() => void handleCreate("directory")}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary hover:bg-surface"
        >
          新建目录
        </button>
      </div>
      {loading && !entries && <div className="px-2 py-2 text-xs text-text-secondary">目录加载中...</div>}
      {error && <div className="px-2 py-2 text-xs text-red-400">{error}</div>}
      {!loading && !error && (!entries || entries.length === 0) && (
        <div className="px-2 py-2 text-xs text-text-secondary">目录为空</div>
      )}
      {!error && entries?.map((entry) => {
        const isExpanded = expanded.has(entry.path);
        const disabled = entry.inaccessible === true;
        const gitLabel = gitStatusLabel(entry.gitStatus);
        const handleClick = async () => {
          if (disabled) return;
          if (entry.kind === "directory") {
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(entry.path)) {
                next.delete(entry.path);
              } else {
                next.add(entry.path);
                if (!useWorkspaceStore.getState().treeByConnection[connectionId]?.[entry.path]) {
                  void loadTree(connectionId, entry.path);
                }
              }
              return next;
            });
            return;
          }
          await openFile(connectionId, entry.path);
        };
        const handleRename = async () => {
          if (disabled) return;
          const name = window.prompt("请输入新名称", entry.name);
          if (name === null) return;
          await renameItem(connectionId, entry.path, name);
        };
        const handleDelete = async () => {
          if (disabled) return;
          if (!window.confirm(`确认删除 ${entry.name}？`)) return;
          const recursive = entry.kind === "directory"
            ? window.confirm(`${entry.name} 是目录，确认递归删除其全部内容？`)
            : false;
          if (entry.kind === "directory" && !recursive) return;
          await deleteItem(connectionId, entry.path, recursive);
        };

        return (
          <div key={entry.path} data-file-entry>
            <button
              type="button"
              disabled={disabled}
              onClick={handleClick}
              className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs ${
                disabled
                  ? "cursor-not-allowed text-text-secondary/60"
                  : "text-text-primary hover:bg-surface"
              }`}
              style={{ paddingLeft: `${0.5 + level * 0.75}rem` }}
            >
              <span className="w-7 shrink-0 text-[10px] text-text-secondary">
                {entry.kind === "directory" && isExpanded ? "v" : entryIcon(entry)}
              </span>
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {gitLabel && (
                <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[10px] text-accent">
                  {gitLabel}
                </span>
              )}
              {entry.inaccessible && (
                <span className="shrink-0 rounded bg-red-500/10 px-1 py-0.5 text-[10px] text-red-400">
                  不可访问
                </span>
              )}
            </button>
            {!disabled && (
              <div
                className="mb-0.5 flex gap-1 px-2"
                style={{ paddingLeft: `${2.4 + level * 0.75}rem` }}
              >
                <button
                  type="button"
                  onClick={() => void handleRename()}
                  className="rounded px-1 py-0.5 text-[10px] text-text-secondary hover:bg-surface"
                >
                  重命名
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  className="rounded px-1 py-0.5 text-[10px] text-red-400 hover:bg-red-500/10"
                >
                  删除
                </button>
              </div>
            )}
            {entry.kind === "directory" && isExpanded && !disabled && (
              <FileTree connectionId={connectionId} path={entry.path} level={level + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}
