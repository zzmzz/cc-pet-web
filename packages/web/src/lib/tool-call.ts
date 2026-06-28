export function isToolCallContent(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("🔧") || trimmed.startsWith("💭");
}

/** Bridge 推送的工具结果消息以 🧾 开头，紧跟在对应的 🔧 调用之后。 */
export function isToolResultContent(content: string): boolean {
  return content.trimStart().startsWith("🧾");
}

export interface ToolResult {
  status: "ok" | "error";
  exitCode: number | null;
  body: string;
}

/**
 * 解析 🧾 结果消息，提取状态、退出码与正文。
 * 形如：`🧾[ Tool]\n🟢 状态: ok\n🔢 退出码: 0\n\`\`\`text\n...\n\`\`\``
 */
export function parseToolResult(content: string): ToolResult {
  const trimmed = content.trimStart();
  const fenceIdx = trimmed.indexOf("```");
  const head = fenceIdx >= 0 ? trimmed.slice(0, fenceIdx) : trimmed;

  const isError = head.includes("🔴") || /状态:\s*(failed|error|错误)/i.test(head);
  const exitMatch = head.match(/退出码:\s*(-?\d+)/);
  const exitCode = exitMatch ? Number(exitMatch[1]) : null;
  const status: ToolResult["status"] =
    isError || (exitCode != null && exitCode !== 0) ? "error" : "ok";

  let body = "";
  if (fenceIdx >= 0) {
    const afterFence = trimmed.slice(fenceIdx);
    const lines = afterFence.split("\n");
    // lines[0] 是 ```lang，找到收尾的 ```
    const endFenceIdx = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "```");
    body = (endFenceIdx > 0 ? lines.slice(1, endFenceIdx) : lines.slice(1)).join("\n").trim();
  }

  return { status, exitCode, body };
}

export function getToolCallLabel(content: string): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("💭")) return "💭 思考";
  const match = trimmed.match(/🔧\s*\*\*工具\s*#\d+:\s*(.+?)\*\*/);
  if (match) return `🔧 ${match[1]}`;
  return "🔧 工具调用";
}

const DETAIL_MAX_LEN = 40;

export function getToolCallDetail(content: string): string {
  if (content.trimStart().startsWith("💭")) return "";
  const full = getToolCallFullDetail(content);
  if (full.length <= DETAIL_MAX_LEN) return full;
  return full.slice(0, DETAIL_MAX_LEN) + "…";
}

export function getToolCallFullDetail(content: string): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("💭")) {
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline < 0) return "";
    return trimmed.slice(firstNewline + 1).trim();
  }

  const sepIdx = trimmed.indexOf("\n---\n");
  if (sepIdx < 0) return "";

  const afterSep = trimmed.slice(sepIdx + 5).trimStart();
  const lines = afterSep.split("\n");
  let result = afterSep;

  if (lines[0]?.startsWith("```")) {
    const endFenceIdx = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "```");
    if (endFenceIdx > 0) {
      result = lines.slice(1, endFenceIdx).join("\n");
    } else {
      result = lines.slice(1).join("\n");
    }
  } else {
    result = lines[0]?.replace(/^`+|`+$/g, "").trim() ?? "";
  }

  return result.trim();
}
