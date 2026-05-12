import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceContext } from "./resolver.js";
import { resolveWorkspacePath } from "./resolver.js";

export const GIT_COMMAND_TIMEOUT_MS = 5_000;
export const GIT_OUTPUT_MAX_BYTES = 128 * 1024;

export interface GitChange {
  path: string;
  status: string;
  previousPath?: string;
}

export interface GitStatusResponse {
  gitAvailable: boolean;
  changes: GitChange[];
  message?: string;
}

export interface GitDiffResponse {
  path: string;
  previewable: boolean;
  diff?: string;
  reason?: "GIT_UNAVAILABLE" | "DIFF_TOO_LARGE" | "BINARY_DIFF" | "DIFF_UNAVAILABLE";
  message?: string;
}

export interface GitRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  errorCode?: string;
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
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
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
  if (result.errorCode === "ENOENT") return "Git executable is not available.";
  if (result.timedOut) return "Git command timed out.";
  return result.stderr || "Git information is not available for this workspace.";
}

function isGitUnavailable(result: GitRunResult): boolean {
  return result.errorCode === "ENOENT" || result.exitCode !== 0 || result.timedOut;
}

async function ensureGitWorkspace(workspace: WorkspaceContext): Promise<{ available: true } | { available: false; message: string }> {
  const result = await runGit(workspace.rootPath, ["rev-parse", "--is-inside-work-tree"]);
  if (isGitUnavailable(result) || result.stdout.trim() !== "true") {
    return { available: false, message: gitUnavailableMessage(result) };
  }
  return { available: true };
}

function parseStatusLine(line: string): GitChange | null {
  if (line.length < 4) return null;
  const xy = line.slice(0, 2);
  const rawPath = line.slice(3);
  if (!rawPath) return null;

  if (xy === "??") {
    return { path: rawPath, status: "??" };
  }

  const status = xy.includes("R") ? "R" : xy.includes("C") ? "C" : xy.trim()[0] ?? "M";
  if (status === "R" || status === "C") {
    const [previousPath, nextPath] = rawPath.split(" -> ");
    return { path: nextPath ?? rawPath, previousPath, status };
  }
  return { path: rawPath, status };
}

function isBinaryDiff(diff: string): boolean {
  return /^Binary files .+ differ$/m.test(diff) || diff.includes("GIT binary patch");
}

async function isUntracked(workspace: WorkspaceContext, relativePath: string): Promise<boolean> {
  const result = await runGit(workspace.rootPath, ["status", "--porcelain=v1", "--untracked-files=all", "--", relativePath]);
  return result.stdout
    .split(/\r?\n/)
    .some((line) => line.startsWith("?? "));
}

export async function getGitStatus(workspace: WorkspaceContext): Promise<GitStatusResponse> {
  const git = await ensureGitWorkspace(workspace);
  if (!git.available) {
    return { gitAvailable: false, changes: [], message: git.message };
  }

  const result = await runGit(workspace.rootPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (result.outputTruncated) {
    return { gitAvailable: true, changes: [], message: "Git status output is too large to display." };
  }
  if (isGitUnavailable(result)) {
    return { gitAvailable: false, changes: [], message: gitUnavailableMessage(result) };
  }

  const changes = result.stdout
    .split(/\r?\n/)
    .map((line) => parseStatusLine(line))
    .filter((change): change is GitChange => change !== null);

  return { gitAvailable: true, changes };
}

export async function getGitDiff(workspace: WorkspaceContext, relativePath: string): Promise<GitDiffResponse> {
  const resolved = await resolveWorkspacePath(workspace, relativePath);
  const normalizedPath = toApiPath(resolved.relativePath);
  const git = await ensureGitWorkspace(workspace);
  if (!git.available) {
    return {
      path: normalizedPath,
      previewable: false,
      reason: "GIT_UNAVAILABLE",
      message: git.message,
    };
  }

  const untracked = await isUntracked(workspace, normalizedPath);
  const existingFileStats = await stat(resolved.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const args = untracked && existingFileStats?.isFile()
    ? ["diff", "--no-ext-diff", "--no-color", "--no-index", "--", "/dev/null", normalizedPath]
    : ["diff", "--no-ext-diff", "--no-color", "--find-renames", "HEAD", "--", normalizedPath];
  const result = await runGit(workspace.rootPath, args, { allowExitCodes: untracked ? [0, 1] : [0] });

  if (result.outputTruncated) {
    return {
      path: normalizedPath,
      previewable: false,
      reason: "DIFF_TOO_LARGE",
      message: "Diff is too large to preview.",
    };
  }
  if (result.timedOut) {
    return {
      path: normalizedPath,
      previewable: false,
      reason: "DIFF_UNAVAILABLE",
      message: "Git diff timed out.",
    };
  }
  if (result.errorCode === "ENOENT") {
    return {
      path: normalizedPath,
      previewable: false,
      reason: "GIT_UNAVAILABLE",
      message: gitUnavailableMessage(result),
    };
  }
  if (!untracked && result.exitCode !== 0) {
    return {
      path: normalizedPath,
      previewable: false,
      reason: "DIFF_UNAVAILABLE",
      message: result.stderr || "Git diff is not available for this file.",
    };
  }
  if (isBinaryDiff(result.stdout)) {
    return {
      path: normalizedPath,
      previewable: false,
      reason: "BINARY_DIFF",
      message: "Binary diff cannot be previewed.",
    };
  }

  return {
    path: normalizedPath,
    previewable: true,
    diff: result.stdout,
  };
}
