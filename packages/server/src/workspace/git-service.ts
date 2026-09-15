import { spawn } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceContext } from "./resolver.js";
import type { ResolvedWorkspacePath } from "./resolver.js";
import {
  resolveWorkspacePath,
  WORKSPACE_PARENT_PATH_MISSING_MESSAGE,
  WorkspaceResolutionError,
} from "./resolver.js";

export const GIT_COMMAND_TIMEOUT_MS = 5_000;
export const GIT_OUTPUT_MAX_BYTES = 128 * 1024;
export const GIT_SCOPE_SCAN_DEFAULT_DEPTH = 2;
export const GIT_SCOPE_SCAN_DIR_LIMIT = 200;
const GIT_SCOPE_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  ".pnpm-store",
]);

export type GitRepoMode = "root" | "nested" | "subpath";

export interface GitChange {
  path: string;
  status: string;
  previousPath?: string;
}

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
  reason?: "GIT_UNAVAILABLE" | "DIFF_TOO_LARGE" | "BINARY_DIFF" | "DIFF_UNAVAILABLE";
  message?: string;
  scope?: string;
  repoMode?: GitRepoMode;
  repoRoot?: string;
}

export interface GitScopeEntry {
  path: string;
  repoMode: "root" | "nested";
  label?: string;
}

export interface GitScopesResponse {
  scopes: GitScopeEntry[];
  truncated: boolean;
}

export interface GitRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  errorCode?: string;
}

interface ScopeContext {
  scope: string;
  repoMode: GitRepoMode;
  repoRoot: string;
  cwd: string;
  pathspec?: string;
}

function toApiPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function appendWithLimit(current: string, chunk: Buffer, maxOutputBytes: number): { value: string; truncated: boolean } {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= maxOutputBytes) {
    return { value: next, truncated: false };
  }
  return { value: next.slice(0, maxOutputBytes), truncated: true };
}

export function runGit(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; maxOutputBytes?: number; allowExitCodes?: number[] } = {},
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? GIT_OUTPUT_MAX_BYTES;
  const allowExitCodes = new Set(options.allowExitCodes ?? [0]);

  return new Promise((resolve) => {
    // 容器里 node 常以 root 运行而挂载目录归宿主用户所有，git 2.35.2+ 会以「dubious ownership」拒绝。
    // 这里只对本次调用通过 -c 注入 safe.directory=*，不写入任何持久化配置。
    const finalArgs = ["-c", "safe.directory=*", ...args];
    const child = spawn("git", finalArgs, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let outputTruncated = false;

    const finish = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendWithLimit(stdout, chunk, maxOutputBytes);
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
      if (outputTruncated) child.kill("SIGTERM");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const appended = appendWithLimit(stderr, chunk, maxOutputBytes);
      stderr = appended.value;
      outputTruncated ||= appended.truncated;
      if (outputTruncated) child.kill("SIGTERM");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        stdout,
        stderr: error.message,
        timedOut: false,
        outputTruncated,
        errorCode: error.code,
      });
    });

    child.on("close", (exitCode) => {
      finish({
        exitCode,
        stdout,
        stderr,
        timedOut,
        outputTruncated,
        errorCode: allowExitCodes.has(exitCode ?? -1) ? undefined : undefined,
      });
    });
  });
}

function gitUnavailableMessage(result: GitRunResult): string {
  if (result.timedOut) return "Git command timed out.";
  // spawn 找不到二进制时 Node 把 "spawn git ENOENT" 灌进 stderr，所以 ENOENT 必须先于 stderr 判断，
  // 否则用户看到的是迷惑的 Node 错误而不是「未安装 git」。
  if (result.errorCode === "ENOENT") return "Git executable is not available.";
  if (result.stderr) return result.stderr;
  return "Git information is not available for this workspace.";
}

async function safeRealpath(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

function isGitUnavailable(result: GitRunResult): boolean {
  return result.errorCode === "ENOENT" || result.exitCode !== 0 || result.timedOut;
}

function joinScopePath(scope: string, repoRelativePath: string): string {
  if (!repoRelativePath) return scope;
  if (!scope) return repoRelativePath;
  return `${scope}/${repoRelativePath}`;
}

function stripScopePrefix(scope: string, fullPath: string): string {
  if (!scope) return fullPath;
  if (fullPath === scope) return "";
  const prefix = `${scope}/`;
  if (fullPath.startsWith(prefix)) return fullPath.slice(prefix.length);
  return fullPath;
}

function normalizeScopeQuery(scope: string | undefined): string {
  if (!scope) return "";
  const trimmed = scope.trim();
  if (!trimmed || trimmed === "." || trimmed === "/") return "";
  return trimmed;
}

async function resolveScopeContext(
  workspace: WorkspaceContext,
  scope: string | undefined,
): Promise<{ ok: true; context: ScopeContext } | { ok: false; reason: "GIT_UNAVAILABLE"; message: string }> {
  const normalizedScope = normalizeScopeQuery(scope);

  if (!normalizedScope) {
    const root = await runGit(workspace.rootPath, ["rev-parse", "--is-inside-work-tree"]);
    if (isGitUnavailable(root) || root.stdout.trim() !== "true") {
      return { ok: false, reason: "GIT_UNAVAILABLE", message: gitUnavailableMessage(root) };
    }
    return {
      ok: true,
      context: {
        scope: "",
        repoMode: "root",
        repoRoot: "",
        cwd: workspace.rootPath,
        pathspec: undefined,
      },
    };
  }

  let resolved: ResolvedWorkspacePath;
  try {
    resolved = await resolveWorkspacePath(workspace, normalizedScope);
  } catch (error) {
    // "Parent path does not exist" is semantically a not-found scope for git purposes,
    // so we translate it to 404 to match the rest of the scope contract.
    if (
      error instanceof WorkspaceResolutionError &&
      error.code === "WORKSPACE_PATH_INVALID" &&
      error.message === WORKSPACE_PARENT_PATH_MISSING_MESSAGE
    ) {
      throw new WorkspaceResolutionError(
        "WORKSPACE_UNAVAILABLE",
        "Git scope path does not exist",
        404,
      );
    }
    throw error;
  }
  const subpathApi = toApiPath(resolved.relativePath);

  const targetStat = await stat(resolved.absolutePath).catch(() => null);
  if (!targetStat) {
    throw new WorkspaceResolutionError(
      "WORKSPACE_UNAVAILABLE",
      "Git scope path does not exist",
      404,
    );
  }
  if (!targetStat.isDirectory()) {
    throw new WorkspaceResolutionError(
      "WORKSPACE_PATH_INVALID",
      "Git scope must be a directory",
      400,
    );
  }

  // Resolve symlinks on both sides before comparing — git rev-parse --show-toplevel
  // always returns the realpath, so any symlink in the candidate path would otherwise
  // make a true "nested" repo silently fall through to the subpath fallback.
  const resolvedReal = await safeRealpath(resolved.absolutePath);
  const rootReal = await safeRealpath(workspace.rootPath);
  const topResult = await runGit(resolvedReal, ["rev-parse", "--show-toplevel"]);
  if (isGitUnavailable(topResult)) {
    return { ok: false, reason: "GIT_UNAVAILABLE", message: gitUnavailableMessage(topResult) };
  }
  const toplevel = topResult.stdout.trim();
  if (!toplevel) {
    return { ok: false, reason: "GIT_UNAVAILABLE", message: "Git information is not available for this workspace." };
  }
  const toplevelReal = await safeRealpath(toplevel);

  if (toplevelReal === resolvedReal) {
    return {
      ok: true,
      context: {
        scope: subpathApi,
        repoMode: "nested",
        repoRoot: subpathApi,
        cwd: resolvedReal,
        pathspec: undefined,
      },
    };
  }

  if (toplevelReal === rootReal) {
    return {
      ok: true,
      context: {
        scope: subpathApi,
        repoMode: "subpath",
        repoRoot: "",
        cwd: rootReal,
        pathspec: subpathApi,
      },
    };
  }

  // Toplevel is an ancestor of workspace.rootPath (workspace lives inside a larger repo).
  // Treat workspace root as the effective repo root and apply pathspec filter from workspace root.
  return {
    ok: true,
    context: {
      scope: subpathApi,
      repoMode: "subpath",
      repoRoot: "",
      cwd: rootReal,
      pathspec: subpathApi,
    },
  };
}

function parseStatusLine(line: string, repoRoot: string): GitChange | null {
  if (line.length < 4) return null;
  const xy = line.slice(0, 2);
  const rawPath = line.slice(3);
  if (!rawPath) return null;

  if (xy === "??") {
    return { path: joinScopePath(repoRoot, rawPath), status: "??" };
  }

  const status = xy.includes("R") ? "R" : xy.includes("C") ? "C" : xy.trim()[0] ?? "M";
  if (status === "R" || status === "C") {
    const [previousPath, nextPath] = rawPath.split(" -> ");
    return {
      path: joinScopePath(repoRoot, nextPath ?? rawPath),
      previousPath: previousPath ? joinScopePath(repoRoot, previousPath) : undefined,
      status,
    };
  }
  return { path: joinScopePath(repoRoot, rawPath), status };
}

function isBinaryDiff(diff: string): boolean {
  return /^Binary files .+ differ$/m.test(diff) || diff.includes("GIT binary patch");
}

async function isUntracked(cwd: string, repoRelativePath: string): Promise<boolean> {
  const result = await runGit(cwd, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    repoRelativePath,
  ]);
  return result.stdout
    .split(/\r?\n/)
    .some((line) => line.startsWith("?? "));
}

export async function getGitStatus(
  workspace: WorkspaceContext,
  options: { scope?: string } = {},
): Promise<GitStatusResponse> {
  const scopeResult = await resolveScopeContext(workspace, options.scope);
  if (!scopeResult.ok) {
    return {
      gitAvailable: false,
      changes: [],
      message: scopeResult.message,
      scope: normalizeScopeQuery(options.scope),
      repoMode: "root",
      repoRoot: "",
    };
  }
  const ctx = scopeResult.context;

  const statusArgs = ["status", "--porcelain=v1", "--untracked-files=all"];
  if (ctx.pathspec) statusArgs.push("--", ctx.pathspec);
  const result = await runGit(ctx.cwd, statusArgs);
  if (result.outputTruncated) {
    return {
      gitAvailable: true,
      changes: [],
      message: "Git status output is too large to display.",
      scope: ctx.scope,
      repoMode: ctx.repoMode,
      repoRoot: ctx.repoRoot,
    };
  }
  if (isGitUnavailable(result)) {
    return {
      gitAvailable: false,
      changes: [],
      message: gitUnavailableMessage(result),
      scope: ctx.scope,
      repoMode: ctx.repoMode,
      repoRoot: ctx.repoRoot,
    };
  }

  const changes = result.stdout
    .split(/\r?\n/)
    .map((line) => parseStatusLine(line, ctx.repoRoot))
    .filter((change): change is GitChange => change !== null);

  return {
    gitAvailable: true,
    changes,
    scope: ctx.scope,
    repoMode: ctx.repoMode,
    repoRoot: ctx.repoRoot,
  };
}

export async function getGitDiff(
  workspace: WorkspaceContext,
  relativePath: string,
  options: { scope?: string } = {},
): Promise<GitDiffResponse> {
  const resolved = await resolveWorkspacePath(workspace, relativePath);
  const normalizedPath = toApiPath(resolved.relativePath);

  const scopeResult = await resolveScopeContext(workspace, options.scope);
  if (!scopeResult.ok) {
    return {
      path: normalizedPath,
      previewable: false,
      reason: "GIT_UNAVAILABLE",
      message: scopeResult.message,
      scope: normalizeScopeQuery(options.scope),
    };
  }
  const ctx = scopeResult.context;

  // For nested repos: ensure the requested path lives under the repo root, then translate to
  // repo-relative path before invoking git.
  let repoRelativePath = normalizedPath;
  if (ctx.repoMode === "nested") {
    if (normalizedPath !== ctx.repoRoot && !normalizedPath.startsWith(`${ctx.repoRoot}/`)) {
      return {
        path: normalizedPath,
        previewable: false,
        reason: "DIFF_UNAVAILABLE",
        message: "Diff path is outside the selected git scope.",
        scope: ctx.scope,
        repoMode: ctx.repoMode,
        repoRoot: ctx.repoRoot,
      };
    }
    repoRelativePath = stripScopePrefix(ctx.repoRoot, normalizedPath);
  } else if (ctx.repoMode === "subpath" && ctx.pathspec) {
    if (normalizedPath !== ctx.pathspec && !normalizedPath.startsWith(`${ctx.pathspec}/`)) {
      return {
        path: normalizedPath,
        previewable: false,
        reason: "DIFF_UNAVAILABLE",
        message: "Diff path is outside the selected git scope.",
        scope: ctx.scope,
        repoMode: ctx.repoMode,
        repoRoot: ctx.repoRoot,
      };
    }
  }

  const untracked = await isUntracked(ctx.cwd, repoRelativePath);
  const existingFileStats = await stat(resolved.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  const args = untracked && existingFileStats?.isFile()
    ? ["diff", "--no-ext-diff", "--no-color", "--no-index", "--", "/dev/null", repoRelativePath]
    : ["diff", "--no-ext-diff", "--no-color", "--find-renames", "HEAD", "--", repoRelativePath];
  const result = await runGit(ctx.cwd, args, { allowExitCodes: untracked ? [0, 1] : [0] });

  const base = {
    path: normalizedPath,
    scope: ctx.scope,
    repoMode: ctx.repoMode,
    repoRoot: ctx.repoRoot,
  };

  if (result.outputTruncated) {
    return { ...base, previewable: false, reason: "DIFF_TOO_LARGE", message: "Diff is too large to preview." };
  }
  if (result.timedOut) {
    return { ...base, previewable: false, reason: "DIFF_UNAVAILABLE", message: "Git diff timed out." };
  }
  if (result.errorCode === "ENOENT") {
    return { ...base, previewable: false, reason: "GIT_UNAVAILABLE", message: gitUnavailableMessage(result) };
  }
  if (!untracked && result.exitCode !== 0) {
    return {
      ...base,
      previewable: false,
      reason: "DIFF_UNAVAILABLE",
      message: result.stderr || "Git diff is not available for this file.",
    };
  }
  if (isBinaryDiff(result.stdout)) {
    return { ...base, previewable: false, reason: "BINARY_DIFF", message: "Binary diff cannot be previewed." };
  }

  return { ...base, previewable: true, diff: result.stdout };
}

async function isGitDirEntry(absolutePath: string): Promise<boolean> {
  // A nested repo is identified by either a `.git` directory (regular repo) or a `.git` file
  // (worktree / submodule).
  const stats = await stat(absolutePath).catch(() => null);
  return Boolean(stats && (stats.isDirectory() || stats.isFile()));
}

export async function listGitScopes(
  workspace: WorkspaceContext,
  options: { maxDepth?: number; maxDirs?: number } = {},
): Promise<GitScopesResponse> {
  const maxDepth = Math.max(1, options.maxDepth ?? GIT_SCOPE_SCAN_DEFAULT_DEPTH);
  const maxDirs = Math.max(1, options.maxDirs ?? GIT_SCOPE_SCAN_DIR_LIMIT);

  const scopes: GitScopeEntry[] = [];
  let truncated = false;

  const rootCheck = await runGit(workspace.rootPath, ["rev-parse", "--is-inside-work-tree"]);
  const rootIsRepo = !isGitUnavailable(rootCheck) && rootCheck.stdout.trim() === "true";
  if (rootIsRepo) {
    scopes.push({ path: "", repoMode: "root", label: "（工作区根）" });
  }

  let dirCount = 0;
  // BFS to deterministic order
  const queue: Array<{ absPath: string; relPath: string; depth: number }> = [
    { absPath: workspace.rootPath, relPath: "", depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (dirCount >= maxDirs) {
      truncated = true;
      break;
    }
    dirCount += 1;

    let entries: { name: string; isDirectory: boolean }[];
    try {
      const dirEntries = await readdir(current.absPath, { withFileTypes: true });
      entries = dirEntries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => ({ name: entry.name, isDirectory: true }));
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (GIT_SCOPE_IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) {
        // Skip hidden dirs other than the ones we already ignore; avoids surprises like .vscode being scanned.
        continue;
      }
      const absChild = path.join(current.absPath, entry.name);
      const relChild = current.relPath ? `${current.relPath}/${entry.name}` : entry.name;

      const gitMarker = path.join(absChild, ".git");
      const hasGit = await isGitDirEntry(gitMarker);
      if (hasGit && relChild !== "") {
        scopes.push({ path: relChild, repoMode: "nested", label: relChild });
        // Don't descend into a nested repo to avoid double counting deeper repos
        continue;
      }

      if (current.depth + 1 < maxDepth) {
        queue.push({ absPath: absChild, relPath: relChild, depth: current.depth + 1 });
      }
    }
  }

  return { scopes, truncated };
}
