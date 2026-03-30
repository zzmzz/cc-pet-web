import { WS_EVENTS } from "@cc-pet/shared";
import type { PlatformAPI } from "./platform.js";
import { resolveIncomingSessionKey } from "./sessionRouting.js";
import { useSessionStore } from "./store/session.js";

const INITIAL_RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 60_000;

function detachWebSocket(socket: WebSocket | null): void {
  if (!socket) return;
  socket.onopen = () => {
    /* detached */
  };
  socket.onmessage = () => {
    /* detached */
  };
  socket.onerror = () => {
    /* detached */
  };
  socket.onclose = () => {
    /* detached */
  };
  try {
    socket.close();
  } catch {
    // ignore
  }
}

export type WebAdapterIncomingSessionRoutingContext = {
  knownSessions: string[];
  activeSessionKey?: string;
};

/** Bridge WS event types that carry a session target before UI consumption. */
const INCOMING_SESSION_ROUTING_TYPES = new Set<string>([
  WS_EVENTS.BRIDGE_MESSAGE,
  WS_EVENTS.BRIDGE_STREAM_DELTA,
  WS_EVENTS.BRIDGE_STREAM_DONE,
  WS_EVENTS.BRIDGE_BUTTONS,
  WS_EVENTS.BRIDGE_FILE_RECEIVED,
  WS_EVENTS.BRIDGE_TYPING_START,
  WS_EVENTS.BRIDGE_TYPING_STOP,
  WS_EVENTS.BRIDGE_PREVIEW_START,
  WS_EVENTS.BRIDGE_PREVIEW_UPDATE,
  WS_EVENTS.BRIDGE_PREVIEW_DELETE,
  WS_EVENTS.BRIDGE_ERROR,
]);

function defaultIncomingSessionRoutingContext(connectionId: string): WebAdapterIncomingSessionRoutingContext {
  const s = useSessionStore.getState();
  const sessions = s.sessions[connectionId] ?? [];
  return {
    knownSessions: sessions.map((x) => x.key),
    activeSessionKey: s.activeSessionKey[connectionId],
  };
}

/**
 * Applies payloadSessionKey > replyCtx > active > knownSessions[0] > default before handlers run.
 * Exported for integration tests that bypass the real WebSocket layer.
 */
export function applyIncomingWsSessionRouting(
  type: string,
  payload: unknown,
  getCtx: (connectionId: string) => WebAdapterIncomingSessionRoutingContext = defaultIncomingSessionRoutingContext,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  const connectionId = p.connectionId;
  if (typeof connectionId !== "string" || connectionId.length === 0) return payload;
  if (!INCOMING_SESSION_ROUTING_TYPES.has(type)) return payload;

  const { knownSessions, activeSessionKey } = getCtx(connectionId);
  const replyCtx =
    (typeof p.replyCtx === "string" ? p.replyCtx : undefined) ??
    (typeof p.reply_ctx === "string" ? p.reply_ctx : undefined);
  const resolved = resolveIncomingSessionKey({
    payloadSessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    replyCtx,
    knownSessions,
    activeSessionKey,
  });
  return { ...p, sessionKey: resolved };
}

export function createWebAdapter(serverUrl: string): PlatformAPI {
  let ws: WebSocket | null = null;
  let eventHandler: ((type: string, payload: any) => void) | null = null;
  let shouldReconnect = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let connectGeneration = 0;
  let onlineHookInstalled = false;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    clearReconnectTimer();
    if (!shouldReconnect) return;
    const delay = Math.min(MAX_RECONNECT_MS, INITIAL_RECONNECT_MS * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    console.warn("[cc-pet] dashboard ws reconnect scheduled", { delayMs: delay, attempt: reconnectAttempt });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      api.connectWs();
    }, delay);
  };

  const onBrowserOnline = (): void => {
    if (!shouldReconnect) return;
    if (typeof WebSocket === "undefined") return;
    if (ws?.readyState === WebSocket.OPEN) return;
    console.info("[cc-pet] browser online — reconnecting dashboard ws");
    clearReconnectTimer();
    reconnectAttempt = 0;
    api.connectWs();
  };

  const ensureOnlineListener = (): void => {
    if (typeof window === "undefined" || onlineHookInstalled) return;
    onlineHookInstalled = true;
    window.addEventListener("online", onBrowserOnline);
  };

  const removeOnlineListener = (): void => {
    if (typeof window === "undefined" || !onlineHookInstalled) return;
    window.removeEventListener("online", onBrowserOnline);
    onlineHookInstalled = false;
  };

  const api: PlatformAPI = {
    connectWs() {
      clearReconnectTimer();
      shouldReconnect = true;
      ensureOnlineListener();

      connectGeneration += 1;
      const gen = connectGeneration;

      detachWebSocket(ws);
      ws = null;

      const wsBase =
        serverUrl.trim().length > 0
          ? serverUrl.replace(/^http/, "ws")
          : `${window.location.origin.replace(/^http/, "ws")}`;
      const url = `${wsBase}/ws`;
      const socket = new WebSocket(url);
      ws = socket;

      socket.onopen = () => {
        if (connectGeneration !== gen || ws !== socket) return;
        reconnectAttempt = 0;
        console.info("[cc-pet] ws connected");
      };

      socket.onmessage = (e) => {
        if (ws !== socket) return;
        try {
          const msg = JSON.parse(e.data) as { type: string };
          const routed = applyIncomingWsSessionRouting(msg.type, msg) as typeof msg;
          eventHandler?.(routed.type, routed);
        } catch {
          /* ignore malformed */
        }
      };

      socket.onclose = (event) => {
        if (ws !== socket) return;
        ws = null;
        if (shouldReconnect) {
          console.warn("[cc-pet] ws closed", { code: event.code, reason: event.reason });
          scheduleReconnect();
        } else {
          console.info("[cc-pet] ws closed during cleanup", { code: event.code, reason: event.reason });
        }
      };

      socket.onerror = () => {
        if (ws !== socket) return;
        if (shouldReconnect) {
          console.error("[cc-pet] ws error");
          // Some runtimes may emit `error` without a following `close`.
          // Keep reconnect behavior robust by scheduling retry here as a fallback.
          scheduleReconnect();
        } else {
          console.info("[cc-pet] ws error during cleanup");
        }
      };
    },

    disconnectWs() {
      shouldReconnect = false;
      clearReconnectTimer();
      connectGeneration += 1;
      removeOnlineListener();
      detachWebSocket(ws);
      ws = null;
    },

    onWsEvent(handler) {
      eventHandler = handler;
      return () => {
        eventHandler = null;
      };
    },

    sendWsMessage(msg) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return;
      }
      console.error("[cc-pet] ws send skipped: socket is not open", {
        readyState: ws?.readyState ?? "null",
        msgType: msg?.type,
      });
    },

    async fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
      const base = serverUrl.trim();
      const requestUrl = base.length > 0 ? `${base}${path}` : path;
      const res = await fetch(requestUrl, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers,
        },
      });
      return res.json() as T;
    },
  };

  return api;
}
