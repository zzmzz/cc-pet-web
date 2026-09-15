import { useEffect, useState } from "react";
import { useConnectionStore } from "../../lib/store/connection.js";
import { useWorkspaceStore } from "../../lib/store/workspace.js";
import { FileTree } from "./FileTree.js";
import { GitChangesPanel } from "./GitChangesPanel.js";

export function WorkspacePanel() {
  const [activeTab, setActiveTab] = useState<"files" | "git">("files");
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const meta = useWorkspaceStore((s) =>
    activeConnectionId ? s.metaByConnection[activeConnectionId] : undefined,
  );
  const loading = useWorkspaceStore((s) =>
    activeConnectionId ? (s.loadingWorkspaceByConnection[activeConnectionId] ?? false) : false,
  );
  const operationMessage = useWorkspaceStore((s) =>
    activeConnectionId ? s.operationMessageByConnection[activeConnectionId] : "",
  );
  const operationError = useWorkspaceStore((s) =>
    activeConnectionId ? s.operationErrorByConnection[activeConnectionId] : "",
  );
  const pendingTab = useWorkspaceStore((s) =>
    activeConnectionId ? s.pendingWorkspaceTabByConnection[activeConnectionId] : undefined,
  );
  const loadWorkspace = useWorkspaceStore((s) => s.loadWorkspace);
  const consumePendingWorkspaceTab = useWorkspaceStore((s) => s.consumePendingWorkspaceTab);

  useEffect(() => {
    void loadWorkspace(activeConnectionId);
  }, [activeConnectionId, loadWorkspace]);

  useEffect(() => {
    if (!activeConnectionId || !pendingTab) return;
    setActiveTab(pendingTab);
    consumePendingWorkspaceTab(activeConnectionId);
  }, [activeConnectionId, pendingTab, consumePendingWorkspaceTab]);

  if (activeConnectionId && !loading && meta?.configured === false) {
    return null;
  }

  return (
    <section
      data-testid="workspace-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-border bg-surface-tertiary/40"
    >
      <header className="min-w-0 border-b border-border px-3 py-2">
        <div className="text-sm font-semibold text-text-primary">工作区</div>
        <div className="truncate text-[11px] text-text-secondary">
          {activeConnectionId ?? "暂无活动连接"}
        </div>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-2">
        {!activeConnectionId && (
          <div className="px-2 py-3 text-xs text-text-secondary">请选择一个连接后浏览工作区。</div>
        )}
        {activeConnectionId && loading && (
          <div className="px-2 py-3 text-xs text-text-secondary">工作区加载中...</div>
        )}
        {activeConnectionId && !loading && meta?.configured && (
          <>
            {operationMessage && (
              <div className="mb-2 rounded-md bg-green-500/10 px-2 py-1 text-xs text-green-400">
                {operationMessage}
              </div>
            )}
            {operationError && (
              <div className="mb-2 rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-400">
                {operationError}
              </div>
            )}
            <div className="mb-2 grid grid-cols-2 rounded-lg bg-surface p-1 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab("files")}
                className={`rounded-md px-2 py-1 ${
                  activeTab === "files" ? "bg-surface-secondary text-text-primary" : "text-text-secondary"
                }`}
              >
                文件
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("git")}
                className={`rounded-md px-2 py-1 ${
                  activeTab === "git" ? "bg-surface-secondary text-text-primary" : "text-text-secondary"
                }`}
              >
                Git 变更
              </button>
            </div>
            {activeTab === "files" ? (
              <FileTree connectionId={activeConnectionId} title={meta.rootName} />
            ) : (
              <GitChangesPanel connectionId={activeConnectionId} />
            )}
          </>
        )}
      </div>
    </section>
  );
}
