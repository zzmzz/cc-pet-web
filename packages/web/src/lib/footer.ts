export interface SplitFooter {
  body: string;
  /** 用量尾注的纯文本（去掉首尾的 `*` 与多余空白），无则为 null。 */
  footer: string | null;
  /** 从尾注里提取的模型短名（如 `opus-4-8`），无则为 null。 */
  model: string | null;
}

/** 从完整模型标识里提取简短可读名，如 `us.anthropic.claude-opus-4-8` → `opus-4-8`。 */
function shortModelName(footer: string): string | null {
  const token = footer.split(/\s/)[0] ?? "";
  // 取 claude- 之后的部分；去掉结尾日期戳（如 -20251001）
  const m = token.match(/claude-(.+)$/);
  if (!m) return null;
  return m[1].replace(/-\d{6,}$/, "");
}

/**
 * 从助手正文末尾剥离 cc-connect 注入的用量统计尾注，形如：
 *   *us.anthropic.claude-opus-4-8 · out 3.0k · in 2 cw 1.9k cr 78.8k · ctx 40%
 *   .*
 * 返回剥离后的正文与尾注文本，供 UI 折叠成小角标。
 */
export function splitUsageFooter(content: string): SplitFooter {
  // 匹配结尾处、以 * 起、含模型用量标识、以 * 收尾的块（可跨行）。
  const match = content.match(/\n+\*((?:us\.)?(?:anthropic|claude)[\s\S]*?)\*\s*$/);
  if (!match) {
    return { body: content, footer: null, model: null };
  }
  const body = content.slice(0, match.index).trimEnd();
  const footer = match[1]
    .replace(/\s*\n\s*\.?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { body, footer, model: shortModelName(footer) };
}
