import type { ChatMessage } from "@cc-pet/shared";
import { isToolCallContent } from "./tool-call.js";

export type RenderItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tool-group"; messages: ChatMessage[]; done: boolean };

/** Bridge 常在连续 tool 消息之间插入仅换行/空白的 assistant 占位，不应打断工具组合并或渲染空气泡。 */
function isAssistantWhitespaceOnly(msg: ChatMessage): boolean {
  return msg.role === "assistant" && (msg.content ?? "").trim().length === 0;
}

export function groupMessages(messages: ChatMessage[], streamingContent?: string): RenderItem[] {
  const items: RenderItem[] = [];
  let toolBuf: ChatMessage[] = [];

  const flushToolGroup = (done: boolean): void => {
    if (toolBuf.length === 0) return;
    items.push({ kind: "tool-group", messages: [...toolBuf], done });
    toolBuf = [];
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isAssistantWhitespaceOnly(msg)) {
      continue;
    }
    if (msg.role === "assistant" && isToolCallContent(msg.content)) {
      toolBuf.push(msg);
    } else {
      const done = msg.role === "assistant" || toolBuf.length > 0;
      flushToolGroup(done);
      items.push({ kind: "message", message: msg });
    }
  }

  if (toolBuf.length > 0) {
    const done =
      streamingContent != null &&
      streamingContent.length > 0 &&
      !isToolCallContent(streamingContent);
    flushToolGroup(done);
  }

  return items;
}
