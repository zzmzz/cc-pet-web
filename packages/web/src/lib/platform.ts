export interface PlatformAPI {
  connectWs(): void;
  disconnectWs(): void;
  onWsEvent(handler: (type: string, payload: any) => void): () => void;
  sendWsMessage(msg: any): void;

  fetchApi<T = any>(path: string, options?: RequestInit): Promise<T>;

  setWindowMode?(
    mode: "pet" | "chat" | "settings",
    opts?: { preserveSize?: boolean; anchorFromPet?: boolean },
  ): void | Promise<void>;
  setAlwaysOnTop?(value: boolean): void;
  setOpacity?(value: number): void;
  startDrag?(): void;
  toggleVisibility?(): void;
  quit?(): void;
}

let _platform: PlatformAPI | null = null;

export function setPlatform(p: PlatformAPI) { _platform = p; }
export function getPlatform(): PlatformAPI {
  if (!_platform) throw new Error("Platform not initialized");
  return _platform;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}
