import { create } from "zustand";
import { getPlatform } from "../platform.js";

export interface WorkspaceMeta {
  connectionId: string;
  configured: boolean;
  rootName: string;
  message?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  extension?: string;
  size?: number;
  modifiedAt?: number;
  etag?: string;
  inaccessible?: boolean;
  gitStatus?: string;
}

export interface FilePreview {
  path: string;
  name: string;
  previewable: boolean;
  encoding?: "utf8";
  content?: string;
  size: number;
  modifiedAt?: number;
  etag?: string;
  reason?: string;
  message?: string;
}

export interface GitChange {
  path: string;
  status: string;
  previousPath?: string;
}

export type GitRepoMode = "root" | "nested" | "subpath";

export interface GitStatusResponse {
  gitAvailable: boolean;
  changes: GitChange[];
  message?: string;
  scope: string;
  repoMode: GitRepoMode;
  repoRoot: string;
}

export interface GitDiffResponse {
  path: string;
  previewable: boolean;
  diff?: string;
  reason?: string;
  message?: string;
  scope?: string;
  repoMode?: GitRepoMode;
  repoRoot?: string;
}

export interface GitScopeEntry {
  path: string;
  repoMode: "root" | "nested" | "custom";
  label?: string;
}

export interface GitScopesResponse {
  scopes: GitScopeEntry[];
  truncated?: boolean;
}

export type WorkspaceTab = "files" | "git";

interface ApiErrorResponse {
  error: string;
  message: string;
}

interface ItemMutationResponse {
  ok: true;
  entry: FileEntry;
}

interface DeleteItemResponse {
  ok: true;
}

interface WorkspaceState {
  activeConnectionId: string | null;
  metaByConnection: Record<string, WorkspaceMeta>;
  treeByConnection: Record<string, Record<string, FileEntry[]>>;
  treeErrorByConnection: Record<string, Record<string, string>>;
  gitStatusByConnection: Record<string, Record<string, GitStatusResponse>>;
  loadingGitStatusByConnection: Record<string, Record<string, boolean>>;
  gitScopesByConnection: Record<string, GitScopeEntry[]>;
  gitScopesTruncatedByConnection: Record<string, boolean>;
  loadingGitScopesByConnection: Record<string, boolean>;
  activeGitScopeByConnection: Record<string, string>;
  pendingWorkspaceTabByConnection: Record<string, WorkspaceTab | undefined>;
  operationMessageByConnection: Record<string, string>;
  operationErrorByConnection: Record<string, string>;
  loadingWorkspaceByConnection: Record<string, boolean>;
  loadingTreeByConnection: Record<string, Record<string, boolean>>;
  activeFile: FilePreview | null;
  activeDiff: GitDiffResponse | null;
  loadingFile: boolean;
  loadingDiff: boolean;
  savingFile: boolean;

  loadWorkspace: (connectionId: string | null) => Promise<void>;
  loadTree: (connectionId: string, path?: string) => Promise<void>;
  loadGitStatus: (connectionId: string, scope?: string) => Promise<void>;
  loadGitScopes: (connectionId: string) => Promise<void>;
  setActiveGitScope: (connectionId: string, scope: string) => Promise<void>;
  addCustomGitScope: (connectionId: string, subpath: string) => Promise<void>;
  requestWorkspaceTab: (connectionId: string, tab: WorkspaceTab) => void;
  consumePendingWorkspaceTab: (connectionId: string) => void;
  openFile: (connectionId: string, path: string) => Promise<void>;
  downloadFile: (connectionId: string, path: string) => Promise<void>;
  openDiff: (connectionId: string, path: string) => Promise<void>;
  createItem: (connectionId: string, parentPath: string, name: string, kind: FileEntry["kind"]) => Promise<boolean>;
  uploadFile: (connectionId: string, parentPath: string, file: File) => Promise<boolean>;
  renameItem: (connectionId: string, path: string, newName: string) => Promise<boolean>;
  deleteItem: (connectionId: string, path: string, recursive?: boolean) => Promise<boolean>;
  saveFile: (connectionId: string, path: string, content: string) => Promise<boolean>;
  closeFile: () => void;
  closeDiff: () => void;
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as ApiErrorResponse).error === "string" &&
      typeof (value as ApiErrorResponse).message === "string",
  );
}

function normalizeTreePath(path = ""): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function parentPathOf(path: string): string {
  const parts = normalizeTreePath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function changePathMatchesEntry(path: string | undefined, entry: FileEntry): boolean {
  if (!path) return false;
  const changePath = normalizeTreePath(path);
  const entryPath = normalizeTreePath(entry.path);
  if (changePath === entryPath) return true;
  return entry.kind === "directory" && changePath.startsWith(`${entryPath}/`);
}

function withGitStatuses(entries: FileEntry[], gitStatus?: GitStatusResponse): FileEntry[] {
  if (!gitStatus?.gitAvailable) return entries.map((entry) => ({ ...entry, gitStatus: undefined }));
  return entries.map((entry) => ({
    ...entry,
    gitStatus: gitStatus.changes.find(
      (change) => changePathMatchesEntry(change.path, entry) || changePathMatchesEntry(change.previousPath, entry),
    )?.status,
  }));
}

function mergeTreeWithGitStatus(
  tree: Record<string, FileEntry[]>,
  gitStatus?: GitStatusResponse,
): Record<string, FileEntry[]> {
  return Object.fromEntries(
    Object.entries(tree).map(([path, entries]) => [path, withGitStatuses(entries, gitStatus)]),
  );
}

function activeGitStatusFor(
  state: WorkspaceState,
  connectionId: string,
): GitStatusResponse | undefined {
  const scope = state.activeGitScopeByConnection[connectionId] ?? "";
  return state.gitStatusByConnection[connectionId]?.[scope];
}

function validateItemName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "名称不能为空。";
  if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    return "名称不能包含路径字符。";
  }
  return null;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function treeUrl(connectionId: string, path = ""): string {
  const normalized = normalizeTreePath(path);
  const base = `/api/workspaces/${encodeURIComponent(connectionId)}/tree`;
  return normalized ? `${base}?path=${encodeURIComponent(normalized)}` : base;
}

function gitStatusUrl(connectionId: string, scope: string): string {
  const base = `/api/workspaces/${encodeURIComponent(connectionId)}/git/status`;
  return scope ? `${base}?scope=${encodeURIComponent(scope)}` : base;
}

function gitDiffUrl(connectionId: string, filePath: string, scope: string): string {
  const params = new URLSearchParams({ path: filePath });
  if (scope) params.set("scope", scope);
  return `/api/workspaces/${encodeURIComponent(connectionId)}/git/diff?${params.toString()}`;
}

function gitScopesUrl(connectionId: string): string {
  return `/api/workspaces/${encodeURIComponent(connectionId)}/git/scopes`;
}

function mergeScopes(existing: GitScopeEntry[], incoming: GitScopeEntry[]): GitScopeEntry[] {
  const byPath = new Map<string, GitScopeEntry>();
  for (const scope of existing) byPath.set(scope.path, scope);
  for (const scope of incoming) {
    if (!byPath.has(scope.path)) byPath.set(scope.path, scope);
  }
  return Array.from(byPath.values());
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  activeConnectionId: null,
  metaByConnection: {},
  treeByConnection: {},
  treeErrorByConnection: {},
  gitStatusByConnection: {},
  loadingGitStatusByConnection: {},
  gitScopesByConnection: {},
  gitScopesTruncatedByConnection: {},
  loadingGitScopesByConnection: {},
  activeGitScopeByConnection: {},
  pendingWorkspaceTabByConnection: {},
  operationMessageByConnection: {},
  operationErrorByConnection: {},
  loadingWorkspaceByConnection: {},
  loadingTreeByConnection: {},
  activeFile: null,
  activeDiff: null,
  loadingFile: false,
  loadingDiff: false,
  savingFile: false,

  loadWorkspace: async (connectionId) => {
    if (!connectionId) {
      set({ activeConnectionId: null, activeFile: null, activeDiff: null });
      return;
    }
    set((state) => ({
      activeConnectionId: connectionId,
      activeFile: state.activeConnectionId === connectionId ? state.activeFile : null,
      activeDiff: state.activeConnectionId === connectionId ? state.activeDiff : null,
      loadingWorkspaceByConnection: {
        ...state.loadingWorkspaceByConnection,
        [connectionId]: true,
      },
    }));
    try {
      const response = await getPlatform().fetchApi<WorkspaceMeta | ApiErrorResponse>(
        `/api/workspaces/${encodeURIComponent(connectionId)}`,
      );
      if (isApiErrorResponse(response)) {
        set((state) => ({
          metaByConnection: {
            ...state.metaByConnection,
            [connectionId]: {
              connectionId,
              configured: false,
              rootName: "",
              message: response.message,
            },
          },
          treeByConnection: {
            ...state.treeByConnection,
            [connectionId]: {},
          },
          gitStatusByConnection: {
            ...state.gitStatusByConnection,
            [connectionId]: {
              "": {
                gitAvailable: false,
                changes: [],
                message: response.message,
                scope: "",
                repoMode: "root",
                repoRoot: "",
              },
            },
          },
          loadingWorkspaceByConnection: {
            ...state.loadingWorkspaceByConnection,
            [connectionId]: false,
          },
        }));
        return;
      }

      set((state) => ({
        metaByConnection: {
          ...state.metaByConnection,
          [connectionId]: response,
        },
        activeGitScopeByConnection: {
          ...state.activeGitScopeByConnection,
          [connectionId]: state.activeGitScopeByConnection[connectionId] ?? "",
        },
        loadingWorkspaceByConnection: {
          ...state.loadingWorkspaceByConnection,
          [connectionId]: false,
        },
      }));
      if (response.configured) {
        await get().loadTree(connectionId);
        await Promise.all([
          get().loadGitStatus(connectionId),
          get().loadGitScopes(connectionId),
        ]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "工作区加载失败";
      set((state) => ({
        metaByConnection: {
          ...state.metaByConnection,
          [connectionId]: {
            connectionId,
            configured: false,
            rootName: "",
            message,
          },
        },
        loadingWorkspaceByConnection: {
          ...state.loadingWorkspaceByConnection,
          [connectionId]: false,
        },
      }));
    }
  },

  loadTree: async (connectionId, path = "") => {
    const normalized = normalizeTreePath(path);
    set((state) => ({
      loadingTreeByConnection: {
        ...state.loadingTreeByConnection,
        [connectionId]: {
          ...(state.loadingTreeByConnection[connectionId] ?? {}),
          [normalized]: true,
        },
      },
    }));
    try {
      const response = await getPlatform().fetchApi<{ path: string; entries: FileEntry[] } | ApiErrorResponse>(
        treeUrl(connectionId, normalized),
      );
      if (isApiErrorResponse(response)) {
        set((state) => ({
          treeErrorByConnection: {
            ...state.treeErrorByConnection,
            [connectionId]: {
              ...(state.treeErrorByConnection[connectionId] ?? {}),
              [normalized]: response.message,
            },
          },
          loadingTreeByConnection: {
            ...state.loadingTreeByConnection,
            [connectionId]: {
              ...(state.loadingTreeByConnection[connectionId] ?? {}),
              [normalized]: false,
            },
          },
        }));
        return;
      }
      const responsePath = normalizeTreePath(response.path);
      set((state) => ({
        treeByConnection: {
          ...state.treeByConnection,
          [connectionId]: {
            ...(state.treeByConnection[connectionId] ?? {}),
            [responsePath]: withGitStatuses(response.entries ?? [], activeGitStatusFor(state, connectionId)),
          },
        },
        treeErrorByConnection: {
          ...state.treeErrorByConnection,
          [connectionId]: {
            ...(state.treeErrorByConnection[connectionId] ?? {}),
            [responsePath]: "",
          },
        },
        loadingTreeByConnection: {
          ...state.loadingTreeByConnection,
          [connectionId]: {
            ...(state.loadingTreeByConnection[connectionId] ?? {}),
            [responsePath]: false,
          },
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "目录加载失败";
      set((state) => ({
        treeErrorByConnection: {
          ...state.treeErrorByConnection,
          [connectionId]: {
            ...(state.treeErrorByConnection[connectionId] ?? {}),
            [normalized]: message,
          },
        },
        loadingTreeByConnection: {
          ...state.loadingTreeByConnection,
          [connectionId]: {
            ...(state.loadingTreeByConnection[connectionId] ?? {}),
            [normalized]: false,
          },
        },
      }));
    }
  },

  loadGitStatus: async (connectionId, scope) => {
    const targetScope = scope ?? get().activeGitScopeByConnection[connectionId] ?? "";
    set((state) => ({
      loadingGitStatusByConnection: {
        ...state.loadingGitStatusByConnection,
        [connectionId]: {
          ...(state.loadingGitStatusByConnection[connectionId] ?? {}),
          [targetScope]: true,
        },
      },
    }));
    try {
      const response = await getPlatform().fetchApi<GitStatusResponse | ApiErrorResponse>(
        gitStatusUrl(connectionId, targetScope),
      );
      const gitStatus: GitStatusResponse = isApiErrorResponse(response)
        ? {
            gitAvailable: false,
            changes: [],
            message: response.message,
            scope: targetScope,
            repoMode: "root",
            repoRoot: "",
          }
        : response;
      set((state) => {
        const nextStatusByScope = {
          ...(state.gitStatusByConnection[connectionId] ?? {}),
          [targetScope]: gitStatus,
        };
        const activeScope = state.activeGitScopeByConnection[connectionId] ?? "";
        const treeStatus = activeScope === targetScope ? gitStatus : nextStatusByScope[activeScope];
        return {
          gitStatusByConnection: {
            ...state.gitStatusByConnection,
            [connectionId]: nextStatusByScope,
          },
          treeByConnection: {
            ...state.treeByConnection,
            [connectionId]: mergeTreeWithGitStatus(state.treeByConnection[connectionId] ?? {}, treeStatus),
          },
          loadingGitStatusByConnection: {
            ...state.loadingGitStatusByConnection,
            [connectionId]: {
              ...(state.loadingGitStatusByConnection[connectionId] ?? {}),
              [targetScope]: false,
            },
          },
        };
      });
    } catch (error) {
      const gitStatus: GitStatusResponse = {
        gitAvailable: false,
        changes: [],
        message: error instanceof Error ? error.message : "Git 状态加载失败",
        scope: targetScope,
        repoMode: "root",
        repoRoot: "",
      };
      set((state) => {
        const nextStatusByScope = {
          ...(state.gitStatusByConnection[connectionId] ?? {}),
          [targetScope]: gitStatus,
        };
        const activeScope = state.activeGitScopeByConnection[connectionId] ?? "";
        const treeStatus = activeScope === targetScope ? gitStatus : nextStatusByScope[activeScope];
        return {
          gitStatusByConnection: {
            ...state.gitStatusByConnection,
            [connectionId]: nextStatusByScope,
          },
          treeByConnection: {
            ...state.treeByConnection,
            [connectionId]: mergeTreeWithGitStatus(state.treeByConnection[connectionId] ?? {}, treeStatus),
          },
          loadingGitStatusByConnection: {
            ...state.loadingGitStatusByConnection,
            [connectionId]: {
              ...(state.loadingGitStatusByConnection[connectionId] ?? {}),
              [targetScope]: false,
            },
          },
        };
      });
    }
  },

  loadGitScopes: async (connectionId) => {
    set((state) => ({
      loadingGitScopesByConnection: {
        ...state.loadingGitScopesByConnection,
        [connectionId]: true,
      },
    }));
    try {
      const response = await getPlatform().fetchApi<GitScopesResponse | ApiErrorResponse>(
        gitScopesUrl(connectionId),
      );
      const scopes = isApiErrorResponse(response) ? [] : response.scopes ?? [];
      const truncated = !isApiErrorResponse(response) && Boolean(response.truncated);
      set((state) => ({
        gitScopesByConnection: {
          ...state.gitScopesByConnection,
          [connectionId]: mergeScopes(state.gitScopesByConnection[connectionId] ?? [], scopes),
        },
        gitScopesTruncatedByConnection: {
          ...state.gitScopesTruncatedByConnection,
          [connectionId]: truncated,
        },
        loadingGitScopesByConnection: {
          ...state.loadingGitScopesByConnection,
          [connectionId]: false,
        },
      }));
    } catch {
      set((state) => ({
        loadingGitScopesByConnection: {
          ...state.loadingGitScopesByConnection,
          [connectionId]: false,
        },
      }));
    }
  },

  setActiveGitScope: async (connectionId, scope) => {
    const normalized = scope ?? "";
    set((state) => {
      const nextStatusByScope = state.gitStatusByConnection[connectionId] ?? {};
      const treeStatus = nextStatusByScope[normalized];
      return {
        activeGitScopeByConnection: {
          ...state.activeGitScopeByConnection,
          [connectionId]: normalized,
        },
        treeByConnection: {
          ...state.treeByConnection,
          [connectionId]: mergeTreeWithGitStatus(state.treeByConnection[connectionId] ?? {}, treeStatus),
        },
      };
    });
    if (!get().gitStatusByConnection[connectionId]?.[normalized]) {
      await get().loadGitStatus(connectionId, normalized);
    }
  },

  addCustomGitScope: async (connectionId, subpath) => {
    const normalized = normalizeTreePath(subpath);
    if (!normalized) {
      await get().setActiveGitScope(connectionId, "");
      return;
    }
    set((state) => {
      const existing = state.gitScopesByConnection[connectionId] ?? [];
      if (existing.some((scope) => scope.path === normalized)) return {};
      return {
        gitScopesByConnection: {
          ...state.gitScopesByConnection,
          [connectionId]: [...existing, { path: normalized, repoMode: "custom", label: normalized }],
        },
      };
    });
    await get().setActiveGitScope(connectionId, normalized);
  },

  requestWorkspaceTab: (connectionId, tab) => {
    set((state) => ({
      pendingWorkspaceTabByConnection: {
        ...state.pendingWorkspaceTabByConnection,
        [connectionId]: tab,
      },
    }));
  },

  consumePendingWorkspaceTab: (connectionId) => {
    set((state) => {
      if (!(connectionId in state.pendingWorkspaceTabByConnection)) return {};
      const next = { ...state.pendingWorkspaceTabByConnection };
      delete next[connectionId];
      return { pendingWorkspaceTabByConnection: next };
    });
  },

  openFile: async (connectionId, path) => {
    const normalized = normalizeTreePath(path);
    set({ loadingFile: true, activeDiff: null, loadingDiff: false });
    try {
      const response = await getPlatform().fetchApi<FilePreview | ApiErrorResponse>(
        `/api/workspaces/${encodeURIComponent(connectionId)}/file?path=${encodeURIComponent(normalized)}`,
      );
      if (isApiErrorResponse(response)) {
        set({
          activeFile: {
            path: normalized,
            name: basename(normalized),
            previewable: false,
            size: 0,
            reason: response.error,
            message: response.message,
          },
          loadingFile: false,
        });
        return;
      }
      set({ activeFile: response, loadingFile: false });
    } catch (error) {
      set({
        activeFile: {
          path: normalized,
          name: basename(normalized),
          previewable: false,
          size: 0,
          reason: "WORKSPACE_FILE_READ_FAILED",
          message: error instanceof Error ? error.message : "文件加载失败",
        },
        loadingFile: false,
      });
    }
  },

  downloadFile: async (connectionId, path) => {
    const normalized = normalizeTreePath(path);
    const name = basename(normalized);
    try {
      const response = await getPlatform().fetchApiRaw(
        `/api/workspaces/${encodeURIComponent(connectionId)}/file/download?path=${encodeURIComponent(normalized)}`,
      );
      if (!response.ok) {
        let message = `文件下载失败（${response.status}）`;
        try {
          const body = await response.json();
          if (isApiErrorResponse(body)) message = body.message;
        } catch {
          // body may not be JSON; keep default message
        }
        set((state) => ({
          operationErrorByConnection: {
            ...state.operationErrorByConnection,
            [connectionId]: message,
          },
          operationMessageByConnection: {
            ...state.operationMessageByConnection,
            [connectionId]: "",
          },
        }));
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      set((state) => ({
        operationErrorByConnection: {
          ...state.operationErrorByConnection,
          [connectionId]: error instanceof Error ? error.message : "文件下载失败",
        },
      }));
    }
  },

  openDiff: async (connectionId, path) => {
    const normalized = normalizeTreePath(path);
    const scope = get().activeGitScopeByConnection[connectionId] ?? "";
    set({ loadingDiff: true, activeFile: null, loadingFile: false });
    try {
      const response = await getPlatform().fetchApi<GitDiffResponse | ApiErrorResponse>(
        gitDiffUrl(connectionId, normalized, scope),
      );
      if (isApiErrorResponse(response)) {
        set({
          activeDiff: {
            path: normalized,
            previewable: false,
            reason: response.error,
            message: response.message,
          },
          loadingDiff: false,
        });
        return;
      }
      set({ activeDiff: response, loadingDiff: false });
    } catch (error) {
      set({
        activeDiff: {
          path: normalized,
          previewable: false,
          reason: "WORKSPACE_DIFF_READ_FAILED",
          message: error instanceof Error ? error.message : "Diff 加载失败",
        },
        loadingDiff: false,
      });
    }
  },

  createItem: async (connectionId, parentPath, name, kind) => {
    const normalizedParentPath = normalizeTreePath(parentPath);
    const validationError = validateItemName(name);
    if (validationError) {
      set((state) => ({
        operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
        operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: validationError },
      }));
      return false;
    }

    try {
      const response = await getPlatform().fetchApi<ItemMutationResponse | ApiErrorResponse>(
        `/api/workspaces/${encodeURIComponent(connectionId)}/items`,
        jsonRequest("POST", { parentPath: normalizedParentPath, name: name.trim(), kind }),
      );
      if (isApiErrorResponse(response)) {
        set((state) => ({
          operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
          operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: response.message },
        }));
        return false;
      }
      set((state) => ({
        operationMessageByConnection: {
          ...state.operationMessageByConnection,
          [connectionId]: `已创建 ${response.entry.name}`,
        },
        operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: "" },
      }));
      await get().loadTree(connectionId, normalizedParentPath);
      await get().loadGitStatus(connectionId);
      return true;
    } catch (error) {
      set((state) => ({
        operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
        operationErrorByConnection: {
          ...state.operationErrorByConnection,
          [connectionId]: error instanceof Error ? error.message : "创建失败",
        },
      }));
      return false;
    }
  },

  uploadFile: async (connectionId, parentPath, file) => {
    const normalizedParentPath = normalizeTreePath(parentPath);
    const validationError = validateItemName(file.name);
    if (validationError) {
      set((state) => ({
        operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
        operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: validationError },
      }));
      return false;
    }
    try {
      const form = new FormData();
      form.append("parentPath", normalizedParentPath);
      form.append("name", file.name);
      form.append("file", file, file.name);
      const response = await getPlatform().fetchApi<ItemMutationResponse | ApiErrorResponse>(
        `/api/workspaces/${encodeURIComponent(connectionId)}/items/upload`,
        { method: "POST", body: form },
      );
      if (isApiErrorResponse(response)) {
        set((state) => ({
          operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
          operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: response.message },
        }));
        return false;
      }
      set((state) => ({
        operationMessageByConnection: {
          ...state.operationMessageByConnection,
          [connectionId]: `已上传 ${response.entry.name}`,
        },
        operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: "" },
      }));
      await get().loadTree(connectionId, normalizedParentPath);
      await get().loadGitStatus(connectionId);
      return true;
    } catch (error) {
      set((state) => ({
        operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
        operationErrorByConnection: {
          ...state.operationErrorByConnection,
          [connectionId]: error instanceof Error ? error.message : "上传失败",
        },
      }));
      return false;
    }
  },

  renameItem: async (connectionId, path, newName) => {
    const normalizedPath = normalizeTreePath(path);
    const validationError = validateItemName(newName);
    if (validationError) {
      set((state) => ({
        operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
        operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: validationError },
      }));
      return false;
    }

    try {
      const response = await getPlatform().fetchApi<ItemMutationResponse | ApiErrorResponse>(
        `/api/workspaces/${encodeURIComponent(connectionId)}/items`,
        jsonRequest("PATCH", { path: normalizedPath, newName: newName.trim() }),
      );
      if (isApiErrorResponse(response)) {
        set((state) => ({
          operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
          operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: response.message },
        }));
        return false;
      }
      const parentPath = parentPathOf(normalizedPath);
      set((state) => {
        const activeFile = state.activeFile?.path === normalizedPath
          ? {
              ...state.activeFile,
              path: response.entry.path,
              name: response.entry.name,
            }
          : state.activeFile;
        return {
          activeFile,
          operationMessageByConnection: {
            ...state.operationMessageByConnection,
            [connectionId]: `已重命名为 ${response.entry.name}`,
          },
          operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: "" },
        };
      });
      await get().loadTree(connectionId, parentPath);
      await get().loadGitStatus(connectionId);
      return true;
    } catch (error) {
      set((state) => ({
        operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
        operationErrorByConnection: {
          ...state.operationErrorByConnection,
          [connectionId]: error instanceof Error ? error.message : "重命名失败",
        },
      }));
      return false;
    }
  },

  deleteItem: async (connectionId, path, recursive = false) => {
    const normalizedPath = normalizeTreePath(path);
    try {
      const response = await getPlatform().fetchApi<DeleteItemResponse | ApiErrorResponse>(
        `/api/workspaces/${encodeURIComponent(connectionId)}/items`,
        jsonRequest("DELETE", { path: normalizedPath, recursive }),
      );
      if (isApiErrorResponse(response)) {
        set((state) => ({
          operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
          operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: response.message },
        }));
        return false;
      }
      const parentPath = parentPathOf(normalizedPath);
      set((state) => ({
        activeFile: state.activeFile?.path === normalizedPath || state.activeFile?.path.startsWith(`${normalizedPath}/`)
          ? null
          : state.activeFile,
        operationMessageByConnection: {
          ...state.operationMessageByConnection,
          [connectionId]: `已删除 ${basename(normalizedPath)}`,
        },
        operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: "" },
      }));
      await get().loadTree(connectionId, parentPath);
      await get().loadGitStatus(connectionId);
      return true;
    } catch (error) {
      set((state) => ({
        operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
        operationErrorByConnection: {
          ...state.operationErrorByConnection,
          [connectionId]: error instanceof Error ? error.message : "删除失败",
        },
      }));
      return false;
    }
  },

  saveFile: async (connectionId, path, content) => {
    const normalizedPath = normalizeTreePath(path);
    set({ savingFile: true });
    try {
      const response = await getPlatform().fetchApi<ItemMutationResponse | ApiErrorResponse>(
        `/api/workspaces/${encodeURIComponent(connectionId)}/file`,
        jsonRequest("PUT", { path: normalizedPath, content, etag: get().activeFile?.etag }),
      );
      if (isApiErrorResponse(response)) {
        set((state) => ({
          savingFile: false,
          operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
          operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: response.message },
        }));
        return false;
      }
      const size = new TextEncoder().encode(content).length;
      set((state) => ({
        savingFile: false,
        activeFile: state.activeFile?.path === normalizedPath
          ? {
              ...state.activeFile,
              previewable: true,
              encoding: "utf8",
              content,
              size,
              modifiedAt: response.entry.modifiedAt,
              etag: response.entry.etag,
              reason: undefined,
              message: undefined,
            }
          : state.activeFile,
        operationMessageByConnection: {
          ...state.operationMessageByConnection,
          [connectionId]: `已保存 ${response.entry.name}`,
        },
        operationErrorByConnection: { ...state.operationErrorByConnection, [connectionId]: "" },
      }));
      await get().loadTree(connectionId, parentPathOf(normalizedPath));
      await get().loadGitStatus(connectionId);
      return true;
    } catch (error) {
      set((state) => ({
        savingFile: false,
        operationMessageByConnection: { ...state.operationMessageByConnection, [connectionId]: "" },
        operationErrorByConnection: {
          ...state.operationErrorByConnection,
          [connectionId]: error instanceof Error ? error.message : "保存失败",
        },
      }));
      return false;
    }
  },

  closeFile: () => set({ activeFile: null, loadingFile: false }),
  closeDiff: () => set({ activeDiff: null, loadingDiff: false }),
}));
