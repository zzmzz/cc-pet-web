import { motion, type TargetAndTransition } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useUIStore, type PetState, type WindowMode } from "../lib/store/ui.js";
import { isTauri, getPlatform } from "../lib/platform.js";

import idleImg from "../assets/pet/idle.png";
import thinkingImg from "../assets/pet/thinking.png";
import talkingImg from "../assets/pet/talking.png";
import happyImg from "../assets/pet/happy.png";
import errorImg from "../assets/pet/error.png";

const DEFAULT_PET_IMAGES: Record<PetState, string> = {
  idle: idleImg, thinking: thinkingImg, talking: talkingImg, happy: happyImg, error: errorImg,
};

const petImageOverrideCache = new Map<string, string>();
const petImageOverrideMissCache = new Set<string>();
const PET_IMAGE_STORAGE_PREFIX = "cc-pet-image::";

function cacheKey(token: string, state: PetState): string {
  return `${token}::${state}`;
}

function storageKey(token: string, state: PetState): string {
  return `${PET_IMAGE_STORAGE_PREFIX}${cacheKey(token, state)}`;
}

function readPersistedPetImage(token: string, state: PetState): string | null {
  try {
    const value = localStorage.getItem(storageKey(token, state));
    return value && value.startsWith("data:image/") ? value : null;
  } catch {
    return null;
  }
}

function persistPetImage(token: string, state: PetState, blob: Blob): void {
  const reader = new FileReader();
  reader.onload = () => {
    const result = reader.result;
    if (typeof result !== "string" || !result.startsWith("data:image/")) return;
    try {
      localStorage.setItem(storageKey(token, state), result);
    } catch {
      // Ignore quota and storage errors, runtime cache still works.
    }
  };
  reader.readAsDataURL(blob);
}

function usePetImage(state: PetState): string {
  const [src, setSrc] = useState<string>(DEFAULT_PET_IMAGES[state]);

  useEffect(() => {
    const token = localStorage.getItem("cc-pet-token")?.trim() ?? "";
    const fallback = DEFAULT_PET_IMAGES[state];
    const key = cacheKey(token, state);
    const cached = token ? petImageOverrideCache.get(key) : undefined;
    const persisted = token ? readPersistedPetImage(token, state) : null;
    setSrc(cached ?? persisted ?? fallback);
    if (!token) return;

    if (cached) {
      return;
    }
    if (petImageOverrideMissCache.has(key)) return;

    let cancelled = false;
    void fetch(`/api/pet-images/${state}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`pet image not found (${res.status})`);
        const blob = await res.blob();
        return { blob, objectUrl: URL.createObjectURL(blob) };
      })
      .then(({ blob, objectUrl }) => {
        if (cancelled) return;
        petImageOverrideCache.set(key, objectUrl);
        persistPetImage(token, state, blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (cancelled) return;
        petImageOverrideMissCache.add(key);
        setSrc(fallback);
      });

    return () => {
      cancelled = true;
    };
  }, [state]);

  return src;
}

const STATE_COLORS: Record<PetState, string> = {
  idle: "border-green-500", thinking: "border-yellow-500", talking: "border-blue-500",
  happy: "border-green-500", error: "border-red-500",
};

const STATE_ANIMATIONS: Record<PetState, TargetAndTransition> = {
  idle: {},
  thinking: { scale: [1, 1.05, 1], transition: { repeat: Infinity, duration: 1.5 } },
  talking: { opacity: [1, 0.8, 1], transition: { repeat: Infinity, duration: 1 } },
  happy: { y: [0, -4, 0], transition: { repeat: Infinity, duration: 0.6 } },
  error: { x: [0, -3, 3, -3, 0], transition: { repeat: Infinity, duration: 0.4 } },
};

export function PetFull() {
  const petState = useUIStore((s) => s.petState);
  const chatOpen = useUIStore((s) => s.chatOpen);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const windowMode = useUIStore((s) => s.windowMode);
  const setWindowMode = useUIStore((s) => s.setWindowMode);
  const setDesktopConfigOpen = useUIStore((s) => s.setDesktopConfigOpen);
  const petImage = usePetImage(petState);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const handleDesktopToggle = () => {
    const newMode: WindowMode = windowMode === "pet" ? "chat" : "pet";
    setWindowMode(newMode);
    getPlatform().setWindowMode?.(newMode);
  };

  useEffect(() => {
    if (!contextMenuOpen) return;
    const onDocDown = (evt: MouseEvent) => {
      if (!contextMenuRef.current?.contains(evt.target as Node)) {
        setContextMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [contextMenuOpen]);

  useEffect(() => {
    if (!isTauri() || windowMode !== "pet" || !contextMenuOpen) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke("set_pet_hit_through_enabled", { enabled: false });
    });
    return () => {
      void import("@tauri-apps/api/core").then(({ invoke }) => {
        void invoke("set_pet_hit_through_enabled", { enabled: true });
      });
    };
  }, [contextMenuOpen, windowMode]);

  return (
    <div className="relative">
      <motion.div
        className="cursor-pointer select-none"
        animate={STATE_ANIMATIONS[petState]}
        onClick={() => {
          if (isTauri()) {
            if (windowMode === "chat") handleDesktopToggle();
          } else {
            setChatOpen(!chatOpen);
          }
        }}
        onDoubleClick={() => {
          if (isTauri() && windowMode === "pet") handleDesktopToggle();
        }}
        onMouseDown={(evt) => {
          if (evt.button !== 0) return;
          if (isTauri() && windowMode === "pet") {
            evt.preventDefault();
            void getPlatform().startDrag?.();
          }
        }}
        onContextMenu={(evt) => {
          if (!isTauri()) return;
          evt.preventDefault();
          setContextMenuOpen(true);
        }}
      >
        <img
          src={petImage}
          alt="pet"
          className="h-28 w-28 shrink-0 bg-transparent"
          draggable={false}
          onError={(e) => {
            e.currentTarget.src = DEFAULT_PET_IMAGES[petState];
          }}
        />
      </motion.div>
      {isTauri() && contextMenuOpen ? (
        <div
          ref={contextMenuRef}
          className="absolute left-full top-1/2 z-40 min-w-[130px] -translate-y-1/2 rounded-md border border-border bg-surface-secondary p-1 shadow-lg"
        >
          <button
            className="block w-full rounded px-2 py-1 text-left text-xs text-text-primary hover:bg-surface"
            onClick={() => {
              setContextMenuOpen(false);
              setWindowMode("chat");
              getPlatform().setWindowMode?.("chat");
            }}
          >
            打开聊天
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left text-xs text-text-primary hover:bg-surface"
            onClick={() => {
              setContextMenuOpen(false);
              setWindowMode("chat");
              getPlatform().setWindowMode?.("chat");
              setDesktopConfigOpen(true);
            }}
          >
            连接配置
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left text-xs text-text-primary hover:bg-surface"
            onClick={() => {
              setContextMenuOpen(false);
              getPlatform().toggleVisibility?.();
            }}
          >
            隐藏/显示
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left text-xs text-red-500 hover:bg-red-50"
            onClick={() => {
              setContextMenuOpen(false);
              getPlatform().quit?.();
            }}
          >
            退出
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function PetMini() {
  const petState = useUIStore((s) => s.petState);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const chatOpen = useUIStore((s) => s.chatOpen);
  const setWindowMode = useUIStore((s) => s.setWindowMode);
  const petImage = usePetImage(petState);

  return (
    <motion.button
      className={`w-8 h-8 rounded-full border-2 ${STATE_COLORS[petState]} overflow-hidden flex-shrink-0 bg-transparent`}
      animate={STATE_ANIMATIONS[petState]}
      onClick={() => {
        if (isTauri()) {
          setWindowMode("pet");
          getPlatform().setWindowMode?.("pet");
        } else {
          setChatOpen(!chatOpen);
        }
      }}
    >
      <img
        src={petImage}
        alt="pet"
        className="w-full h-full object-cover"
        onError={(e) => {
          e.currentTarget.src = DEFAULT_PET_IMAGES[petState];
        }}
      />
    </motion.button>
  );
}
