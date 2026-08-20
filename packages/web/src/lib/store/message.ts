import { create } from "zustand";
import type { ChatMessage } from "@cc-pet/shared";

interface MessageState {
  messagesByChat: Record<string, ChatMessage[]>;
  streamingContent: Record<string, string>;
  /** Live preview messages keyed by previewId → { chatKey, content } */
  previewMessages: Record<string, { chatKey: string; content: string }>;
  /** Tracks which chatKeys have had their history hydrated from the server. */
  loadedChatKeys: Set<string>;
  /** Per-chatKey highest server seq seen; used as the sync cursor for backfill. */
  watermarks: Record<string, number>;

  addMessage: (chatKey: string, msg: ChatMessage) => void;
  setMessages: (chatKey: string, msgs: ChatMessage[]) => void;
  appendStreamDelta: (chatKey: string, delta: string) => void;
  finalizeStream: (chatKey: string, fullText: string, msgId?: string, seq?: number) => void;
  clearMessages: (chatKey: string) => void;
  /** Advance the watermark for chatKey to seq (never moves backwards). */
  setWatermark: (chatKey: string, seq: number) => void;
  /** Return the highest seq seen for chatKey, or 0 if unknown. */
  getWatermark: (chatKey: string) => number;
  /** Merge incoming messages into the store, deduping by id and re-sorting. */
  mergeMessages: (chatKey: string, incoming: ChatMessage[]) => void;
  /** Remove chatKey from message + streaming maps (e.g. session delete). */
  purgeChat: (chatKey: string) => void;
  /** Mark a chatKey as loaded so future ensureChatLoaded calls become no-ops. */
  markChatLoaded: (chatKey: string) => void;
  /** True if the chatKey has been hydrated from the server in this session. */
  isChatLoaded: (chatKey: string) => boolean;
  /** Start a live preview message (preview_start). */
  startPreview: (chatKey: string, previewId: string, content: string) => void;
  /** Update a live preview message (update_message). */
  updatePreview: (previewId: string, content: string) => void;
  /** Delete a live preview message (delete_message). Finalizes into message list or removes. */
  deletePreview: (previewId: string) => void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByChat: {},
  streamingContent: {},
  previewMessages: {},
  loadedChatKeys: new Set<string>(),
  watermarks: {},

  addMessage: (chatKey, msg) =>
    set((s) => ({
      messagesByChat: {
        ...s.messagesByChat,
        [chatKey]: [...(s.messagesByChat[chatKey] ?? []), msg],
      },
      ...(typeof msg.seq === "number"
        ? { watermarks: { ...s.watermarks, [chatKey]: Math.max(s.watermarks[chatKey] ?? 0, msg.seq) } }
        : {}),
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
  finalizeStream: (chatKey, fullText, msgId?, seq?) =>
    set((s) => {
      const { [chatKey]: _, ...rest } = s.streamingContent;
      return {
        streamingContent: rest,
        messagesByChat: {
          ...s.messagesByChat,
          [chatKey]: [
            ...(s.messagesByChat[chatKey] ?? []),
            { id: msgId ?? `msg-${crypto.randomUUID()}`, seq, role: "assistant" as const, content: fullText, timestamp: Date.now() },
          ],
        },
        ...(typeof seq === "number"
          ? { watermarks: { ...s.watermarks, [chatKey]: Math.max(s.watermarks[chatKey] ?? 0, seq) } }
          : {}),
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
      const loadedChatKeys = new Set(s.loadedChatKeys);
      loadedChatKeys.delete(chatKey);
      return { messagesByChat, streamingContent, previewMessages, loadedChatKeys };
    }),
  markChatLoaded: (chatKey) =>
    set((s) => {
      if (s.loadedChatKeys.has(chatKey)) return s;
      const loadedChatKeys = new Set(s.loadedChatKeys);
      loadedChatKeys.add(chatKey);
      return { loadedChatKeys };
    }),
  isChatLoaded: (chatKey) => get().loadedChatKeys.has(chatKey),
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

  setWatermark: (chatKey, seq) =>
    set((s) => ({
      watermarks: { ...s.watermarks, [chatKey]: Math.max(s.watermarks[chatKey] ?? 0, seq) },
    })),

  getWatermark: (chatKey) => get().watermarks[chatKey] ?? 0,

  mergeMessages: (chatKey, incoming) => {
    const existing = get().messagesByChat[chatKey] ?? [];
    const byId = new Map(existing.map((m) => [m.id, m]));
    for (const m of incoming) byId.set(m.id, m);
    const merged = [...byId.values()].sort(
      (a, b) => a.timestamp - b.timestamp || (a.seq ?? 0) - (b.seq ?? 0)
    );
    const maxSeq = merged.reduce((acc, m) => Math.max(acc, m.seq ?? 0), 0);
    set((s) => ({
      messagesByChat: { ...s.messagesByChat, [chatKey]: merged },
      watermarks: { ...s.watermarks, [chatKey]: Math.max(s.watermarks[chatKey] ?? 0, maxSeq) },
    }));
  },
}));
