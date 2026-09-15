import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceContext } from "./resolver.js";
import { assertWritableChildPath, assertWritablePath, resolveWorkspacePath } from "./resolver.js";

export const FILE_PREVIEW_MAX_BYTES = 64 * 1024;

export type FileKind = "file" | "directory";

export interface WorkspaceMeta {
  connectionId: string;
  configured: boolean;
  rootName: string;
  message?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: FileKind;
  extension?: string;
  size?: number;
  modifiedAt?: number;
  etag?: string;
  inaccessible?: boolean;
}

export interface FilePreview {
  path: string;
  name: string;
  previewable: boolean;
  encoding?: "utf8";
  content?: string;
  size: number;
  modifiedAt: number;
  etag: string;
  reason?: "FILE_TOO_LARGE" | "BINARY_FILE";
}

export type WorkspaceFileErrorCode =
  | "WORKSPACE_PATH_NOT_DIRECTORY"
  | "WORKSPACE_PATH_NOT_FILE"
  | "WORKSPACE_DIRECTORY_UNREADABLE"
  | "WORKSPACE_FILE_NOT_FOUND"
  | "WORKSPACE_NAME_INVALID"
  | "WORKSPACE_ITEM_KIND_INVALID"
  | "WORKSPACE_ITEM_ALREADY_EXISTS"
  | "WORKSPACE_DIRECTORY_NOT_EMPTY"
  | "WORKSPACE_LIST_STALE"
  | "WORKSPACE_CONTENT_INVALID"
  | "WORKSPACE_FILE_TOO_LARGE";

export class WorkspaceFileError extends Error {
  constructor(
    public readonly code: WorkspaceFileErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

function toApiPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function joinRelativePath(parentPath: string, name: string): string {
  return toApiPath(parentPath ? path.join(parentPath, name) : name);
}

function parentRelativePath(relativePath: string): string {
  const parent = path.dirname(relativePath);
  return parent === "." ? "" : toApiPath(parent);
}

function extensionFor(name: string, kind: FileKind): string | undefined {
  if (kind !== "file") return undefined;
  const extension = path.extname(name);
  return extension || undefined;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function etagForStats(stats: { mtimeMs: number; size: number }): string {
  return `${stats.mtimeMs}:${stats.size}`;
}

function workspaceFileError(
  code: WorkspaceFileErrorCode,
  message: string,
  statusCode: number,
): WorkspaceFileError {
  return new WorkspaceFileError(code, message, statusCode);
}

function staleListError(message = "列表已过期，可刷新后继续。"): WorkspaceFileError {
  return workspaceFileError("WORKSPACE_LIST_STALE", message, 404);
}

function conflictError(message = "目标已存在，列表已过期，可刷新后继续。"): WorkspaceFileError {
  return workspaceFileError("WORKSPACE_ITEM_ALREADY_EXISTS", message, 400);
}

function validateItemName(name: unknown): string {
  if (typeof name !== "string") {
    throw workspaceFileError("WORKSPACE_NAME_INVALID", "名称不能为空。", 400);
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw workspaceFileError("WORKSPACE_NAME_INVALID", "名称不能为空。", 400);
  }
  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw workspaceFileError("WORKSPACE_NAME_INVALID", "名称不能包含路径字符。", 400);
  }
  return trimmed;
}

async function entryForResolvedPath(relativePath: string, absolutePath: string): Promise<FileEntry> {
  const stats = await stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw staleListError();
    throw error;
  });
  const kind: FileKind = stats.isDirectory() ? "directory" : "file";
  const normalizedPath = toApiPath(relativePath);
  const name = path.basename(normalizedPath);
  return {
    name,
    path: normalizedPath,
    kind,
    extension: extensionFor(name, kind),
    size: kind === "file" ? stats.size : undefined,
    modifiedAt: stats.mtimeMs,
    etag: kind === "file" ? etagForStats(stats) : undefined,
    inaccessible: false,
  };
}

async function assertDirectory(absolutePath: string, notFoundMessage: string): Promise<void> {
  const stats = await stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw staleListError(notFoundMessage);
    throw error;
  });
  if (!stats.isDirectory()) {
    throw workspaceFileError("WORKSPACE_PATH_NOT_DIRECTORY", "Workspace path is not a directory", 400);
  }
}

export async function listDirectory(
  workspace: WorkspaceContext,
  relativePath = "",
): Promise<{ path: string; entries: FileEntry[] }> {
  const resolved = await resolveWorkspacePath(workspace, relativePath);
  const directoryStats = await stat(resolved.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw workspaceFileError("WORKSPACE_FILE_NOT_FOUND", "Directory was not found", 404);
    }
    throw error;
  });
  if (!directoryStats.isDirectory()) {
    throw workspaceFileError("WORKSPACE_PATH_NOT_DIRECTORY", "Workspace path is not a directory", 400);
  }

  const dirents = await readdir(resolved.absolutePath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EACCES" || error.code === "EPERM") {
      throw workspaceFileError("WORKSPACE_DIRECTORY_UNREADABLE", "Directory is not accessible", 403);
    }
    throw error;
  });
  const entries = await Promise.all(
    dirents.map(async (dirent): Promise<FileEntry> => {
      const entryPath = joinRelativePath(resolved.relativePath, dirent.name);
      const fallbackKind: FileKind = dirent.isDirectory() ? "directory" : "file";
      try {
        const child = await resolveWorkspacePath(workspace, entryPath);
        const childStats = await stat(child.absolutePath);
        const kind: FileKind = childStats.isDirectory() ? "directory" : "file";
        return {
          name: dirent.name,
          path: toApiPath(child.relativePath),
          kind,
          extension: extensionFor(dirent.name, kind),
          size: kind === "file" ? childStats.size : undefined,
          modifiedAt: childStats.mtimeMs,
          etag: kind === "file" ? etagForStats(childStats) : undefined,
          inaccessible: false,
        };
      } catch {
        return {
          name: dirent.name,
          path: entryPath,
          kind: fallbackKind,
          extension: extensionFor(dirent.name, fallbackKind),
          inaccessible: true,
        };
      }
    }),
  );

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
  return { path: toApiPath(resolved.relativePath), entries };
}

export async function readFilePreview(
  workspace: WorkspaceContext,
  relativePath: string,
): Promise<FilePreview> {
  const resolved = await resolveWorkspacePath(workspace, relativePath);
  const fileStats = await stat(resolved.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw workspaceFileError("WORKSPACE_FILE_NOT_FOUND", "File was not found", 404);
    }
    throw error;
  });
  if (!fileStats.isFile()) {
    throw workspaceFileError("WORKSPACE_PATH_NOT_FILE", "Workspace path is not a file", 400);
  }

  const normalizedPath = toApiPath(resolved.relativePath);
  const name = path.basename(normalizedPath);
  if (fileStats.size > FILE_PREVIEW_MAX_BYTES) {
    return {
      path: normalizedPath,
      name,
      previewable: false,
      size: fileStats.size,
      modifiedAt: fileStats.mtimeMs,
      etag: etagForStats(fileStats),
      reason: "FILE_TOO_LARGE",
    };
  }

  const buffer = await readFile(resolved.absolutePath);
  if (isBinaryBuffer(buffer)) {
    return {
      path: normalizedPath,
      name,
      previewable: false,
      size: fileStats.size,
      modifiedAt: fileStats.mtimeMs,
      etag: etagForStats(fileStats),
      reason: "BINARY_FILE",
    };
  }

  return {
    path: normalizedPath,
    name,
    previewable: true,
    encoding: "utf8",
    content: buffer.toString("utf8"),
    size: fileStats.size,
    modifiedAt: fileStats.mtimeMs,
    etag: etagForStats(fileStats),
  };
}

export const FILE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export async function uploadFile(
  workspace: WorkspaceContext,
  parentPath: string | undefined,
  name: unknown,
  data: Buffer,
): Promise<FileEntry> {
  if (data.byteLength > FILE_UPLOAD_MAX_BYTES) {
    throw workspaceFileError(
      "WORKSPACE_FILE_TOO_LARGE",
      `文件过大，单个上传不超过 ${Math.floor(FILE_UPLOAD_MAX_BYTES / (1024 * 1024))} MB。`,
      400,
    );
  }

  const safeName = validateItemName(name);
  const parent = await resolveWorkspacePath(workspace, parentPath ?? "");
  await assertDirectory(parent.absolutePath, "父目录已不存在，列表已过期，可刷新后继续。");

  const targetRelativePath = joinRelativePath(parent.relativePath, safeName);
  const target = await assertWritablePath(workspace, targetRelativePath);
  const existing = await stat(target.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    throw conflictError("同名文件已存在，请重命名后再上传。");
  }

  try {
    await writeFile(target.absolutePath, data, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw conflictError("同名文件已存在，请重命名后再上传。");
    }
    throw error;
  }

  return entryForResolvedPath(target.relativePath, target.absolutePath);
}

export async function createItem(
  workspace: WorkspaceContext,
  parentPath: string | undefined,
  name: unknown,
  kind: unknown,
): Promise<FileEntry> {
  if (kind !== "file" && kind !== "directory") {
    throw workspaceFileError("WORKSPACE_ITEM_KIND_INVALID", "Item kind must be file or directory", 400);
  }

  const safeName = validateItemName(name);
  const parent = await resolveWorkspacePath(workspace, parentPath ?? "");
  await assertDirectory(parent.absolutePath, "父目录已不存在，列表已过期，可刷新后继续。");

  const targetRelativePath = joinRelativePath(parent.relativePath, safeName);
  const target = await assertWritablePath(workspace, targetRelativePath);
  const existing = await stat(target.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    throw conflictError();
  }

  try {
    if (kind === "directory") {
      await mkdir(target.absolutePath);
    } else {
      await writeFile(target.absolutePath, "", { flag: "wx" });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw conflictError();
    }
    throw error;
  }

  return entryForResolvedPath(target.relativePath, target.absolutePath);
}

export async function renameItem(
  workspace: WorkspaceContext,
  relativePath: string,
  newName: unknown,
): Promise<FileEntry> {
  const safeName = validateItemName(newName);
  const source = await assertWritableChildPath(workspace, relativePath);
  await stat(source.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw staleListError();
    throw error;
  });

  const parentPath = parentRelativePath(source.relativePath);
  const targetRelativePath = joinRelativePath(parentPath, safeName);
  const target = await assertWritablePath(workspace, targetRelativePath);
  const existing = await stat(target.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    throw conflictError();
  }

  try {
    await rename(source.absolutePath, target.absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw staleListError();
    if (code === "EEXIST") throw conflictError();
    throw error;
  }

  return entryForResolvedPath(target.relativePath, target.absolutePath);
}

export async function deleteItem(
  workspace: WorkspaceContext,
  relativePath: string,
  recursive = false,
): Promise<{ ok: true }> {
  const target = await assertWritableChildPath(workspace, relativePath);
  const targetStats = await stat(target.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw staleListError();
    throw error;
  });

  if (targetStats.isDirectory() && !recursive) {
    const entries = await readdir(target.absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw staleListError();
      throw error;
    });
    if (entries.length > 0) {
      throw workspaceFileError(
        "WORKSPACE_DIRECTORY_NOT_EMPTY",
        "目录不为空，确认后可递归删除。",
        400,
      );
    }
  }

  try {
    await rm(target.absolutePath, { recursive: targetStats.isDirectory() && recursive, force: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw staleListError();
    if (code === "ENOTEMPTY" || code === "EISDIR") {
      throw workspaceFileError(
        "WORKSPACE_DIRECTORY_NOT_EMPTY",
        "目录不为空，确认后可递归删除。",
        400,
      );
    }
    throw error;
  }

  return { ok: true };
}

export async function writeFileContent(
  workspace: WorkspaceContext,
  relativePath: string,
  content: unknown,
  expectedEtag: unknown,
): Promise<FileEntry> {
  if (typeof content !== "string") {
    throw workspaceFileError("WORKSPACE_CONTENT_INVALID", "File content must be text", 400);
  }
  if (Buffer.byteLength(content, "utf8") > FILE_PREVIEW_MAX_BYTES) {
    throw workspaceFileError("WORKSPACE_FILE_TOO_LARGE", "文件过大，无法保存。", 400);
  }

  const target = await assertWritableChildPath(workspace, relativePath);
  const targetStats = await stat(target.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw staleListError();
    throw error;
  });
  if (!targetStats.isFile()) {
    throw workspaceFileError("WORKSPACE_PATH_NOT_FILE", "Workspace path is not a file", 400);
  }
  if (targetStats.size > FILE_PREVIEW_MAX_BYTES) {
    throw workspaceFileError("WORKSPACE_FILE_TOO_LARGE", "文件过大，无法保存。", 400);
  }
  if (typeof expectedEtag !== "string" || !expectedEtag) {
    throw staleListError("文件版本已过期，可刷新后继续。");
  }
  if (etagForStats(targetStats) !== expectedEtag) {
    throw staleListError("文件已在外部修改，列表已过期，可刷新后继续。");
  }

  const existingBuffer = await readFile(target.absolutePath);
  if (isBinaryBuffer(existingBuffer)) {
    throw workspaceFileError("WORKSPACE_CONTENT_INVALID", "二进制文件不能作为文本保存。", 400);
  }

  await writeFile(target.absolutePath, content, "utf8");
  return entryForResolvedPath(target.relativePath, target.absolutePath);
}
