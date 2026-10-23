import { useEffect, useRef, useState } from "react";
import type { AssistantItem } from "../../lib/assistantBoard.js";
import type { ItemStatus } from "./useAssistantBoard.js";

function reasonText(item: AssistantItem): string {
  if (item.closedReason) return item.closedReason;
  return item.status === "dismissed" ? "你点了不用了" : "做完了";
}

function ClosedRow({
  item,
  onStatus,
}: {
  item: AssistantItem;
  onStatus: (id: number, status: ItemStatus) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const undo = async () => {
    setBusy(true);
    await onStatus(item.id, "open");
    if (mounted.current) setBusy(false);
  };
  return (
    <li className="flex items-start gap-3 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-text-secondary line-through">{item.title}</div>
        <div className="mt-0.5 text-xs text-text-secondary">{reasonText(item)}</div>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void undo()}
        className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-primary hover:bg-surface"
      >
        撤销
      </button>
    </li>
  );
}

export function ClosedRecent({
  items,
  onStatus,
}: {
  items: AssistantItem[];
  onStatus: (id: number, status: ItemStatus) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <section className="rounded-xl border border-border bg-surface-secondary px-4 py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 text-left text-sm font-semibold text-text-secondary"
      >
        <span>{open ? "▾" : "▸"}</span>
        最近 24 小时结案
        <span className="rounded-full bg-surface px-2 text-xs font-normal">{items.length}</span>
      </button>
      {open && (
        <ul className="mt-2">
          {items.map((item) => (
            <ClosedRow key={item.id} item={item} onStatus={onStatus} />
          ))}
        </ul>
      )}
    </section>
  );
}
