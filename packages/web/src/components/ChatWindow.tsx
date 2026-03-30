import { makeChatKey, WS_EVENTS } from "@cc-pet/shared";
import { useConnectionStore } from "../lib/store/connection.js";
import { useSessionStore } from "../lib/store/session.js";
import { useMessageStore } from "../lib/store/message.js";
import { getPlatform } from "../lib/platform.js";
import { MessageList } from "./MessageList.js";
import { MessageInput } from "./MessageInput.js";

export function ChatWindow() {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const activeSessionKey = useSessionStore((s) =>
    activeConnectionId ? s.activeSessionKey[activeConnectionId] ?? "default" : "default"
  );
  const chatKey = activeConnectionId ? makeChatKey(activeConnectionId, activeSessionKey) : "";
  const messages = useMessageStore((s) => s.messagesByChat[chatKey] ?? []);
  const streaming = useMessageStore((s) => s.streamingContent[chatKey]);

  const handleSend = (content: string) => {
    if (!activeConnectionId) return;
    const platform = getPlatform();

    useMessageStore.getState().addMessage(chatKey, {
      id: `msg-${Date.now()}`,
      role: "user",
      content,
      timestamp: Date.now(),
      connectionId: activeConnectionId,
      sessionKey: activeSessionKey,
    });

    platform.sendWsMessage({
      type: WS_EVENTS.SEND_MESSAGE,
      connectionId: activeConnectionId,
      sessionKey: activeSessionKey,
      content,
    });
  };

  return (
    <div className="flex flex-col h-full">
      <MessageList messages={messages} streamingContent={streaming} />
      <MessageInput onSend={handleSend} />
    </div>
  );
}
