import { create } from "zustand";

export type PetState = "idle" | "thinking" | "talking" | "happy" | "error";

interface UIState {
  chatOpen: boolean;
  petState: PetState;
  isMobile: boolean;

  setChatOpen: (open: boolean) => void;
  setPetState: (state: PetState) => void;
  setIsMobile: (mobile: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  /** Web 主界面聊天区始终在主区域展示；chatOpen 主要表示宠物交互状态。未读是否计入在 App 中对 Web/Tauri 分别处理。 */
  chatOpen: true,
  petState: "idle",
  isMobile: false,

  setChatOpen: (open) => set({ chatOpen: open }),
  setPetState: (petState) => set({ petState }),
  setIsMobile: (isMobile) => set({ isMobile }),
}));
