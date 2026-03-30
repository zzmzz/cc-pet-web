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

  setChatOpen: (open) => set({ chatOpen: open, settingsOpen: open ? false : undefined }),
  setSettingsOpen: (open) => set({ settingsOpen: open, chatOpen: open ? false : undefined }),
  setPetState: (petState) => set({ petState }),
  setIsMobile: (isMobile) => set({ isMobile }),
}));
