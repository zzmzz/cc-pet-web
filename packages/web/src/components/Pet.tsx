import { motion, type TargetAndTransition } from "framer-motion";
import { useUIStore, type PetState } from "../lib/store/ui.js";
import { isTauri } from "../lib/platform.js";

import idleImg from "../assets/pet/idle.png";
import thinkingImg from "../assets/pet/thinking.png";
import talkingImg from "../assets/pet/talking.png";
import happyImg from "../assets/pet/happy.png";
import errorImg from "../assets/pet/error.png";

const PET_IMAGES: Record<PetState, string> = {
  idle: idleImg, thinking: thinkingImg, talking: talkingImg, happy: happyImg, error: errorImg,
};

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

  return (
    <motion.div
      className="cursor-pointer select-none"
      animate={STATE_ANIMATIONS[petState]}
      onClick={() => !isTauri() && setChatOpen(!chatOpen)}
      onDoubleClick={() => isTauri() && setChatOpen(!chatOpen)}
    >
      <img src={PET_IMAGES[petState]} alt="pet" className="w-28 h-28 mx-auto" draggable={false} />
      <div className="text-center text-xs text-gray-400 mt-1">{petState}</div>
    </motion.div>
  );
}

export function PetMini() {
  const petState = useUIStore((s) => s.petState);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const chatOpen = useUIStore((s) => s.chatOpen);

  return (
    <motion.button
      className={`w-8 h-8 rounded-full border-2 ${STATE_COLORS[petState]} overflow-hidden flex-shrink-0 bg-surface-tertiary`}
      animate={STATE_ANIMATIONS[petState]}
      onClick={() => setChatOpen(!chatOpen)}
    >
      <img src={PET_IMAGES[petState]} alt="pet" className="w-full h-full object-cover" />
    </motion.button>
  );
}
