const PET_ALWAYS_ON_TOP_KEY = "cc-pet-desktop-always-on-top-pet";
const CHAT_ALWAYS_ON_TOP_KEY = "cc-pet-desktop-always-on-top-chat";

export interface DesktopWindowPrefs {
  petAlwaysOnTop: boolean;
  chatAlwaysOnTop: boolean;
}

const DEFAULT_PREFS: DesktopWindowPrefs = {
  petAlwaysOnTop: true,
  chatAlwaysOnTop: true,
};

function parseStored(key: string): boolean | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  return raw === "true";
}

export function getDesktopWindowPrefs(): DesktopWindowPrefs {
  return {
    petAlwaysOnTop: parseStored(PET_ALWAYS_ON_TOP_KEY) ?? DEFAULT_PREFS.petAlwaysOnTop,
    chatAlwaysOnTop: parseStored(CHAT_ALWAYS_ON_TOP_KEY) ?? DEFAULT_PREFS.chatAlwaysOnTop,
  };
}

export function setDesktopWindowPrefs(partial: Partial<DesktopWindowPrefs>): void {
  if (partial.petAlwaysOnTop !== undefined) {
    localStorage.setItem(PET_ALWAYS_ON_TOP_KEY, String(partial.petAlwaysOnTop));
  }
  if (partial.chatAlwaysOnTop !== undefined) {
    localStorage.setItem(CHAT_ALWAYS_ON_TOP_KEY, String(partial.chatAlwaysOnTop));
  }
}
