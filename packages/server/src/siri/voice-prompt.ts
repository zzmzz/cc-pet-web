const VOICE_MODE_PROMPT = `[语音模式] 用户正在通过语音与你对话，请注意：
- 回复简洁口语化，控制在3句话以内
- 不要使用Markdown格式、代码块、列表或链接
- 如果涉及代码或复杂内容，只说结论和关键信息
- 用"完成了"、"出错了"等简短状态词汇`;

export function wrapWithVoicePrompt(userContent: string): string {
  return `${VOICE_MODE_PROMPT}\n\n${userContent}`;
}
