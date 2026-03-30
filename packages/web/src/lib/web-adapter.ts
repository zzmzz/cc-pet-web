import type { PlatformAPI } from "./platform.js";

export function createWebAdapter(serverUrl: string, token: string): PlatformAPI {
  let ws: WebSocket | null = null;
  let eventHandler: ((type: string, payload: any) => void) | null = null;
  let shouldReconnect = true;

  const api: PlatformAPI = {
    connectWs() {
      shouldReconnect = true;
      const url = `${serverUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(url);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          eventHandler?.(msg.type, msg);
        } catch { /* ignore malformed */ }
      };
      ws.onclose = () => {
        if (shouldReconnect) setTimeout(() => api.connectWs(), 3000);
      };
      ws.onerror = () => {};
    },

    disconnectWs() {
      shouldReconnect = false;
      ws?.close();
      ws = null;
    },

    onWsEvent(handler) {
      eventHandler = handler;
      return () => { eventHandler = null; };
    },

    sendWsMessage(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },

    async fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
      const res = await fetch(`${serverUrl}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...options?.headers,
        },
      });
      return res.json() as T;
    },
  };

  return api;
}
