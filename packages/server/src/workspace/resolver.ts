import type { FastifyRequest } from "fastify";
import { access, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import type { BridgeConfig } from "@cc-pet/shared";
import type { ConfigStore } from "../storage/config.js";
import { getRequestAuthIdentity } from "../middleware/auth.js";

export type WorkspaceErrorCode =
  | "WORKSPACE_UNAUTHORIZED"
  | "WORKSPACE_FORBIDDEN"
  | "WORKSPACE_CONNECTION_NOT_FOUND"
  | "WORKSPACE_NOT_CONFIGURED"
  | "WORKSPACE_UNAVAILABLE"
  | "WORKSPACE_PATH_INVALID"
  | "WORKSPACE_PATH_OUTSIDE_ROOT"
  | "WORKSPACE_PATH_NOT_WRITABLE";

export const WORKSPACE_PARENT_PATH_MISSING_MESSAGE = "Parent path does not exist";

export class WorkspaceResolutionError extends Error {
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "WorkspaceResolutionError";
  }
}

export interface WorkspaceContext {
  connectionId: string;
  rootPath: string;
  bridge: BridgeConfig;
}

export interface ResolvedWorkspacePath {
  relativePath: string;
  absolutePath: string;
}

type ConfigLoader = Pick<ConfigStore, "load">;

function workspaceError(code: WorkspaceErrorCode, message: string, statusCode: number): WorkspaceResolutionError {
  return new WorkspaceResolutionError(code, message, statusCode);
}

function isInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelativePath(relativePath?: string): string {
  const input = relativePath ?? "";
  if (input.includes("\0")) {
    throw workspaceError("WORKSPACE_PATH_INVALID", "Path contains invalid characters", 400);
  }
  if (path.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw workspaceError("WORKSPACE_PATH_INVALID", "Workspace paths must be relative", 400);
  }

  const normalized = path.normalize(input);
  if (normalized === ".") return "";
  return normalized;
}

async function realpathInside(
  rootPath: string,
  candidatePath: string,
  options: { allowOutsideSymlinkTarget?: boolean } = {},
): Promise<string | null> {
  try {
    const resolved = await realpath(candidatePath);
    if (!isInsideOrEqual(rootPath, resolved) && !options.allowOutsideSymlinkTarget) {
      throw workspaceError("WORKSPACE_PATH_OUTSIDE_ROOT", "Path escapes the configured workspace", 400);
    }
    return resolved;
  } catch (error) {
    if (error instanceof WorkspaceResolutionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function resolveConnectionWorkspace(
  req: FastifyRequest,
  connectionId: string,
  configStore: ConfigLoader,
): Promise<WorkspaceContext> {
  const auth = getRequestAuthIdentity(req);
  if (!auth) {
    throw workspaceError("WORKSPACE_UNAUTHORIZED", "Authentication is required to access a workspace", 401);
  }
  if (!auth.bridgeIds.has(connectionId)) {
    throw workspaceError("WORKSPACE_FORBIDDEN", "This token cannot access the requested connection", 403);
  }

  const config = configStore.load();
  const bridge = config.bridges.find((item) => item.id === connectionId);
  if (!bridge) {
    throw workspaceError("WORKSPACE_CONNECTION_NOT_FOUND", "Connection was not found", 404);
  }
  if (!bridge.workspacePath) {
    throw workspaceError("WORKSPACE_NOT_CONFIGURED", "Connection does not have a configured workspace", 404);
  }

  try {
    const rootPath = await realpath(path.resolve(bridge.workspacePath));
    const rootStats = await stat(rootPath);
    if (!rootStats.isDirectory()) {
      throw workspaceError("WORKSPACE_UNAVAILABLE", "Configured workspace is not a directory", 404);
    }
    return { connectionId, rootPath, bridge };
  } catch (error) {
    if (error instanceof WorkspaceResolutionError) throw error;
    throw workspaceError("WORKSPACE_UNAVAILABLE", "Configured workspace is not accessible", 404);
  }
}

export async function resolveWorkspacePath(
  workspace: WorkspaceContext,
  relativePath?: string,
): Promise<ResolvedWorkspacePath> {
  const normalized = normalizeRelativePath(relativePath);
  const absoluteCandidate = path.resolve(workspace.rootPath, normalized);
  if (!isInsideOrEqual(workspace.rootPath, absoluteCandidate)) {
    throw workspaceError("WORKSPACE_PATH_OUTSIDE_ROOT", "Path escapes the configured workspace", 400);
  }

  const realTarget = await realpathInside(workspace.rootPath, absoluteCandidate, {
    allowOutsideSymlinkTarget: true,
  });
  if (realTarget) {
    return { relativePath: normalized, absolutePath: absoluteCandidate };
  }

  const parentPath = path.dirname(absoluteCandidate);
  const realParent = await realpathInside(workspace.rootPath, parentPath, {
    allowOutsideSymlinkTarget: true,
  });
  if (!realParent) {
    throw workspaceError("WORKSPACE_PATH_INVALID", WORKSPACE_PARENT_PATH_MISSING_MESSAGE, 400);
  }
  return { relativePath: normalized, absolutePath: absoluteCandidate };
}

export async function assertWritablePath(
  workspace: WorkspaceContext,
  relativePath?: string,
): Promise<ResolvedWorkspacePath> {
  const resolved = await resolveWorkspacePath(workspace, relativePath);
  const parentPath = path.dirname(resolved.absolutePath);
  const realParent = await realpathInside(workspace.rootPath, parentPath);
  if (!realParent) {
    throw workspaceError("WORKSPACE_PATH_INVALID", WORKSPACE_PARENT_PATH_MISSING_MESSAGE, 400);
  }

  try {
    await access(realParent, fsConstants.W_OK);
    return resolved;
  } catch {
    throw workspaceError("WORKSPACE_PATH_NOT_WRITABLE", "Workspace path is not writable", 400);
  }
}

export async function assertWritableChildPath(
  workspace: WorkspaceContext,
  relativePath?: string,
): Promise<ResolvedWorkspacePath> {
  const resolved = await resolveWorkspacePath(workspace, relativePath);
  if (resolved.relativePath === "") {
    throw workspaceError("WORKSPACE_PATH_INVALID", "Workspace root cannot be modified", 400);
  }
  const parentPath = path.dirname(resolved.absolutePath);
  const realParent = await realpathInside(workspace.rootPath, parentPath);
  if (!realParent) {
    throw workspaceError("WORKSPACE_PATH_INVALID", WORKSPACE_PARENT_PATH_MISSING_MESSAGE, 400);
  }

  try {
    await access(realParent, fsConstants.W_OK);
  } catch {
    throw workspaceError("WORKSPACE_PATH_NOT_WRITABLE", "Workspace path is not writable", 400);
  }
  return resolved;
}
