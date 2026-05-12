import { useRef, useState } from "react";
import type { ChangeEvent, MouseEvent, ReactNode } from "react";
import { useWorkspaceStore } from "../../lib/store/workspace.js";
import type { FileEntry } from "../../lib/store/workspace.js";

function ActionIconButton({
  label,
  tone = "neutral",
  onClick,
  children,
}: {
  label: string;
  tone?: "neutral" | "danger";
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`rounded p-1 transition hover:bg-surface-secondary ${
        tone === "danger"
          ? "text-red-400 hover:bg-red-500/10"
          : "text-text-secondary hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function FilePlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M5.5 2A1.5 1.5 0 004 3.5v13A1.5 1.5 0 005.5 18h9a1.5 1.5 0 001.5-1.5V7.25L10.75 2H5.5zM10 3.5L14.5 8H11a1 1 0 01-1-1V3.5z" />
      <path d="M10 10a.75.75 0 01.75.75V12H12a.75.75 0 010 1.5h-1.25v1.25a.75.75 0 01-1.5 0V13.5H8A.75.75 0 018 12h1.25v-1.25A.75.75 0 0110 10z" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M2.5 5A2.5 2.5 0 015 2.5h3.2c.55 0 1.07.22 1.45.6l1.15 1.15H15A2.5 2.5 0 0117.5 6.75v7.75A2.5 2.5 0 0115 17H5a2.5 2.5 0 01-2.5-2.5V5z" />
      <path d="M10 8a.75.75 0 01.75.75V10H12a.75.75 0 010 1.5h-1.25v1.25a.75.75 0 01-1.5 0V11.5H8A.75.75 0 018 10h1.25V8.75A.75.75 0 0110 8z" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 2.5a.75.75 0 01.53.22l3.5 3.5a.75.75 0 11-1.06 1.06L10.75 5.56v7.69a.75.75 0 01-1.5 0V5.56L7.03 7.28A.75.75 0 015.97 6.22l3.5-3.5A.75.75 0 0110 2.5z" />
      <path d="M3.5 13.25a.75.75 0 011.5 0v2A1.25 1.25 0 006.25 16.5h7.5a1.25 1.25 0 001.25-1.25v-2a.75.75 0 011.5 0v2A2.75 2.75 0 0113.75 18h-7.5A2.75 2.75 0 013.5 15.25v-2z" />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M13.92 2.92a2.25 2.25 0 013.18 3.18l-8.4 8.4a2 2 0 01-.88.5l-3.16.79a.75.75 0 01-.91-.91l.79-3.16a2 2 0 01.5-.88l8.88-8.88zM3.75 17a.75.75 0 000 1.5h12.5a.75.75 0 000-1.5H3.75z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M8.5 2.5A1.5 1.5 0 007 4v.5H4.75a.75.75 0 000 1.5h.34l.7 9.1A2.75 2.75 0 008.53 17.6h2.94a2.75 2.75 0 002.74-2.5l.7-9.1h.34a.75.75 0 000-1.5H13V4a1.5 1.5 0 00-1.5-1.5h-3zM8.5 4h3v.5h-3V4zM8 8a.75.75 0 01.75.75v5a.75.75 0 01-1.5 0v-5A.75.75 0 018 8zm4 .75a.75.75 0 00-1.5 0v5a.75.75 0 001.5 0v-5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function GitScopeIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M6 4a2 2 0 11-1 3.732V12a2 2 0 002 2h2v-1.268a2 2 0 111.5 0V14h2a2 2 0 002-2V7.732a2 2 0 11-1.5-3.732 2 2 0 011.5 3.732V12a3.5 3.5 0 01-3.5 3.5h-2V16.268a2 2 0 11-1.5 0V15.5H7A3.5 3.5 0 013.5 12V7.732A2 2 0 016 4z" />
    </svg>
  );
}

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
  title,
}: {
  connectionId: string;
  path?: string;
  level?: number;
  title?: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [uploadTargetPath, setUploadTargetPath] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const entries = useWorkspaceStore((s) => s.treeByConnection[connectionId]?.[path]);
  const loading = useWorkspaceStore((s) => s.loadingTreeByConnection[connectionId]?.[path] ?? false);
  const error = useWorkspaceStore((s) => s.treeErrorByConnection[connectionId]?.[path]);
  const loadTree = useWorkspaceStore((s) => s.loadTree);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const createItem = useWorkspaceStore((s) => s.createItem);
  const uploadFile = useWorkspaceStore((s) => s.uploadFile);
  const renameItem = useWorkspaceStore((s) => s.renameItem);
  const deleteItem = useWorkspaceStore((s) => s.deleteItem);
  const addCustomGitScope = useWorkspaceStore((s) => s.addCustomGitScope);
  const requestWorkspaceTab = useWorkspaceStore((s) => s.requestWorkspaceTab);

  const handleCreate = async (basePath: string, kind: FileEntry["kind"]) => {
    const label = kind === "directory" ? "目录" : "文件";
    const name = window.prompt(`请输入${label}名称`);
    if (name === null) return;
    await createItem(connectionId, basePath, name, kind);
  };

  const handleUploadClick = (basePath: string) => {
    setUploadTargetPath(basePath);
    if (uploadInputRef.current) {
      uploadInputRef.current.value = "";
      uploadInputRef.current.click();
    }
  };

  const handleUploadChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const target = uploadTargetPath ?? "";
    event.target.value = "";
    setUploadTargetPath(null);
    if (!file) return;
    await uploadFile(connectionId, target, file);
  };

  return (
    <div className="min-w-0 space-y-1">
      {title && (
        <div className="mb-2 flex min-w-0 items-center gap-1 rounded-md bg-surface px-2 py-1.5">
          <div className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">{title}</div>
          <ActionIconButton label="新建文件" onClick={() => void handleCreate(path, "file")}>
            <FilePlusIcon />
          </ActionIconButton>
          <ActionIconButton label="新建目录" onClick={() => void handleCreate(path, "directory")}>
            <FolderPlusIcon />
          </ActionIconButton>
          <ActionIconButton label="上传文件" onClick={() => handleUploadClick(path)}>
            <UploadIcon />
          </ActionIconButton>
        </div>
      )}
      <input
        ref={uploadInputRef}
        type="file"
        aria-hidden="true"
        tabIndex={-1}
        className="hidden"
        onChange={(event) => void handleUploadChange(event)}
      />
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

        const renderCreateActions = entry.kind === "directory" && !disabled;

        return (
          <div key={entry.path} data-file-entry className="min-w-0">
            <div className="group flex min-w-0 items-center rounded-md text-xs hover:bg-surface">
              <button
                type="button"
                disabled={disabled}
                onClick={handleClick}
                className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left ${
                  disabled
                    ? "cursor-not-allowed text-text-secondary/60"
                    : "text-text-primary"
                }`}
                style={{ paddingLeft: `${0.5 + level * 0.75}rem` }}
              >
                <span className="w-7 shrink-0 text-[10px] text-text-secondary">
                  {entry.kind === "directory" && isExpanded ? "v" : entryIcon(entry)}
                </span>
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {gitLabel && (
                  <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[10px] text-accent group-hover:hidden">
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
                  className="flex shrink-0 items-center gap-0 overflow-hidden opacity-0 transition-[max-width,opacity,padding] duration-150 ease-out max-w-0 group-hover:max-w-[200px] group-hover:opacity-100 group-hover:pr-1 group-focus-within:max-w-[200px] group-focus-within:opacity-100 group-focus-within:pr-1"
                >
                  {renderCreateActions && (
                    <>
                      <ActionIconButton label="新建文件" onClick={() => void handleCreate(entry.path, "file")}>
                        <FilePlusIcon />
                      </ActionIconButton>
                      <ActionIconButton label="新建目录" onClick={() => void handleCreate(entry.path, "directory")}>
                        <FolderPlusIcon />
                      </ActionIconButton>
                      <ActionIconButton label="上传文件" onClick={() => handleUploadClick(entry.path)}>
                        <UploadIcon />
                      </ActionIconButton>
                      <ActionIconButton
                        label="在 Git 面板查看"
                        onClick={() => {
                          void addCustomGitScope(connectionId, entry.path);
                          requestWorkspaceTab(connectionId, "git");
                        }}
                      >
                        <GitScopeIcon />
                      </ActionIconButton>
                    </>
                  )}
                  <ActionIconButton label="重命名" onClick={() => void handleRename()}>
                    <RenameIcon />
                  </ActionIconButton>
                  <ActionIconButton label="删除" tone="danger" onClick={() => void handleDelete()}>
                    <TrashIcon />
                  </ActionIconButton>
                </div>
              )}
            </div>
            {entry.kind === "directory" && isExpanded && !disabled && (
              <FileTree connectionId={connectionId} path={entry.path} level={level + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}
