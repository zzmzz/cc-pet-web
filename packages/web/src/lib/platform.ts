export interface PlatformAPI {
  connectWs(): void;
  disconnectWs(): void;
  onWsEvent(handler: (type: string, payload: any) => void): () => void;
  sendWsMessage(msg: any): void;
  /** Bytes still queued in the WebSocket send buffer (0 if not open). */
  getWsBufferedAmount(): number;

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
