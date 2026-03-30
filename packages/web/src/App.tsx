import { useEffect, useState } from "react";
import { WS_EVENTS, makeChatKey } from "@cc-pet/shared";
import { setPlatform } from "./lib/platform.js";
import { createWebAdapter } from "./lib/web-adapter.js";
import { Layout } from "./components/Layout.js";
import { ChatWindow } from "./components/ChatWindow.js";
import { Settings } from "./components/Settings.js";
import { useUIStore } from "./lib/store/ui.js";
import { useConnectionStore } from "./lib/store/connection.js";
import { useMessageStore } from "./lib/store/message.js";
import { useSessionStore } from "./lib/store/session.js";
import { useConfigStore } from "./lib/store/config.js";
import { useCommandStore } from "./lib/store/commands.js";
import { normalizeBridgeSlashCommands } from "./lib/slash-commands.js";

export default function App() {
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const adapter = createWebAdapter("");
    setPlatform(adapter);

    adapter.fetchApi("/api/config").then((cfg: any) => {
      useConfigStore.getState().setConfig(cfg);
      const connections = (cfg.bridges ?? []).map((b: any) => ({ id: b.id, name: b.name, connected: false }));
      useConnectionStore.getState().setConnections(connections);
      if (connections.length > 0) {
        useConnectionStore.getState().setActiveConnection(connections[0].id);
      }
    }).catch(() => {
      useUIStore.getState().setSettingsOpen(true);
    });

    const unsub = adapter.onWsEvent((type, payload) => {
      const { connectionId, sessionKey } = payload;
      const resolvedSessionKey =
        connectionId ? (sessionKey ?? useSessionStore.getState().activeSessionKey[connectionId] ?? "default") : undefined;
      const chatKey = connectionId && resolvedSessionKey ? makeChatKey(connectionId, resolvedSessionKey) : "";

      switch (type) {
        case WS_EVENTS.BRIDGE_CONNECTED:
          useConnectionStore.getState().setConnectionStatus(connectionId, payload.connected);
          if (payload.connected) useUIStore.getState().setPetState("happy");
          break;
        case WS_EVENTS.BRIDGE_MESSAGE:
          useMessageStore.getState().addMessage(chatKey, {
            id: `msg-${Date.now()}`, role: "assistant", content: payload.content,
            timestamp: Date.now(), connectionId, sessionKey: resolvedSessionKey,
          });
          useUIStore.getState().setPetState("idle");
          break;
        case WS_EVENTS.BRIDGE_STREAM_DELTA:
          useMessageStore.getState().appendStreamDelta(chatKey, payload.delta);
          useUIStore.getState().setPetState("talking");
          break;
        case WS_EVENTS.BRIDGE_STREAM_DONE:
          useMessageStore.getState().finalizeStream(chatKey, payload.fullText);
          useUIStore.getState().setPetState("idle");
          break;
        case WS_EVENTS.BRIDGE_BUTTONS:
          useMessageStore.getState().addMessage(chatKey, {
            id: `msg-${Date.now()}`, role: "assistant", content: payload.content ?? "",
            timestamp: Date.now(), connectionId, sessionKey: resolvedSessionKey, buttons: payload.buttons,
          });
          useUIStore.getState().setPetState("idle");
          break;
        case WS_EVENTS.BRIDGE_FILE_RECEIVED:
          useMessageStore.getState().addMessage(chatKey, {
            id: `msg-${Date.now()}`,
            role: "assistant",
            content: payload.name ?? "",
            timestamp: Date.now(),
            connectionId,
            sessionKey: resolvedSessionKey,
            files: [
              {
                id: `recv-${Date.now()}`,
                name: payload.name ?? "收到文件",
                size: 0,
              },
            ],
          });
          useUIStore.getState().setPetState("idle");
          break;
        case WS_EVENTS.BRIDGE_TYPING_START:
          useUIStore.getState().setPetState("thinking");
          break;
        case WS_EVENTS.BRIDGE_TYPING_STOP:
          useUIStore.getState().setPetState("idle");
          break;
        case WS_EVENTS.BRIDGE_SKILLS_UPDATED: {
          const connectionId = payload.connectionId as string;
          if (!connectionId) break;
          const cmds = normalizeBridgeSlashCommands(payload.commands as unknown[]);
          useCommandStore.getState().setAgentCommands(connectionId, cmds);
          break;
        }
        case WS_EVENTS.BRIDGE_ERROR:
          if (connectionId) {
            const fallbackSessionKey =
              sessionKey ?? useSessionStore.getState().activeSessionKey[connectionId] ?? "default";
            const errorChatKey = makeChatKey(connectionId, fallbackSessionKey);
            useMessageStore.getState().addMessage(errorChatKey, {
              id: `msg-${Date.now()}`,
              role: "assistant",
              content: `发送失败：${payload.error ?? "Bridge 未连接"}`,
              timestamp: Date.now(),
              connectionId,
              sessionKey: fallbackSessionKey,
            });
          }
          useUIStore.getState().setPetState("error");
          break;
      }
    });

    adapter.connectWs();
    setReady(true);

    return () => { unsub(); adapter.disconnectWs(); };
  }, []);

  if (!ready) return null;

  return (
    <Layout>
      {settingsOpen ? <Settings /> : <ChatWindow />}
    </Layout>
  );
}
