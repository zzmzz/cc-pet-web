import { useEffect, useRef, useState } from "react";
import type { AssistantItem } from "../../lib/assistantBoard.js";
import type { ItemStatus } from "./useAssistantBoard.js";

interface Props {
  item: AssistantItem;
  /** Left column: time of day, a date, or nothing. */
  when?: string | null;
  /** Small amber note after the title, e.g. 已过 2 天. */
  note?: string;
  onStatus: (id: number, status: ItemStatus) => Promise<void>;
  /** Opens (or starts) a chat with 蟹哥 about this item. */
  onDiscuss?: (item: AssistantItem) => void;
}

export function ItemRow({ item, when, note, onStatus, onDiscuss }: Props) {
  // Ticked while the change is in flight; on success the row disappears, on failure it unticks.
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    // Set again on every mount: StrictMode runs cleanup once before the real mount.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const change = async (status: ItemStatus) => {
    setBusy(true);
    await onStatus(item.id, status);
    if (mounted.current) setBusy(false);
  };
  const meta = [item.detail, item.people.join("、")].filter((s) => s.length > 0).join(" · ");
  return (
    <li className="flex items-start gap-3 border-b border-border py-3 last:border-b-0">
      <input
        type="checkbox"
        aria-label={`做完了：${item.title}`}
        className="mt-1 h-4 w-4 shrink-0 accent-primary"
        checked={busy}
        disabled={busy}
        onChange={() => void change("done")}
      />
      {when !== undefined && (
        // An empty time column keeps the titles lined up on a wide screen; a phone needs the width more.
        <span
          data-testid="item-when"
          className={`w-16 shrink-0 pt-0.5 text-xs text-text-secondary ${when ? "" : "hidden md:block"}`}
        >
          {when ?? ""}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-primary">
          {item.title}
          {item.deadline && <span className="ml-2 text-xs font-normal text-red-500">截止</span>}
          {note && <span className="ml-2 text-xs font-normal text-amber-600">{note}</span>}
        </div>
        {meta && <div className="mt-0.5 text-xs text-text-secondary">{meta}</div>}
      </div>
      {onDiscuss && (
        <button
          type="button"
          onClick={() => onDiscuss(item)}
          className="shrink-0 rounded-md border border-primary/40 px-2 py-0.5 text-xs text-primary hover:bg-primary/10"
        >
          讨论
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void change("dismissed")}
        className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-text-secondary hover:bg-surface"
      >
        不用了
      </button>
    </li>
  );
}
