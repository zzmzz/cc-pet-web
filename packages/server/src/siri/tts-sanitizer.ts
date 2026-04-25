const MAX_TTS_LENGTH = 300;

export function sanitizeForTts(text: string): string {
  let result = text;

  // Remove fenced code blocks
  result = result.replace(/```[\s\S]*?```/g, "代码已省略");

  // Remove inline code backticks
  result = result.replace(/`([^`]+)`/g, "$1");

  // Remove heading markers
  result = result.replace(/^#{1,6}\s+/gm, "");

  // Remove bold/italic markers
  result = result.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");

  // Remove blockquote markers
  result = result.replace(/^>\s+/gm, "");

  // Remove unordered list markers
  result = result.replace(/^[-*+]\s+/gm, "");

  // Remove ordered list markers
  result = result.replace(/^\d+\.\s+/gm, "");

  // Replace URLs
  result = result.replace(/https?:\/\/[^\s)]+/g, "链接已省略");

  // Collapse multiple blank lines to one
  result = result.replace(/\n{3,}/g, "\n\n");

  // Trim
  result = result.trim();

  // Truncate if too long
  if (result.length > MAX_TTS_LENGTH) {
    result = result.slice(0, MAX_TTS_LENGTH) + "……详细内容可在聊天记录中查看";
  }

  return result;
}
