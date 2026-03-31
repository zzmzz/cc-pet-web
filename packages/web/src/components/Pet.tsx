import { motion, type TargetAndTransition } from "framer-motion";
import { useEffect, useState } from "react";
import { useUIStore, type PetState } from "../lib/store/ui.js";
import { isTauri } from "../lib/platform.js";

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

function cacheKey(token: string, state: PetState): string {
  return `${token}::${state}`;
}

function usePetImage(state: PetState): string {
  const [src, setSrc] = useState<string>(DEFAULT_PET_IMAGES[state]);

  useEffect(() => {
    const token = localStorage.getItem("cc-pet-token")?.trim() ?? "";
    const fallback = DEFAULT_PET_IMAGES[state];
    setSrc(fallback);
    if (!token) return;

    const key = cacheKey(token, state);
    const cached = petImageOverrideCache.get(key);
    if (cached) {
      setSrc(cached);
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
        return URL.createObjectURL(blob);
      })
      .then((url) => {
        if (cancelled) return;
        petImageOverrideCache.set(key, url);
        setSrc(url);
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
  const petImage = usePetImage(petState);

  return (
    <motion.div
      className="cursor-pointer select-none"
      animate={STATE_ANIMATIONS[petState]}
      onClick={() => !isTauri() && setChatOpen(!chatOpen)}
      onDoubleClick={() => isTauri() && setChatOpen(!chatOpen)}
    >
      <img
        src={petImage}
        alt="pet"
        className="w-28 h-28 mx-auto"
        draggable={false}
        onError={(e) => {
          e.currentTarget.src = DEFAULT_PET_IMAGES[petState];
        }}
      />
      <div className="text-center text-xs text-gray-400 mt-1">{petState}</div>
    </motion.div>
  );
}

export function PetMini() {
  const petState = useUIStore((s) => s.petState);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const chatOpen = useUIStore((s) => s.chatOpen);
  const petImage = usePetImage(petState);

  return (
    <motion.button
      className={`w-8 h-8 rounded-full border-2 ${STATE_COLORS[petState]} overflow-hidden flex-shrink-0 bg-surface-tertiary`}
      animate={STATE_ANIMATIONS[petState]}
      onClick={() => setChatOpen(!chatOpen)}
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
