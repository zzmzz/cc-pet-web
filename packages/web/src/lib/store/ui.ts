import { create } from "zustand";

export type PetState = "idle" | "thinking" | "talking" | "happy" | "error";
export type WindowMode = "pet" | "chat";

interface UIState {
  chatOpen: boolean;
  petState: PetState;
  isMobile: boolean;
  windowMode: WindowMode;
  desktopConfigOpen: boolean;

  setChatOpen: (open: boolean) => void;
  setPetState: (state: PetState) => void;
  setIsMobile: (mobile: boolean) => void;
  setWindowMode: (mode: WindowMode) => void;
  setDesktopConfigOpen: (open: boolean) => void;
}

const UI_STATE_STORAGE_KEY = "cc-pet-ui-state";

type PersistedUIState = Pick<UIState, "petState" | "chatOpen">;

function readPersistedUIState(): Partial<PersistedUIState> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedUIState> | null;
    if (!parsed || typeof parsed !== "object") return {};
    const next: Partial<PersistedUIState> = {};
    if (typeof parsed.chatOpen === "boolean") next.chatOpen = parsed.chatOpen;
    if (
      parsed.petState === "idle" ||
      parsed.petState === "thinking" ||
      parsed.petState === "talking" ||
      parsed.petState === "happy" ||
      parsed.petState === "error"
    ) {
      next.petState = parsed.petState;
    }
    return next;
  } catch {
    return {};
  }
}

function persistUIState(next: PersistedUIState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors; state still works in memory.
  }
}

const persistedUI = readPersistedUIState();

export const useUIStore = create<UIState>((set) => ({
  /** Web 主界面聊天区始终在主区域展示；chatOpen 主要表示宠物交互状态。未读是否计入在 App 中对 Web/Tauri 分别处理。 */
  chatOpen: persistedUI.chatOpen ?? true,
  petState: persistedUI.petState ?? "idle",
  isMobile: false,
  windowMode: "chat",
  desktopConfigOpen: false,

  setChatOpen: (open) =>
    set((s) => {
      persistUIState({ chatOpen: open, petState: s.petState });
      return { chatOpen: open };
    }),
  setPetState: (petState) =>
    set((s) => {
      persistUIState({ chatOpen: s.chatOpen, petState });
      return { petState };
    }),
  setIsMobile: (isMobile) => set({ isMobile }),
  setWindowMode: (mode) =>
    set((s) => {
      const chatOpen = mode === "chat";
      persistUIState({ chatOpen, petState: s.petState });
      return { windowMode: mode, chatOpen };
    }),
  setDesktopConfigOpen: (open) => set({ desktopConfigOpen: open }),
}));
