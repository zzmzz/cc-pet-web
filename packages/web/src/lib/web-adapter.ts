import { WS_EVENTS, makeChatKey } from "@cc-pet/shared";
import type { ChatMessage } from "@cc-pet/shared";
import type { PlatformAPI } from "./platform.js";
import { resolveIncomingSessionRouting } from "./sessionRouting.js";
import { useSessionStore } from "./store/session.js";
import { useOutboxStore } from "./store/outbox.js";
import { useMessageStore } from "./store/message.js";
import { useUIStore } from "./store/ui.js";

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
  const resolved = resolveIncomingSessionRouting({
    payloadSessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    replyCtx,
    knownSessions,
    activeSessionKey,
  });
  return { ...p, sessionKey: resolved.sessionKey, sessionRouteSource: resolved.source };
}

/**
 * Tell the user a `never`-policy send went nowhere.
 *
 * A `never` message (today: `/stop`) must not be queued or replayed — replaying
 * a stop into a later turn would cancel the wrong work. That leaves the drop
 * completely silent, so surface it the same way a bridge error is surfaced: a
 * local assistant bubble in the target chat plus the error pet state.
 */
function reportDroppedControlMessage(msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const p = msg as Record<string, unknown>;
  const connectionId = typeof p.connectionId === "string" ? p.connectionId : "";
  const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : "";
  if (!connectionId || !sessionKey) return;
  useMessageStore.getState().addMessage(makeChatKey(connectionId, sessionKey), {
    id: `msg-${crypto.randomUUID()}`,
    role: "assistant",
    content: "发送失败：网络未连接，请重试",
    timestamp: Date.now(),
    connectionId,
    sessionKey,
  });
  useUIStore.getState().setPetState("error");
}

export function createWebAdapter(serverUrl: string, token: string): PlatformAPI {
  let ws: WebSocket | null = null;
  let eventHandler: ((type: string, payload: any) => void) | null = null;
  let shouldReconnect = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let connectGeneration = 0;
  let onlineHookInstalled = false;
  let expireStaleInterval: ReturnType<typeof setInterval> | null = null;
  /** The first onopen is the initial connect; only later ones need a backfill. */
  let hasOpenedOnce = false;

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

  /**
   * Page a single chat forward from its watermark until it is caught up.
   *
   * Terminates on: a fetch error, an empty page, a page that fails to advance
   * the watermark, or hasMore=false. The strict-advance check is what makes the
   * loop safe — the watermark is the loop variable, so a page whose seqs are all
   * at or below it would otherwise spin forever.
   */
  const backfillChat = async (chatKey: string): Promise<void> => {
    for (;;) {
      const after = useMessageStore.getState().getWatermark(chatKey);
      let res: { messages: ChatMessage[]; hasMore: boolean };
      try {
        res = await api.fetchApi<{ messages: ChatMessage[]; hasMore: boolean }>(
          `/api/history/${encodeURIComponent(chatKey)}?afterSeq=${after}&limit=200`
        );
      } catch (e) {
        console.warn("[cc-pet] backfill fetch failed", { chatKey, error: e });
        return;
      }
      if (res.messages.length === 0) return;
      useMessageStore.getState().mergeMessages(chatKey, res.messages);
      if (useMessageStore.getState().getWatermark(chatKey) <= after) {
        console.warn("[cc-pet] backfill stopped: watermark did not advance", { chatKey, after });
        return;
      }
      if (!res.hasMore) return;
    }
  };

  /**
   * Backfill every chat the client holds state for, not just the active one.
   *
   * A non-active chat is already marked loaded, so switching to it never
   * re-fetches; and live pushes after the reconnect advance its watermark past
   * the gap, making the missed messages unreachable by any later incremental
   * fetch. The cost is proportional to each chat's gap, which is exactly what
   * the afterSeq cursor buys. Sequential to avoid a burst of parallel requests
   * on a phone that just regained signal.
   */
  const backfillAllChats = async (): Promise<void> => {
    const { watermarks, loadedChatKeys } = useMessageStore.getState();
    const chatKeys = new Set<string>([...Object.keys(watermarks), ...loadedChatKeys]);
    for (const chatKey of chatKeys) {
      await backfillChat(chatKey);
    }
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
      const qs = token.trim().length > 0 ? `?token=${encodeURIComponent(token)}` : "";
      const url = `${wsBase}/ws${qs}`;
      const socket = new WebSocket(url);
      ws = socket;

      socket.onopen = () => {
        if (connectGeneration !== gen || ws !== socket) return;
        reconnectAttempt = 0;
        console.info("[cc-pet] ws connected");
        api.flushOutbox();
        if (!expireStaleInterval) {
          expireStaleInterval = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              useOutboxStore.getState().expireStale();
            }
          }, 5_000);
        }

        // Backfill missed downstream messages. The initial connect needs no
        // backfill: hydrate fetches full history and seeds the watermarks.
        if (hasOpenedOnce) {
          void backfillAllChats();
        } else {
          hasOpenedOnce = true;
        }
      };

      socket.onmessage = (e) => {
        if (ws !== socket) return;
        try {
          const msg = JSON.parse(e.data) as { type: string; clientMsgId?: string };
          if (msg.type === WS_EVENTS.MESSAGE_ACK) {
            if (msg.clientMsgId) useOutboxStore.getState().markSent(msg.clientMsgId);
            return;
          }
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
      if (expireStaleInterval) {
        clearInterval(expireStaleInterval);
        expireStaleInterval = null;
      }
      detachWebSocket(ws);
      ws = null;
    },

    onWsEvent(handler) {
      eventHandler = handler;
      return () => {
        eventHandler = null;
      };
    },

    sendWsMessage(msg, policy) {
      if (policy === "never") {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        } else {
          console.warn("[cc-pet] control message dropped: socket not open", { msgType: msg?.type });
          reportDroppedControlMessage(msg);
        }
        return "";
      }

      const clientMsgId = useOutboxStore.getState().enqueue(msg, policy);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ...msg, clientMsgId }));
      }
      return clientMsgId;
    },

    flushOutbox(clientMsgId) {
      if (ws?.readyState !== WebSocket.OPEN) return;
      const outbox = useOutboxStore.getState();
      if (clientMsgId) {
        // Explicit per-message retry: revive just this entry. reviveAuto here
        // would drag every other failed auto entry back onto the wire, which is
        // not what tapping one bubble asked for.
        outbox.resend(clientMsgId);
      } else {
        outbox.reviveAuto();
      }
      const sendable = useOutboxStore
        .getState()
        .takeSendable()
        .filter((e) => !clientMsgId || e.clientMsgId === clientMsgId);
      for (const entry of sendable) {
        ws.send(JSON.stringify({ ...entry.payload, clientMsgId: entry.clientMsgId }));
      }
      // Start the ack budget now that the bytes are on the socket, not at
      // enqueue time — otherwise an entry queued during an outage burns its
      // whole 15 s window offline and expires on the first tick after reconnect.
      useOutboxStore.getState().markTransmitted(sendable.map((e) => e.clientMsgId));
    },

    async fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
      const res = await api.fetchApiRaw(path, options);
      return res.json() as T;
    },

    async fetchApiRaw(path: string, options?: RequestInit): Promise<Response> {
      const base = serverUrl.trim();
      const requestUrl = base.length > 0 ? `${base}${path}` : path;
      const headers = new Headers(options?.headers ?? {});
      const body = options?.body;
      const isFormBody = typeof FormData !== "undefined" && body instanceof FormData;
      if (body && !isFormBody && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      if (token.trim().length > 0) {
        headers.set("Authorization", `Bearer ${token}`);
      }
      return fetch(requestUrl, {
        ...options,
        headers,
      });
    },
  };

  return api;
}
