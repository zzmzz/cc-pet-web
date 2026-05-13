import { useEffect, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism/index.js";
import { useWorkspaceStore } from "../../lib/store/workspace.js";

const extLangMap: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", cs: "csharp",
  cpp: "cpp", c: "c", h: "c", hpp: "cpp",
  html: "html", css: "css", scss: "scss", less: "less",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  xml: "xml", sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
  md: "markdown", graphql: "graphql", dockerfile: "docker",
  lua: "lua", php: "php", r: "r", dart: "dart",
};

function getLanguageFromFilename(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return extLangMap[ext] ?? "text";
}

function previewMessage(reason?: string, fallback?: string): string {
  if (reason === "FILE_TOO_LARGE") return "文件过大，无法直接预览。";
  if (reason === "BINARY_FILE") return "二进制文件无法直接预览。";
  return fallback ?? "文件无法直接预览。";
}

export function FileViewer({ variant = "desktop" }: { variant?: "desktop" | "mobile" }) {
  const activeFile = useWorkspaceStore((s) => s.activeFile);
  const activeConnectionId = useWorkspaceStore((s) => s.activeConnectionId);
  const loadingFile = useWorkspaceStore((s) => s.loadingFile);
  const savingFile = useWorkspaceStore((s) => s.savingFile);
  const closeFile = useWorkspaceStore((s) => s.closeFile);
  const saveFile = useWorkspaceStore((s) => s.saveFile);
  const downloadFile = useWorkspaceStore((s) => s.downloadFile);
  const [draftContent, setDraftContent] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setDraftContent(activeFile?.content ?? "");
    setEditing(false);
  }, [activeFile?.path, activeFile?.content]);

  if (!activeFile && !loadingFile) return null;

  const isDirty = activeFile?.previewable === true && draftContent !== (activeFile.content ?? "");
  const handleSave = async () => {
    if (!activeConnectionId || !activeFile?.previewable) return;
    await saveFile(activeConnectionId, activeFile.path, draftContent);
    setEditing(false);
  };
  const handleDownload = async () => {
    if (!activeConnectionId || !activeFile?.path) return;
    await downloadFile(activeConnectionId, activeFile.path);
  };
  const containerClass = variant === "mobile"
    ? "flex min-h-0 max-h-[55vh] w-full flex-col border-t border-border bg-surface-secondary"
    : "flex w-[34rem] max-w-[45%] shrink-0 flex-col border-l border-border bg-surface-secondary";

  return (
    <aside className={containerClass}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">
            {activeFile?.name ?? "文件加载中"}
          </div>
          {activeFile?.path && (
            <div className="truncate text-[11px] text-text-secondary">{activeFile.path}</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={!activeFile?.path}
          className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
          title="下载原始文件"
        >
          下载
        </button>
        <button
          type="button"
          onClick={closeFile}
          className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface"
        >
          关闭
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loadingFile && <div className="text-sm text-text-secondary">文件加载中...</div>}
        {!loadingFile && activeFile && activeFile.previewable && (
          <div className="flex h-full min-h-[18rem] flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">{editing ? "文本编辑" : "文件预览"}</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setEditing(!editing)}
                  className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface"
                >
                  {editing ? "预览" : "编辑"}
                </button>
                {editing && (
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={!isDirty || savingFile}
                    className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {savingFile ? "保存中..." : "保存"}
                  </button>
                )}
              </div>
            </div>
            {editing ? (
              <textarea
                aria-label="文件内容"
                value={draftContent}
                onChange={(event) => setDraftContent(event.target.value)}
                className="min-h-0 flex-1 resize-none rounded-lg bg-surface p-3 font-mono text-xs leading-5 text-text-primary outline-none focus:ring-2 focus:ring-accent/30"
                spellCheck={false}
              />
            ) : (
              <div className="min-h-0 flex-1 overflow-auto rounded-lg">
                <SyntaxHighlighter
                  language={getLanguageFromFilename(activeFile.name)}
                  style={oneDark}
                  customStyle={{ margin: 0, borderRadius: "0.5rem", fontSize: "0.75rem", lineHeight: "1.25rem", height: "100%" }}
                  showLineNumbers
                >
                  {draftContent}
                </SyntaxHighlighter>
              </div>
            )}
          </div>
        )}
        {!loadingFile && activeFile && !activeFile.previewable && (
          <div className="rounded-lg border border-border bg-surface p-3 text-sm text-text-secondary">
            {previewMessage(activeFile.reason, activeFile.message)}
          </div>
        )}
      </div>
    </aside>
  );
}
