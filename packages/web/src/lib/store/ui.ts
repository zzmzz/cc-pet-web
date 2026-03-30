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
  /** Web 主界面聊天区默认可见；与 cc-pet 一致用 chatOpen 表示「展开关注聊天」以便未读判断。 */
  chatOpen: true,
  petState: "idle",
  isMobile: false,

  setChatOpen: (open) => set({ chatOpen: open }),
  setPetState: (petState) => set({ petState }),
  setIsMobile: (isMobile) => set({ isMobile }),
}));
