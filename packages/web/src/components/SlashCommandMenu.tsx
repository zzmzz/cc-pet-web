import { useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { SlashCommand } from "@cc-pet/shared";
import {
  CATEGORY_LABELS,
  getFilteredCommands,
  type SlashCommandSpec,
} from "../lib/slash-commands.js";

export type { SlashCommandSpec };

interface SlashCommandMenuProps {
  query: string;
  visible: boolean;
  selectedIndex: number;
  onSelect: (cmd: SlashCommandSpec) => void;
  extraCommands?: SlashCommand[];
}

export function SlashCommandMenu({
  query,
  visible,
  selectedIndex,
  onSelect,
  extraCommands = [],
}: SlashCommandMenuProps) {
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const filtered = useMemo(
    () => getFilteredCommands(query, extraCommands),
    [query, extraCommands],
  );

  const grouped = useMemo(() => {
    const groups: Record<string, SlashCommandSpec[]> = {};
    for (const cmd of filtered) {
      if (!groups[cmd.category]) groups[cmd.category] = [];
      groups[cmd.category].push(cmd);
    }
    return groups;
  }, [filtered]);

  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const setItemRef = useCallback((flatIdx: number, el: HTMLDivElement | null) => {
    if (el) itemRefs.current.set(flatIdx, el);
    else itemRefs.current.delete(flatIdx);
  }, []);

  if (!visible || filtered.length === 0) return null;

  let flatIdx = 0;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.15 }}
        className="absolute bottom-full left-0 right-0 mb-1 z-20 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface-secondary shadow-lg"
        data-testid="slash-command-menu"
      >
        {Object.entries(grouped).map(([category, cmds]) => (
          <div key={category}>
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 bg-surface-tertiary border-b border-border">
              {CATEGORY_LABELS[category] || category}
            </div>
            {cmds.map((cmd) => {
              const idx = flatIdx++;
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={cmd.command}
                  ref={(el) => setItemRef(idx, el)}
                  className={`flex cursor-pointer items-baseline gap-2 px-3 py-2 text-left text-sm border-b border-border last:border-b-0 ${
                    isSelected ? "bg-indigo-600 text-white" : "hover:bg-surface-tertiary"
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(cmd);
                  }}
                >
                  <span className="shrink-0 font-mono text-accent">{cmd.command}</span>
                  <span className="min-w-0 text-gray-400 text-xs">{cmd.description}</span>
                </div>
              );
            })}
          </div>
        ))}
      </motion.div>
    </AnimatePresence>
  );
}
