import { motion, type TargetAndTransition } from "framer-motion";
import { useEffect, useState } from "react";
import { useUIStore, type PetState } from "../lib/store/ui.js";

import idle256 from "../assets/pet/idle-256.webp";
import thinking256 from "../assets/pet/thinking-256.webp";
import talking256 from "../assets/pet/talking-256.webp";
import happy256 from "../assets/pet/happy-256.webp";
import error256 from "../assets/pet/error-256.webp";
import idle96 from "../assets/pet/idle-96.webp";
import thinking96 from "../assets/pet/thinking-96.webp";
import talking96 from "../assets/pet/talking-96.webp";
import happy96 from "../assets/pet/happy-96.webp";
import error96 from "../assets/pet/error-96.webp";

/** Which asset tier a mount paints: `full` at 112px, `mini` at 32px. */
type PetTier = "full" | "mini";

const DEFAULT_PET_IMAGES: Record<PetTier, Record<PetState, string>> = {
  full: { idle: idle256, thinking: thinking256, talking: talking256, happy: happy256, error: error256 },
  mini: { idle: idle96, thinking: thinking96, talking: talking96, happy: happy96, error: error96 },
};

const petImageOverrideCache = new Map<string, string>();
const petImageOverrideMissCache = new Set<string>();
const PET_IMAGE_CACHE_NAME = "cc-pet-images";
const LEGACY_PET_IMAGE_PREFIX = "cc-pet-image::";

function cacheKey(token: string, state: PetState): string {
  return `${token}::${state}`;
}

/** Same-origin, never-requested url that keys the override inside Cache Storage. */
function cacheUrl(token: string, state: PetState): string {
  return `/__pet-image/${encodeURIComponent(token)}/${state}`;
}

/**
 * Overrides used to live in localStorage as base64 data urls: five of them ate
 * roughly 3.75MB of a ~5MB quota that the outbox also persists into, so a
 * custom pet could silently break the send-retry queue.
 */
function dropLegacyPetImages(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(LEGACY_PET_IMAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Storage disabled; nothing to reclaim.
  }
}

async function readCachedPetImage(token: string, state: PetState): Promise<Blob | null> {
  try {
    const cache = await caches.open(PET_IMAGE_CACHE_NAME);
    const hit = await cache.match(cacheUrl(token, state));
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

async function writeCachedPetImage(token: string, state: PetState, res: Response): Promise<void> {
  try {
    const cache = await caches.open(PET_IMAGE_CACHE_NAME);
    await cache.put(cacheUrl(token, state), res);
  } catch {
    // Cache Storage unavailable or evicted; the in-memory url still renders.
  }
}

function usePetImage(state: PetState, tier: PetTier): string {
  const fallback = DEFAULT_PET_IMAGES[tier][state];
  const [src, setSrc] = useState<string>(fallback);

  useEffect(() => {
    dropLegacyPetImages();
    const token = localStorage.getItem("cc-pet-token")?.trim() ?? "";
    const key = cacheKey(token, state);
    const cached = token ? petImageOverrideCache.get(key) : undefined;
    setSrc(cached ?? fallback);
    if (!token || cached) return;
    if (petImageOverrideMissCache.has(key)) return;

    let cancelled = false;
    const show = (blob: Blob): void => {
      const objectUrl = URL.createObjectURL(blob);
      petImageOverrideCache.set(key, objectUrl);
      setSrc(objectUrl);
    };

    void (async () => {
      // Paint whatever is on disk first, then revalidate: cache-first forever
      // would strand a user who swaps their configured image.
      const stored = await readCachedPetImage(token, state);
      if (cancelled) return;
      if (stored) show(stored);

      try {
        const res = await fetch(`/api/pet-images/${state}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`pet image not found (${res.status})`);
        const fresh = await res.clone().blob();
        if (cancelled) return;
        if (stored && stored.size === fresh.size) return;
        await writeCachedPetImage(token, state, res);
        if (cancelled) return;
        show(fresh);
      } catch {
        if (cancelled || stored) return;
        petImageOverrideMissCache.add(key);
        setSrc(fallback);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state, fallback]);

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
  const petImage = usePetImage(petState, "full");

  return (
    <div className="relative">
      <motion.div
        className="cursor-pointer select-none"
        animate={STATE_ANIMATIONS[petState]}
        onClick={() => {
          setChatOpen(!chatOpen);
        }}
      >
        <img
          src={petImage}
          alt="pet"
          className="h-28 w-28 shrink-0 bg-transparent"
          draggable={false}
          onError={(e) => {
            e.currentTarget.src = DEFAULT_PET_IMAGES.full[petState];
          }}
        />
      </motion.div>
    </div>
  );
}

export function PetMini() {
  const petState = useUIStore((s) => s.petState);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const chatOpen = useUIStore((s) => s.chatOpen);
  const petImage = usePetImage(petState, "mini");

  return (
    <motion.button
      className={`w-8 h-8 rounded-full border-2 ${STATE_COLORS[petState]} overflow-hidden flex-shrink-0 bg-transparent`}
      animate={STATE_ANIMATIONS[petState]}
      onClick={() => {
        setChatOpen(!chatOpen);
      }}
    >
      <img
        src={petImage}
        alt="pet"
        className="w-full h-full object-cover"
        onError={(e) => {
          e.currentTarget.src = DEFAULT_PET_IMAGES.mini[petState];
        }}
      />
    </motion.button>
  );
}
