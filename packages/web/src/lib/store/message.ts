import { create } from "zustand";
import type { ChatMessage } from "@cc-pet/shared";

interface MessageState {
  messagesByChat: Record<string, ChatMessage[]>;
  streamingContent: Record<string, string>;

  addMessage: (chatKey: string, msg: ChatMessage) => void;
  setMessages: (chatKey: string, msgs: ChatMessage[]) => void;
  appendStreamDelta: (chatKey: string, delta: string) => void;
  finalizeStream: (chatKey: string, fullText: string) => void;
  clearMessages: (chatKey: string) => void;
  /** Remove chatKey from message + streaming maps (e.g. session delete). */
  purgeChat: (chatKey: string) => void;
}

export const useMessageStore = create<MessageState>((set) => ({
  messagesByChat: {},
  streamingContent: {},

  addMessage: (chatKey, msg) =>
    set((s) => ({
      messagesByChat: {
        ...s.messagesByChat,
        [chatKey]: [...(s.messagesByChat[chatKey] ?? []), msg],
      },
    })),
  setMessages: (chatKey, msgs) =>
    set((s) => ({ messagesByChat: { ...s.messagesByChat, [chatKey]: msgs } })),
  appendStreamDelta: (chatKey, delta) =>
    set((s) => ({
      streamingContent: {
        ...s.streamingContent,
        [chatKey]: (s.streamingContent[chatKey] ?? "") + delta,
      },
    })),
  finalizeStream: (chatKey, fullText) =>
    set((s) => {
      const { [chatKey]: _, ...rest } = s.streamingContent;
      return {
        streamingContent: rest,
        messagesByChat: {
          ...s.messagesByChat,
          [chatKey]: [
            ...(s.messagesByChat[chatKey] ?? []),
            { id: `msg-${Date.now()}`, role: "assistant" as const, content: fullText, timestamp: Date.now() },
          ],
        },
      };
    }),
  clearMessages: (chatKey) =>
    set((s) => ({ messagesByChat: { ...s.messagesByChat, [chatKey]: [] } })),
  purgeChat: (chatKey) =>
    set((s) => {
      const { [chatKey]: _m, ...messagesByChat } = s.messagesByChat;
      const { [chatKey]: _st, ...streamingContent } = s.streamingContent;
      return { messagesByChat, streamingContent };
    }),
}));
