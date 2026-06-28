export interface SplitFooter {
  body: string;
  /** 用量尾注的纯文本（去掉首尾的 `*` 与多余空白），无则为 null。 */
  footer: string | null;
}

/**
 * 从助手正文末尾剥离 cc-connect 注入的用量统计尾注，形如：
 *   *us.anthropic.claude-opus-4-8 · out 3.0k · in 2 cw 1.9k cr 78.8k · ctx 40%
 *   .*
 * 返回剥离后的正文与尾注文本，供 UI 折叠成小角标。
 */
export function splitUsageFooter(content: string): SplitFooter {
  // 匹配结尾处、以 * 起、含模型用量标识、以 * 收尾的块（可跨行）。
  const match = content.match(/\n+\*((?:us\.)?anthropic[\s\S]*?)\*\s*$/);
  if (!match) {
    return { body: content, footer: null };
  }
  const body = content.slice(0, match.index).trimEnd();
  const footer = match[1]
    .replace(/\s*\n\s*\.?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { body, footer };
}
