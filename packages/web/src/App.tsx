import { useEffect, useState } from "react";
import { WS_EVENTS, makeChatKey, type TaskPhase } from "@cc-pet/shared";
import { setPlatform, type PlatformAPI } from "./lib/platform.js";
import { createWebAdapter } from "./lib/web-adapter.js";
import { Layout } from "./components/Layout.js";
import { ChatWindow } from "./components/ChatWindow.js";
import { LoginGate } from "./components/LoginGate.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { useUIStore, type PetState } from "./lib/store/ui.js";
import { useConnectionStore } from "./lib/store/connection.js";
import { useMessageStore } from "./lib/store/message.js";
import { useSessionStore } from "./lib/store/session.js";
import { useCommandStore } from "./lib/store/commands.js";
import { normalizeBridgeSlashCommands } from "./lib/slash-commands.js";
import { applyDefaultFocusAfterHydrate, hydrateSessionsAndHistory } from "./lib/hydrateFromServer.js";
import {
  checkNotificationSupport,
  getNotificationPermission,
  requestNotificationPermission,
  shouldShowNotification,
  sendTaskCompletionNotification,
  shouldRequestPermissionOnUserGesture,
} from "./lib/notification.js";

const PET_HAPPY_AFTER_CONNECT_MS = 5000;

export default function App() {
  const [ready, setReady] = useState(false);
  const [authBooting, setAuthBooting] = useState(true);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const bootstrapAuth = async () => {
      const storedToken = localStorage.getItem("cc-pet-token")?.trim();
      if (!storedToken) {
        if (!cancelled) setAuthBooting(false);
        return;
      }
      try {
        const res = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: storedToken }),
        });
        if (!cancelled && res.ok) {
          setAuthToken(storedToken);
        }
        if (!res.ok) {
          localStorage.removeItem("cc-pet-token");
        }
      } catch {
        localStorage.removeItem("cc-pet-token");
      } finally {
        if (!cancelled) setAuthBooting(false);
      }
    };
    void bootstrapAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = async (rawToken: string): Promise<boolean> => {
    const token = rawToken.trim();
    if (token.length === 0) {
      setAuthError("Token 不能为空");
      return false;
    }
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        setAuthError("Token 无效");
        return false;
      }
    } catch {
      setAuthError("认证服务不可用，请稍后重试");
      return false;
    }
    localStorage.setItem("cc-pet-token", token);
    setAuthError(null);
    setReady(false);
    setAuthToken(token);
    return true;
  };

  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    let happyAfterConnectTimer: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | null = null;
    const typingActiveByChatKey: Record<string, boolean> = {};
    const stickySessionByConnection: Record<string, string> = {};
    let activeAdapter: PlatformAPI | null = null;
    let isPageHidden = typeof document !== "undefined" && document.hidden;
    let permissionRequestTimer: ReturnType<typeof setTimeout> | null = null;
    let detachPermissionGestureListeners: (() => void) | null = null;

    const subscribeWs = (adapter: PlatformAPI): void => {
      unsub = adapter.onWsEvent((type, payload) => {
        const setPetStateSafely = (state: PetState): void => {
          const shouldForceThinking = useSessionStore.getState().hasProcessingSessions();
          useUIStore.getState().setPetState(shouldForceThinking ? "thinking" : state);
        };

        if (type === WS_EVENTS.BRIDGE_MANIFEST) {
          const bridges = (payload as { bridges?: { id: string; name: string }[] }).bridges ?? [];
          const connections = bridges.map((b) => ({ id: b.id, name: b.name, connected: false }));
          useConnectionStore.getState().setConnections(connections);
          void (async () => {
            try {
              await hydrateSessionsAndHistory(
                adapter,
                bridges.map((b) => b.id),
              );
              applyDefaultFocusAfterHydrate(bridges.map((b) => b.id));
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
          const active = useSessionStore.getState().activeSessionKey[cid] ?? "default";
          if (active !== sessionKey) return true;
          return false;
        };

        const getLastMessageContent = (chatKey: string): string => {
          const messageStore = useMessageStore.getState();
          const streaming = messageStore.streamingContent[chatKey];
          if (streaming && streaming.trim().length > 0) {
            return streaming;
          }
          const messages = messageStore.messagesByChat[chatKey] ?? [];
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "assistant") {
              return messages[i].content;
            }
          }
          return "";
        };

        const trySendNotification = (cid: string, sKey: string): void => {
          if (!cid || !sKey) return;

          if (shouldShowNotification(cid, sKey, isPageHidden)) {
            const ck = makeChatKey(cid, sKey);
            const content = getLastMessageContent(ck);
            sendTaskCompletionNotification(content, cid, sKey);
          }
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
              setPetStateSafely("happy");
              happyAfterConnectTimer = setTimeout(() => {
                happyAfterConnectTimer = null;
                if (useUIStore.getState().petState === "happy") {
                  setPetStateSafely("idle");
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
            const isCompleted = !isTypingActiveForSession();
            setTaskPhase(isCompleted ? "completed" : "working");
            if (isCompleted && connectionId && resolvedSessionKey) {
              trySendNotification(connectionId, resolvedSessionKey);
            }
            if (!connectionId || !resolvedSessionKey || !shouldMarkUnread(connectionId, resolvedSessionKey)) {
              setPetStateSafely("idle");
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
            setPetStateSafely("talking");
            break;
          }
          case WS_EVENTS.BRIDGE_STREAM_DONE:
            useMessageStore.getState().finalizeStream(chatKey, payload.fullText);
            const isStreamCompleted = !isTypingActiveForSession();
            setTaskPhase(isStreamCompleted ? "completed" : "working");
            if (isStreamCompleted && connectionId && resolvedSessionKey) {
              trySendNotification(connectionId, resolvedSessionKey);
            }
            if (useSessionStore.getState().hasAnyUnread()) {
              setPetStateSafely("talking");
            } else {
              setPetStateSafely("idle");
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
              setPetStateSafely("idle");
            }
            break;
          case WS_EVENTS.BRIDGE_FILE_RECEIVED:
            if (connectionId && resolvedSessionKey && shouldMarkUnread(connectionId, resolvedSessionKey)) {
              useSessionStore.getState().incrementUnread(chatKey);
            } else if (connectionId && resolvedSessionKey) {
              setPetStateSafely("happy");
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
            const isFileCompleted = !isTypingActiveForSession();
            setTaskPhase(isFileCompleted ? "completed" : "working");
            if (isFileCompleted && connectionId && resolvedSessionKey) {
              trySendNotification(connectionId, resolvedSessionKey);
            }
            break;
          case WS_EVENTS.BRIDGE_TYPING_START:
            if (chatKey) typingActiveByChatKey[chatKey] = true;
            setTaskPhase("working");
            setPetStateSafely("thinking");
            break;
          case WS_EVENTS.BRIDGE_TYPING_STOP:
            if (!chatKey || typingActiveByChatKey[chatKey] !== true) {
              break;
            }
            typingActiveByChatKey[chatKey] = false;
            setTaskPhase("completed");
            if (connectionId && resolvedSessionKey) {
              trySendNotification(connectionId, resolvedSessionKey);
            }
            setPetStateSafely("idle");
            break;
          case WS_EVENTS.BRIDGE_CARD:
            if (connectionId && resolvedSessionKey && shouldMarkUnread(connectionId, resolvedSessionKey)) {
              useSessionStore.getState().incrementUnread(chatKey);
            }
            setTaskPhase("working");
            useMessageStore.getState().addMessage(chatKey, {
              id: `msg-${Date.now()}`,
              role: "assistant",
              content: payload.card?.header?.title ?? "",
              timestamp: Date.now(),
              connectionId,
              sessionKey: resolvedSessionKey,
              card: payload.card,
            });
            {
              const cardCompleted = !isTypingActiveForSession();
              setTaskPhase(cardCompleted ? "completed" : "working");
              if (cardCompleted && connectionId && resolvedSessionKey) {
                trySendNotification(connectionId, resolvedSessionKey);
              }
            }
            if (!connectionId || !resolvedSessionKey || !shouldMarkUnread(connectionId, resolvedSessionKey)) {
              setPetStateSafely("idle");
            }
            break;
          case WS_EVENTS.BRIDGE_AUDIO:
            if (connectionId && resolvedSessionKey && shouldMarkUnread(connectionId, resolvedSessionKey)) {
              useSessionStore.getState().incrementUnread(chatKey);
            }
            setTaskPhase("working");
            useMessageStore.getState().addMessage(chatKey, {
              id: `msg-${Date.now()}`,
              role: "assistant",
              content: "[音频消息]",
              timestamp: Date.now(),
              connectionId,
              sessionKey: resolvedSessionKey,
              audio: { data: payload.data, format: payload.format ?? "mp3" },
            });
            {
              const audioCompleted = !isTypingActiveForSession();
              setTaskPhase(audioCompleted ? "completed" : "working");
              if (audioCompleted && connectionId && resolvedSessionKey) {
                trySendNotification(connectionId, resolvedSessionKey);
              }
            }
            if (!connectionId || !resolvedSessionKey || !shouldMarkUnread(connectionId, resolvedSessionKey)) {
              setPetStateSafely("idle");
            }
            break;
          case WS_EVENTS.BRIDGE_PREVIEW_START:
            if (chatKey && payload.previewId) {
              useMessageStore.getState().startPreview(chatKey, payload.previewId, payload.content ?? "");
              setTaskPhase("working");
              setPetStateSafely("talking");
            }
            break;
          case WS_EVENTS.BRIDGE_PREVIEW_UPDATE:
            if (payload.previewId) {
              useMessageStore.getState().updatePreview(payload.previewId, payload.content ?? "");
            }
            break;
          case WS_EVENTS.BRIDGE_PREVIEW_DELETE:
            if (payload.previewId) {
              useMessageStore.getState().deletePreview(payload.previewId);
            }
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
            setPetStateSafely("error");
            break;
        }
      });
    };

    const handleVisibilityChange = () => {
      isPageHidden = document.hidden;
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    if (checkNotificationSupport()) {
      const permission = getNotificationPermission();
      if (permission === "default") {
        if (shouldRequestPermissionOnUserGesture() && typeof document !== "undefined") {
          const requestOnFirstInteraction = (): void => {
            if (cancelled) return;
            detachPermissionGestureListeners?.();
            detachPermissionGestureListeners = null;
            void requestNotificationPermission();
          };
          const options: AddEventListenerOptions = { once: true, passive: true };
          document.addEventListener("pointerdown", requestOnFirstInteraction, options);
          document.addEventListener("keydown", requestOnFirstInteraction, options);
          detachPermissionGestureListeners = () => {
            document.removeEventListener("pointerdown", requestOnFirstInteraction);
            document.removeEventListener("keydown", requestOnFirstInteraction);
          };
        } else {
          permissionRequestTimer = setTimeout(() => {
            if (!cancelled) {
              void requestNotificationPermission();
            }
          }, 3000);
        }
      }
    }

    const boot = async () => {
      const adapter = createWebAdapter("", authToken);
      if (cancelled) return;
      activeAdapter = adapter;
      setPlatform(adapter);

      subscribeWs(adapter);
      adapter.connectWs();
    };

    void boot();

    return () => {
      cancelled = true;
      if (happyAfterConnectTimer != null) {
        clearTimeout(happyAfterConnectTimer);
        happyAfterConnectTimer = null;
      }
      if (permissionRequestTimer != null) {
        clearTimeout(permissionRequestTimer);
        permissionRequestTimer = null;
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      detachPermissionGestureListeners?.();
      detachPermissionGestureListeners = null;
      unsub?.();
      activeAdapter?.disconnectWs();
    };
  }, [authToken]);

  if (authBooting) return null;
  if (!authToken) return <LoginGate onSubmit={handleLogin} errorMessage={authError} />;
  if (!ready) return null;

  return (
    <>
      <Layout>
        <ChatWindow />
      </Layout>
      <SettingsPanel />
    </>
  );
}
