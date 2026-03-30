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
import { useConfigStore } from "./lib/store/config.js";

export default function App() {
  const { settingsOpen } = useUIStore();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const serverUrl = localStorage.getItem("cc-pet-server-url") ?? "http://localhost:3000";
    const token = localStorage.getItem("cc-pet-token") ?? "cc-pet-dev";

    const adapter = createWebAdapter(serverUrl, token);
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
      const chatKey = connectionId && sessionKey ? makeChatKey(connectionId, sessionKey) : "";

      switch (type) {
        case WS_EVENTS.BRIDGE_CONNECTED:
          useConnectionStore.getState().setConnectionStatus(connectionId, payload.connected);
          if (payload.connected) useUIStore.getState().setPetState("happy");
          break;
        case WS_EVENTS.BRIDGE_MESSAGE:
          useMessageStore.getState().addMessage(chatKey, {
            id: `msg-${Date.now()}`, role: "assistant", content: payload.content,
            timestamp: Date.now(), connectionId, sessionKey,
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
            timestamp: Date.now(), connectionId, sessionKey, buttons: payload.buttons,
          });
          useUIStore.getState().setPetState("idle");
          break;
        case WS_EVENTS.BRIDGE_TYPING_START:
          useUIStore.getState().setPetState("thinking");
          break;
        case WS_EVENTS.BRIDGE_TYPING_STOP:
          useUIStore.getState().setPetState("idle");
          break;
        case WS_EVENTS.BRIDGE_ERROR:
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
