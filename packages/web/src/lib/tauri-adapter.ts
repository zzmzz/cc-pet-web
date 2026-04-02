import type { PlatformAPI } from "./platform.js";
import { createWebAdapter } from "./web-adapter.js";

/** Desktop entry: wraps `createWebAdapter` with Tauri window control commands (soft-degrading). */
export function createTauriAdapter(serverUrl: string, token: string): PlatformAPI {
  const base = createWebAdapter(serverUrl, token);

  return {
    ...base,

    async setWindowMode(mode, opts) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_window_mode", {
          mode,
          preserveSize: opts?.preserveSize === true,
        });
      } catch (e) {
        console.warn("[cc-pet] setWindowMode failed:", e);
      }
    },

    async setAlwaysOnTop(value) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_always_on_top", { value });
      } catch (e) {
        console.warn("[cc-pet] setAlwaysOnTop failed:", e);
      }
    },

    async setOpacity(value) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_opacity", { value });
      } catch (e) {
        console.warn("[cc-pet] setOpacity failed:", e);
      }
    },

    async startDrag() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("start_drag");
      } catch (e) {
        console.warn("[cc-pet] startDrag failed:", e);
      }
    },

    async toggleVisibility() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("toggle_window_visibility");
      } catch (e) {
        console.warn("[cc-pet] toggleVisibility failed:", e);
      }
    },

    async quit() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("quit_app");
      } catch (e) {
        console.warn("[cc-pet] quit failed:", e);
      }
    },
  };
}
