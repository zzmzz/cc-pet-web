import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeChatKey, WS_EVENTS } from "@cc-pet/shared";
import type { ChatMessage, SlashCommand } from "@cc-pet/shared";
import { useConnectionStore } from "../lib/store/connection.js";
import { useSessionStore } from "../lib/store/session.js";
import { useMessageStore } from "../lib/store/message.js";
import { useCommandStore } from "../lib/store/commands.js";
import { useUIStore } from "../lib/store/ui.js";
import { getPlatform, isTauri } from "../lib/platform.js";
import { closeDesktopChat } from "../lib/desktop-chat.js";
import { MessageList } from "./MessageList.js";
import { MessageInput } from "./MessageInput.js";
import { SlashCommandMenu } from "./SlashCommandMenu.js";
import { getFilteredCommands, useSlashMenu, type SlashCommandSpec } from "../lib/slash-commands.js";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_AGENT_COMMANDS: SlashCommand[] = [];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("failed to read file"));
        return;
      }
      const payload = result.split(",")[1];
      if (!payload) {
        reject(new Error("failed to parse file payload"));
        return;
      }
      resolve(payload);
    };
    reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function ChatWindow() {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const activeSessionKeyByConn = useSessionStore((s) => s.activeSessionKey);
  const messagesByChat = useMessageStore((s) => s.messagesByChat);
  const streamingByChat = useMessageStore((s) => s.streamingContent);
  const previewMessages = useMessageStore((s) => s.previewMessages);
  const agentCommandsByConnection = useCommandStore((s) => s.agentCommandsByConnection);
  const taskStateByConnection = useSessionStore((s) => s.taskStateByConnection);

  const activeSessionKey = activeConnectionId
    ? activeSessionKeyByConn[activeConnectionId] ?? "default"
    : "default";
  const chatKey = activeConnectionId ? makeChatKey(activeConnectionId, activeSessionKey) : "";
  const chatOpen = useUIStore((s) => s.chatOpen);
  const clearSessionUnread = useSessionStore((s) => s.clearSessionUnread);

  useEffect(() => {
    if (!activeConnectionId || !activeSessionKey) return;
    if (isTauri() && !chatOpen) return;
    clearSessionUnread(activeConnectionId, activeSessionKey);
  }, [chatOpen, activeConnectionId, activeSessionKey, clearSessionUnread]);
  const messages = chatKey ? (messagesByChat[chatKey] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
  const streaming = chatKey ? streamingByChat[chatKey] : undefined;
  const chatPreviews = useMemo(
    () =>
      Object.entries(previewMessages)
        .filter(([, pv]) => pv.chatKey === chatKey)
        .map(([previewId, pv]) => ({ previewId, content: pv.content })),
    [previewMessages, chatKey],
  );
  const activePhase = activeConnectionId ? taskStateByConnection[activeConnectionId]?.[activeSessionKey]?.phase : "idle";
  const showStopButton = activePhase === "working" || activePhase === "processing";

  const agentCommands = activeConnectionId
    ? agentCommandsByConnection[activeConnectionId] ?? EMPTY_AGENT_COMMANDS
    : EMPTY_AGENT_COMMANDS;

  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { isActive: slashMenuVisible, query: slashQuery } = useSlashMenu(input);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  const handleSlashSelect = useCallback((cmd: SlashCommandSpec) => {
    setInput(`${cmd.command} `);
    setSlashIndex(0);
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && pendingAttachments.length === 0) return;

    if (pendingAttachments.length === 0 && text === "/settings") {
      useUIStore.getState().setDesktopConfigOpen(true);
      setInput("");
      inputRef.current?.focus();
      return;
    }

    if (!activeConnectionId) return;

    const runLocalCommand = async (): Promise<boolean> => {
      switch (text) {
        case "/clear": {
          try {
            await getPlatform().fetchApi(`/api/history/${encodeURIComponent(chatKey)}`, {
              method: "DELETE",
            });
          } catch (e) {
            console.error("clear history failed:", e);
          }
          useMessageStore.getState().clearMessages(chatKey);
          return true;
        }
        case "/connect":
          try {
            await getPlatform().fetchApi(`/api/bridges/${encodeURIComponent(activeConnectionId)}/connect`, {
              method: "POST",
            });
          } catch (e) {
            console.error("connect failed:", e);
          }
          return true;
        case "/disconnect":
          try {
            await getPlatform().fetchApi(`/api/bridges/${encodeURIComponent(activeConnectionId)}/disconnect`, {
              method: "POST",
            });
          } catch (e) {
            console.error("disconnect failed:", e);
          }
          return true;
        default:
          return false;
      }
    };

    if (pendingAttachments.length === 0) {
      if (await runLocalCommand()) {
        setInput("");
        inputRef.current?.focus();
        return;
      }
    }

    if (pendingAttachments.length > 0) {
      const filesToSend = pendingAttachments;
      const caption = text || undefined;
      const encodedFiles = await Promise.all(
        filesToSend.map(async (file) => ({
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          size: file.size,
          data: await fileToBase64(file),
        })),
      );
      setInput("");
      setPendingAttachments([]);
      useMessageStore.getState().addMessage(chatKey, {
        id: `file-${Date.now()}`,
        role: "user",
        content: caption ?? "",
        files: filesToSend.map((file) => ({
          id: `${file.name}-${file.size}-${file.lastModified}`,
          name: file.name,
          size: file.size,
        })),
        timestamp: Date.now(),
        connectionId: activeConnectionId,
        sessionKey: activeSessionKey,
      });
      if (caption) {
        useSessionStore.getState().touchSessionAutoTitle(activeConnectionId, activeSessionKey, caption);
      }

      getPlatform().sendWsMessage({
        type: WS_EVENTS.SEND_FILE,
        connectionId: activeConnectionId,
        sessionKey: activeSessionKey,
        content: caption ?? "",
        files: encodedFiles,
      });
      return;
    }

    setInput("");

    useMessageStore.getState().addMessage(chatKey, {
      id: `msg-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
      connectionId: activeConnectionId,
      sessionKey: activeSessionKey,
    });
    useSessionStore.getState().touchSessionAutoTitle(activeConnectionId, activeSessionKey, text);

    getPlatform().sendWsMessage({
      type: WS_EVENTS.SEND_MESSAGE,
      connectionId: activeConnectionId,
      sessionKey: activeSessionKey,
      content: text,
    });
  }, [
    input,
    pendingAttachments,
    activeConnectionId,
    activeSessionKey,
    chatKey,
  ]);

  const handleFilesSelected = useCallback((files: File[]) => {
    setPendingAttachments((prev) => {
      const keySet = new Set(prev.map((f) => `${f.name}-${f.size}-${f.lastModified}`));
      const next = [...prev];
      for (const file of files) {
        const key = `${file.name}-${file.size}-${file.lastModified}`;
        if (keySet.has(key)) continue;
        keySet.add(key);
        next.push(file);
      }
      return next;
    });
    inputRef.current?.focus();
  }, []);

  const removePendingAttachment = useCallback((file: File) => {
    const targetKey = `${file.name}-${file.size}-${file.lastModified}`;
    setPendingAttachments((prev) =>
      prev.filter((item) => `${item.name}-${item.size}-${item.lastModified}` !== targetKey),
    );
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashMenuVisible) {
        const filtered = getFilteredCommands(slashQuery, agentCommands);
        const slashMenuInteractive = filtered.length > 0 && !slashQuery.includes(" ");
        if (slashMenuInteractive && e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((prev) => (prev + 1) % filtered.length);
          return;
        }
        if (slashMenuInteractive && e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
          return;
        }
        if (slashMenuInteractive && e.key === "Enter") {
          e.preventDefault();
          if (filtered[slashIndex]) {
            handleSlashSelect(filtered[slashIndex]);
          }
          return;
        }
        if (slashMenuInteractive && e.key === "Tab") {
          e.preventDefault();
          if (filtered[slashIndex]) {
            setInput(`${filtered[slashIndex].command} `);
          }
          return;
        }
        if (slashMenuInteractive && e.key === "Escape") {
          e.preventDefault();
          setInput("");
          return;
        }
      }

      if (e.key === "Escape") {
        if (isTauri()) {
          closeDesktopChat();
        } else {
          useUIStore.getState().setChatOpen(false);
        }
      }
    },
    [slashMenuVisible, slashQuery, slashIndex, agentCommands, handleSlashSelect],
  );

  const handleStop = useCallback(() => {
    if (!activeConnectionId) return;
    getPlatform().sendWsMessage({
      type: WS_EVENTS.SEND_MESSAGE,
      connectionId: activeConnectionId,
      sessionKey: activeSessionKey,
      content: "/stop",
    });
  }, [activeConnectionId, activeSessionKey]);

  const slashMenu = (
    <SlashCommandMenu
      query={slashQuery}
      visible={slashMenuVisible}
      selectedIndex={slashIndex}
      onSelect={handleSlashSelect}
      extraCommands={agentCommands}
    />
  );

  return (
    <div className="flex flex-col h-full">
      <MessageList messages={messages} streamingContent={streaming} sessionKey={activeSessionKey} previews={chatPreviews} />
      <MessageInput
        ref={inputRef}
        value={input}
        onChange={setInput}
        onSend={() => void handleSend()}
        onKeyDown={handleKeyDown}
        slashMenu={slashMenu}
        onFilesSelected={handleFilesSelected}
        pendingAttachments={pendingAttachments}
        onRemoveAttachment={removePendingAttachment}
        sendDisabled={(!input.trim() && pendingAttachments.length === 0) || !activeConnectionId}
        showStopButton={showStopButton}
        onStop={handleStop}
        stopDisabled={!activeConnectionId}
        placeholder={
          pendingAttachments.length > 0
            ? "输入说明（可选），Enter 发送，Shift+Enter 换行"
            : "输入消息，Enter 发送，Shift+Enter 换行"
        }
      />
    </div>
  );
}
