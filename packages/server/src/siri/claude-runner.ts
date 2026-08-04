import { spawn } from "node:child_process";

/** 语音回答不该长，20s 内答不完的活会转交常驻会话，所以输出上限给得很小 */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface ClaudeRunResult {
  /** claude 的 stdout，即要念给用户的正文 */
  text: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  /** spawn 层面的错误码，找不到二进制时是 ENOENT */
  errorCode?: string;
}

export interface ClaudeRunOptions {
  bin: string;
  cwd: string;
  model: string;
  timeoutMs: number;
  maxOutputBytes?: number;
}

function appendWithLimit(
  current: string,
  chunk: Buffer,
  limit: number,
): { value: string; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: true };
  const next = current + chunk.toString("utf8");
  if (next.length <= limit) return { value: next, truncated: false };
  return { value: next.slice(0, limit), truncated: true };
}

/**
 * 跑一次 `claude -p`，拿它的最终文本。
 *
 * 走 argv 传 prompt 而不是拼 shell（`shell: false`），所以语音听写里的引号、
 * 分号、反引号都不会被解释成 shell 语法。
 */
export function runClaude(prompt: string, options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    const child = spawn(
      options.bin,
      ["-p", prompt, "--model", options.model],
      { cwd: options.cwd, shell: false, windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let truncated = false;

    const finish = (result: ClaudeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // claude 收到 SIGTERM 后偶尔不立即退出（正在等模型响应），给它 2 秒再强杀，
      // 否则子进程会挂在那里占着额度继续跑。
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000);
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendWithLimit(stdout, chunk, maxOutputBytes);
      stdout = appended.value;
      truncated ||= appended.truncated;
      if (truncated) child.kill("SIGTERM");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const appended = appendWithLimit(stderr, chunk, maxOutputBytes);
      stderr = appended.value;
      truncated ||= appended.truncated;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        text: stdout,
        stderr: error.message,
        exitCode: null,
        timedOut: false,
        truncated,
        errorCode: error.code,
      });
    });

    child.on("close", (exitCode) => {
      finish({ text: stdout.trim(), stderr, exitCode, timedOut, truncated });
    });
  });
}
