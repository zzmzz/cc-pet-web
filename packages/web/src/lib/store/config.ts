import { create } from "zustand";
import type { AppConfig } from "@cc-pet/shared";

interface ConfigState {
  config: AppConfig | null;
  setConfig: (config: AppConfig) => void;
}

export const useConfigStore = create<ConfigState>((set) => ({
  config: null,
  setConfig: (config) => set({ config }),
}));
