import type { ChatMessage } from "@cc-pet/shared";
import { isToolCallContent, isToolResultContent } from "./tool-call.js";

/** 一步操作：一次工具调用（或思考）配上它的结果（若有）。 */
export interface ToolStep {
  call: ChatMessage;
  result: ChatMessage | null;
}

export type RenderItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tool-group"; steps: ToolStep[]; done: boolean };

/** Bridge 常在连续 tool 消息之间插入仅换行/空白的 assistant 占位，不应打断工具组合并或渲染空气泡。 */
function isAssistantWhitespaceOnly(msg: ChatMessage): boolean {
  return msg.role === "assistant" && (msg.content ?? "").trim().length === 0;
}

/** 工具调用、思考、工具结果都属于活动块的内容，均不应打断分组。 */
function isToolRelated(msg: ChatMessage): boolean {
  return msg.role === "assistant" && (isToolCallContent(msg.content) || isToolResultContent(msg.content));
}

/** 把缓冲的工具消息配对成步骤：🧾 结果归到最近一个尚无结果的调用上。 */
function pairSteps(buf: ChatMessage[]): ToolStep[] {
  const steps: ToolStep[] = [];
  for (const msg of buf) {
    if (isToolResultContent(msg.content)) {
      const last = steps[steps.length - 1];
      if (last && last.result === null) {
        last.result = msg;
      } else {
        // 没有对应调用的孤立结果，单独成步（result 自身作为 call 兜底展示）
        steps.push({ call: msg, result: null });
      }
    } else {
      steps.push({ call: msg, result: null });
    }
  }
  return steps;
}

/**
 * 尾部那组工具调用是否已经收尾：流式正文一旦吐出非工具内容，就说明工具阶段结束了。
 *
 * 这个判断单独抽出来，是为了让 groupMessages 只收一个布尔值而不是整段流式正文。
 * 打字机每吐一个字正文就变一次，若让 groupMessages 直接依赖正文，调用方的 useMemo
 * 每帧都会失效、重新分组整个会话并返回全新的 RenderItem 数组，下游 memo 也就全部落空。
 * 换成布尔量之后，一次回复期间它几乎恒定，分组结果在整个流式过程中保持同一引用。
 */
export function streamingClosesToolGroup(streamingContent?: string): boolean {
  return (
    streamingContent != null &&
    streamingContent.length > 0 &&
    !isToolCallContent(streamingContent) &&
    !isToolResultContent(streamingContent)
  );
}

export function groupMessages(messages: ChatMessage[], trailingToolGroupDone = false): RenderItem[] {
  const items: RenderItem[] = [];
  let toolBuf: ChatMessage[] = [];

  const flushToolGroup = (done: boolean): void => {
    if (toolBuf.length === 0) return;
    items.push({ kind: "tool-group", steps: pairSteps(toolBuf), done });
    toolBuf = [];
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isAssistantWhitespaceOnly(msg)) {
      continue;
    }
    if (isToolRelated(msg)) {
      toolBuf.push(msg);
    } else {
      const done = msg.role === "assistant" || toolBuf.length > 0;
      flushToolGroup(done);
      items.push({ kind: "message", message: msg });
    }
  }

  if (toolBuf.length > 0) {
    flushToolGroup(trailingToolGroupDone);
  }

  return items;
}
