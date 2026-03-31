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

export function getToolCallDetail(content: string): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("💭")) return "";

  const sepIdx = trimmed.indexOf("\n---\n");
  if (sepIdx < 0) return "";

  const afterSep = trimmed.slice(sepIdx + 5).trimStart();
  let firstLine = afterSep.split("\n")[0] ?? "";

  // Strip markdown code fence
  if (firstLine.startsWith("```")) {
    const secondLine = afterSep.split("\n")[1] ?? "";
    firstLine = secondLine;
  }

  // Strip backtick wrapping
  firstLine = firstLine.replace(/^`+|`+$/g, "").trim();

  if (firstLine.length <= 40) return firstLine;
  return firstLine.slice(0, 40) + "…";
}
