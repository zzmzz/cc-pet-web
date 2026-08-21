import { spawn } from "node:child_process";
import type { ToolCall } from "./fast-path-learn.js";

/** 语音回答不该长，超时的活会转交常驻会话，所以输出上限给得很小 */
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

export interface ClaudeRunResult {
  /** 要念给用户的正文 */
  text: string;
  /** 这一轮实际调过的工具，用来事后学快通道规则 */
  toolCalls: ToolCall[];
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

/**
 * 跑一次 `claude -p`，拿最终文本 + 它调过哪些工具。
 *
 * 用 `--output-format stream-json` 而不是纯文本：一是最终文本从 `result` 事件里取更准，
 * 二是能看到 `tool_use`，这样降级跑完后可以据此学一条快通道规则（见 fast-path-learn）。
 *
 * prompt 走 argv 而不是拼 shell（`shell: false`），所以语音听写里的引号、分号、
 * 反引号都不会被当成 shell 语法。
 */
export function runClaude(prompt: string, options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    const child = spawn(
      options.bin,
      [
        "-p", prompt,
        "--model", options.model,
        // stream-json 必须配 --verbose，否则 claude 直接报错退出
        "--output-format", "stream-json",
        "--verbose",
      ],
      { cwd: options.cwd, shell: false, windowsHide: true },
    );

    let pending = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let resultText = "";
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    const finish = (r: ClaudeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // claude 收到 SIGTERM 后偶尔不立即退出（正在等模型响应），2 秒后强杀，
      // 否则子进程会挂在那里继续烧额度。
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000);
    }, options.timeoutMs);

    const handleEvent = (line: string) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return; // 非 JSON 行（罕见的告警之类）直接忽略
      }
      if (event?.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block?.type === "tool_use" && typeof block.name === "string") {
            toolCalls.push({ name: block.name, input: block.input ?? {} });
          } else if (block?.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          }
        }
      } else if (event?.type === "result" && typeof event.result === "string") {
        resultText = event.result;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) handleEvent(l);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        text: "", toolCalls, stderr: error.message, exitCode: null,
        timedOut: false, truncated, errorCode: error.code,
      });
    });

    child.on("close", (exitCode) => {
      if (pending.trim()) handleEvent(pending);
      // result 事件的文本最权威；没有就退回把 assistant 的 text 块拼起来
      const text = (resultText || textParts.join("\n")).trim();
      finish({ text, toolCalls, stderr, exitCode, timedOut, truncated });
    });
  });
}
