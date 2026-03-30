import { useEffect, useState } from "react";
import { WS_EVENTS, makeChatKey, type TaskPhase } from "@cc-pet/shared";
import { setPlatform } from "./lib/platform.js";
import { createWebAdapter } from "./lib/web-adapter.js";
import { Layout } from "./components/Layout.js";
import { ChatWindow } from "./components/ChatWindow.js";
import { useUIStore } from "./lib/store/ui.js";
import { useConnectionStore } from "./lib/store/connection.js";
import { useMessageStore } from "./lib/store/message.js";
import { useSessionStore } from "./lib/store/session.js";
import { useCommandStore } from "./lib/store/commands.js";
import { normalizeBridgeSlashCommands } from "./lib/slash-commands.js";
import { hydrateSessionsAndHistory } from "./lib/hydrateFromServer.js";

const PET_HAPPY_AFTER_CONNECT_MS = 5000;

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let happyAfterConnectTimer: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | null = null;
    const typingActiveByChatKey: Record<string, boolean> = {};
    const stickySessionByConnection: Record<string, string> = {};
    const adapter = createWebAdapter("");
    setPlatform(adapter);

    const subscribeWs = (): void => {
      unsub = adapter.onWsEvent((type, payload) => {
        if (type === WS_EVENTS.BRIDGE_MANIFEST) {
          const bridges = (payload as { bridges?: { id: string; name: string }[] }).bridges ?? [];
          const connections = bridges.map((b) => ({ id: b.id, name: b.name, connected: false }));
          useConnectionStore.getState().setConnections(connections);
          if (connections.length > 0) {
            useConnectionStore.getState().setActiveConnection(connections[0].id);
          } else {
            useConnectionStore.getState().setActiveConnection(null);
          }
          void (async () => {
            try {
              await hydrateSessionsAndHistory(
                adapter,
                bridges.map((b) => b.id),
              );
            } finally {
              if (!cancelled) setReady(true);
            }
          })();
          return;
        }

        const { connectionId, sessionKey } = payload as {
          connectionId?: string;
          sessionKey?: string;
          sessionRouteSource?: "payload" | "reply_ctx" | "active" | "known" | "fallback";
        };
        const routeSource = (payload as { sessionRouteSource?: string }).sessionRouteSource;
        let resolvedSessionKey =
          connectionId ? (sessionKey ?? useSessionStore.getState().activeSessionKey[connectionId] ?? "default") : undefined;
        if (connectionId && resolvedSessionKey && (routeSource === "payload" || routeSource === "reply_ctx")) {
          stickySessionByConnection[connectionId] = resolvedSessionKey;
        }
        if (connectionId && (routeSource === "active" || routeSource === "known" || routeSource === "fallback")) {
          const sticky = stickySessionByConnection[connectionId];
          if (sticky) {
            resolvedSessionKey = sticky;
          }
        }
        const findTypingActiveSession = (cid: string): string | undefined => {
          const prefix = `${cid}::`;
          for (const [ck, active] of Object.entries(typingActiveByChatKey)) {
            if (active && ck.startsWith(prefix)) {
              return ck.slice(prefix.length);
            }
          }
          return undefined;
        };
        if (connectionId && (routeSource === "active" || routeSource === "known" || routeSource === "fallback")) {
          const typingSession = findTypingActiveSession(connectionId);
          if (typingSession) {
            resolvedSessionKey = typingSession;
          }
        }
        const chatKey = connectionId && resolvedSessionKey ? makeChatKey(connectionId, resolvedSessionKey) : "";
        const isTypingActiveForSession = (): boolean => (chatKey ? typingActiveByChatKey[chatKey] === true : false);

        const setTaskPhase = (phase: TaskPhase): void => {
          if (connectionId && resolvedSessionKey) {
            const store = useSessionStore.getState();
            const prev = store.taskStateByConnection[connectionId]?.[resolvedSessionKey];
            const now = Date.now();
            store.patchSessionTaskState(connectionId, resolvedSessionKey, {
              activeRequestId:
                phase === "completed" || phase === "failed" || phase === "idle"
                  ? null
                  : (prev?.activeRequestId ?? `incoming-${now}`),
              phase,
              startedAt: prev?.startedAt ?? now,
              lastActivityAt: now,
              firstTokenAt:
                phase === "working"
                  ? (prev?.firstTokenAt ?? now)
                  : (prev?.firstTokenAt ?? null),
              stalledReason: phase === "stalled" ? (prev?.stalledReason ?? "stream_idle_timeout") : null,
            });
          }
        };

        const shouldMarkUnread = (cid: string, sessionKey: string): boolean => {
          const chatOpen = useUIStore.getState().chatOpen;
          const active = useSessionStore.getState().activeSessionKey[cid] ?? "default";
          return !chatOpen || active !== sessionKey;
        };

        switch (type) {
          case WS_EVENTS.BRIDGE_CONNECTED:
            if (connectionId) {
              useConnectionStore.getState().setConnectionStatus(connectionId, payload.connected);
            }
            if (payload.connected) {
              if (happyAfterConnectTimer != null) {
                clearTimeout(happyAfterConnectTimer);
                happyAfterConnectTimer = null;
              }
              useUIStore.getState().setPetState("happy");
              happyAfterConnectTimer = setTimeout(() => {
                happyAfterConnectTimer = null;
                if (useUIStore.getState().petState === "happy") {
                  useUIStore.getState().setPetState("idle");
                }
              }, PET_HAPPY_AFTER_CONNECT_MS);
            } else if (happyAfterConnectTimer != null) {
              clearTimeout(happyAfterConnectTimer);
              happyAfterConnectTimer = null;
            }
            break;
          case WS_EVENTS.BRIDGE_MESSAGE:
            if (connectionId && resolvedSessionKey && shouldMarkUnread(connectionId, resolvedSessionKey)) {
              useSessionStore.getState().incrementUnread(chatKey);
            }
            setTaskPhase("working");
            useMessageStore.getState().addMessage(chatKey, {
              id: `msg-${Date.now()}`,
              role: "assistant",
              content: payload.content,
              timestamp: Date.now(),
              connectionId,
              sessionKey: resolvedSessionKey,
            });
            setTaskPhase(isTypingActiveForSession() ? "working" : "completed");
            if (!connectionId || !resolvedSessionKey || !shouldMarkUnread(connectionId, resolvedSessionKey)) {
              useUIStore.getState().setPetState("idle");
            }
            break;
          case WS_EVENTS.BRIDGE_STREAM_DELTA: {
            const firstChunk =
              connectionId && resolvedSessionKey
                ? (useMessageStore.getState().streamingContent[chatKey] ?? "").length === 0
                : false;
            if (
              connectionId &&
              resolvedSessionKey &&
              firstChunk &&
              shouldMarkUnread(connectionId, resolvedSessionKey)
            ) {
              useSessionStore.getState().incrementUnread(chatKey);
            }
            useMessageStore.getState().appendStreamDelta(chatKey, payload.delta);
            setTaskPhase("working");
            useUIStore.getState().setPetState("talking");
            break;
          }
          case WS_EVENTS.BRIDGE_STREAM_DONE:
            useMessageStore.getState().finalizeStream(chatKey, payload.fullText);
            setTaskPhase(isTypingActiveForSession() ? "working" : "completed");
            if (useSessionStore.getState().hasAnyUnread()) {
              useUIStore.getState().setPetState("talking");
            } else {
              useUIStore.getState().setPetState("idle");
            }
            break;
          case WS_EVENTS.BRIDGE_BUTTONS:
            if (connectionId && resolvedSessionKey && shouldMarkUnread(connectionId, resolvedSessionKey)) {
              useSessionStore.getState().incrementUnread(chatKey);
            }
            useMessageStore.getState().addMessage(chatKey, {
              id: `msg-${Date.now()}`,
              role: "assistant",
              content: payload.content ?? "",
              timestamp: Date.now(),
              connectionId,
              sessionKey: resolvedSessionKey,
              buttons: payload.buttons,
            });
            setTaskPhase(
              isTypingActiveForSession() ? "working" : "awaiting_confirmation",
            );
            if (!connectionId || !resolvedSessionKey || !shouldMarkUnread(connectionId, resolvedSessionKey)) {
              useUIStore.getState().setPetState("idle");
            }
            break;
          case WS_EVENTS.BRIDGE_FILE_RECEIVED:
            if (connectionId && resolvedSessionKey && shouldMarkUnread(connectionId, resolvedSessionKey)) {
              useSessionStore.getState().incrementUnread(chatKey);
            } else if (connectionId && resolvedSessionKey) {
              useUIStore.getState().setPetState("happy");
            }
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
            setTaskPhase(isTypingActiveForSession() ? "working" : "completed");
            break;
          case WS_EVENTS.BRIDGE_TYPING_START:
            if (chatKey) typingActiveByChatKey[chatKey] = true;
            setTaskPhase("working");
            useUIStore.getState().setPetState("thinking");
            break;
          case WS_EVENTS.BRIDGE_TYPING_STOP:
            // Ignore stray/misaligned typing_stop to avoid premature completed state.
            if (!chatKey || typingActiveByChatKey[chatKey] !== true) {
              break;
            }
            typingActiveByChatKey[chatKey] = false;
            setTaskPhase("completed");
            useUIStore.getState().setPetState("idle");
            break;
          case WS_EVENTS.BRIDGE_SKILLS_UPDATED: {
            const cid = payload.connectionId as string;
            if (!cid) break;
            const cmds = normalizeBridgeSlashCommands(payload.commands as unknown[]);
            useCommandStore.getState().setAgentCommands(cid, cmds);
            break;
          }
          case WS_EVENTS.BRIDGE_ERROR:
            if (connectionId) {
              const fallbackSessionKey =
                sessionKey ?? useSessionStore.getState().activeSessionKey[connectionId] ?? "default";
              const errorChatKey = makeChatKey(connectionId, fallbackSessionKey);
              typingActiveByChatKey[errorChatKey] = false;
              useSessionStore.getState().setSessionTaskPhase(connectionId, fallbackSessionKey, "failed");
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
    };

    subscribeWs();
    adapter.connectWs();

    return () => {
      cancelled = true;
      if (happyAfterConnectTimer != null) {
        clearTimeout(happyAfterConnectTimer);
        happyAfterConnectTimer = null;
      }
      unsub?.();
      adapter.disconnectWs();
    };
  }, []);

  if (!ready) return null;

  return (
    <Layout>
      <ChatWindow />
    </Layout>
  );
}
