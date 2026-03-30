import type { PlatformAPI } from "./platform.js";
import { createWebAdapter } from "./web-adapter.js";

/** Desktop entry: wraps `createWebAdapter` (inbound session routing lives in the web adapter). */
export async function createTauriAdapter(serverUrl: string): Promise<PlatformAPI> {
  const base = createWebAdapter(serverUrl);

  return {
    ...base,

    async setWindowMode(mode) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_window_mode", { mode });
    },

    async setAlwaysOnTop(value) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_always_on_top", { value });
    },

    async setOpacity(value) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_opacity", { value });
    },

    async startDrag() {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("start_drag");
    },
  };
}
