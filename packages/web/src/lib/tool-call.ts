export function isToolCallContent(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("🔧") || trimmed.startsWith("💭");
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
