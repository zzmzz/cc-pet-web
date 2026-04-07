import { create } from "zustand";
import type { ChatMessage } from "@cc-pet/shared";

interface MessageState {
  messagesByChat: Record<string, ChatMessage[]>;
  streamingContent: Record<string, string>;
  /** Live preview messages keyed by previewId → { chatKey, content } */
  previewMessages: Record<string, { chatKey: string; content: string }>;

  addMessage: (chatKey: string, msg: ChatMessage) => void;
  setMessages: (chatKey: string, msgs: ChatMessage[]) => void;
  appendStreamDelta: (chatKey: string, delta: string) => void;
  finalizeStream: (chatKey: string, fullText: string) => void;
  clearMessages: (chatKey: string) => void;
  /** Remove chatKey from message + streaming maps (e.g. session delete). */
  purgeChat: (chatKey: string) => void;
  /** Start a live preview message (preview_start). */
  startPreview: (chatKey: string, previewId: string, content: string) => void;
  /** Update a live preview message (update_message). */
  updatePreview: (previewId: string, content: string) => void;
  /** Delete a live preview message (delete_message). Finalizes into message list or removes. */
  deletePreview: (previewId: string) => void;
}

export const useMessageStore = create<MessageState>((set) => ({
  messagesByChat: {},
  streamingContent: {},
  previewMessages: {},

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
      // Also purge any preview messages belonging to this chat
      const previewMessages = { ...s.previewMessages };
      for (const [pid, pv] of Object.entries(previewMessages)) {
        if (pv.chatKey === chatKey) delete previewMessages[pid];
      }
      return { messagesByChat, streamingContent, previewMessages };
    }),
  startPreview: (chatKey, previewId, content) =>
    set((s) => ({
      previewMessages: { ...s.previewMessages, [previewId]: { chatKey, content } },
    })),
  updatePreview: (previewId, content) =>
    set((s) => {
      const existing = s.previewMessages[previewId];
      if (!existing) return s;
      return {
        previewMessages: { ...s.previewMessages, [previewId]: { ...existing, content } },
      };
    }),
  deletePreview: (previewId) =>
    set((s) => {
      const existing = s.previewMessages[previewId];
      if (!existing) return s;
      const { [previewId]: _, ...previewMessages } = s.previewMessages;
      // Finalize the preview content into the message list
      if (existing.content.trim()) {
        return {
          previewMessages,
          messagesByChat: {
            ...s.messagesByChat,
            [existing.chatKey]: [
              ...(s.messagesByChat[existing.chatKey] ?? []),
              {
                id: `preview-${previewId}-${Date.now()}`,
                role: "assistant" as const,
                content: existing.content,
                timestamp: Date.now(),
              },
            ],
          },
        };
      }
      return { previewMessages };
    }),
}));
