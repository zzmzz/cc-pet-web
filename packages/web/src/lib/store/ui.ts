import { create } from "zustand";

export type PetState = "idle" | "thinking" | "talking" | "happy" | "error";

interface UIState {
  chatOpen: boolean;
  settingsOpen: boolean;
  petState: PetState;
  isMobile: boolean;

  setChatOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setPetState: (state: PetState) => void;
  setIsMobile: (mobile: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  chatOpen: false,
  settingsOpen: false,
  petState: "idle",
  isMobile: false,

  setChatOpen: (open) =>
    set(() => ({
      chatOpen: open,
      ...(open ? { settingsOpen: false } : {}),
    })),
  setSettingsOpen: (open) =>
    set(() => ({
      settingsOpen: open,
      ...(open ? { chatOpen: false } : {}),
    })),
  setPetState: (petState) => set({ petState }),
  setIsMobile: (isMobile) => set({ isMobile }),
}));
