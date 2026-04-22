import { create } from "zustand";

export type PetState = "idle" | "thinking" | "talking" | "happy" | "error";

interface UIState {
  chatOpen: boolean;
  petState: PetState;
  isMobile: boolean;
  settingsOpen: boolean;

  setChatOpen: (open: boolean) => void;
  setPetState: (state: PetState) => void;
  setIsMobile: (mobile: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
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
  chatOpen: persistedUI.chatOpen ?? true,
  petState: persistedUI.petState ?? "idle",
  isMobile: false,
  settingsOpen: false,

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
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));
