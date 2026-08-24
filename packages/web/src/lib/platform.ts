import type { RetryPolicy } from "./store/outbox.js";

export interface StagedAttachmentResult {
  name: string;
  size: number;
  agentPath: string;
}

export interface PlatformAPI {
  connectWs(): void;
  disconnectWs(): void;
  onWsEvent(handler: (type: string, payload: any) => void): () => void;
  sendWsMessage(msg: any, policy: RetryPolicy): string;
  /**
   * Write queued outbox entries to the socket.
   *
   * With no argument this is the reconnect path: failed auto entries are revived
   * and everything sendable goes out. With a clientMsgId it is the user tapping
   * retry on one bubble, and only that entry is touched.
   */
  flushOutbox(clientMsgId?: string): void;
  /** Bytes still queued in the WebSocket send buffer (0 if not open). */
  getWsBufferedAmount(): number;

  /**
   * Stream a chat attachment to the server with real upload progress.
   *
   * Distinct from `fetchApi` because `fetch` cannot report request progress — and the
   * progress indicator this replaces watched `WebSocket.bufferedAmount`, which drains
   * even when the server rejects the frame, so failures rendered as 100% success.
   */
  uploadAttachment(
    connectionId: string,
    file: File,
    onProgress: (percent: number) => void,
  ): Promise<StagedAttachmentResult>;

  fetchApi<T = any>(path: string, options?: RequestInit): Promise<T>;
  /** Like fetchApi but returns the raw Response so callers can read blobs/streams. */
  fetchApiRaw(path: string, options?: RequestInit): Promise<Response>;
}

let _platform: PlatformAPI | null = null;

export function setPlatform(p: PlatformAPI) { _platform = p; }
export function getPlatform(): PlatformAPI {
  if (!_platform) throw new Error("Platform not initialized");
  return _platform;
}
