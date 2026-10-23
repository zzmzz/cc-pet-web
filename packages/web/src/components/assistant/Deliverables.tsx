import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getPlatform } from "../../lib/platform.js";
import {
  deliverableStatusLabel,
  deliverableTime,
  fileName,
  isTextDeliverable,
  type AssistantDeliverable,
} from "../../lib/assistantBoard.js";
import { Section } from "./Section.js";
import type { DeliverableAction } from "./useAssistantBoard.js";

type OnDeliverableStatus = (id: number, status: DeliverableAction) => Promise<void>;

export const OPEN_FAILED_MESSAGE = "没打开，稍后再试";
const COPIED_MS = 1500;

const STATUS_TONE: Record<string, string> = {
  new: "bg-amber-50 text-amber-700",
  seen: "bg-surface text-text-secondary",
  used: "bg-green-50 text-green-700",
  dismissed: "bg-surface text-text-secondary line-through",
};

function fileIcon(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "md" || ext === "txt") return "📝";
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return "📊";
  if (ext === "pdf") return "📕";
  if (ext === "pptx" || ext === "ppt") return "📽️";
  if (ext === "docx" || ext === "doc") return "📄";
  return "📎";
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL goes away.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function TextViewer({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [copied]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const copy = async () => {
    try {
      await window.navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard blocked (no permission, insecure origin): the text is still on screen to select.
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-surface shadow-xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{title}</h3>
          <button
            type="button"
            onClick={() => void copy()}
            className="shrink-0 rounded-md border border-primary/40 px-2 py-0.5 text-xs text-primary hover:bg-primary/10"
          >
            {copied ? "已复制" : "复制"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-tertiary"
          >
            关闭
          </button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-sans text-sm leading-relaxed text-text-primary">
          {text}
        </pre>
      </div>
    </div>
  );
}

/**
 * Opening a deliverable: md/txt show in a viewer on the page, anything else downloads.
 * The first open marks a new one as seen. `open` resolves false when the file did not come.
 */
export function useOpenDeliverable(onStatus: OnDeliverableStatus): {
  open: (d: AssistantDeliverable) => Promise<boolean>;
  viewer: ReactNode;
} {
  const [viewing, setViewing] = useState<{ title: string; text: string } | null>(null);
  const open = useCallback(
    async (d: AssistantDeliverable) => {
      try {
        const res = await getPlatform().fetchApiRaw(`/api/assistant/deliverables/${d.id}/file`);
        if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
        if (isTextDeliverable(d.path)) {
          setViewing({ title: d.title, text: await res.text() });
        } else {
          download(await res.blob(), fileName(d.path));
        }
      } catch {
        return false;
      }
      if (d.status === "new") void onStatus(d.id, "seen");
      return true;
    },
    [onStatus],
  );
  const close = useCallback(() => setViewing(null), []);
  const viewer = viewing && <TextViewer title={viewing.title} text={viewing.text} onClose={close} />;
  return { open, viewer };
}

function DeliverableRow({
  deliverable: d,
  today,
  onStatus,
  onOpen,
}: {
  deliverable: AssistantDeliverable;
  today: string;
  onStatus: OnDeliverableStatus;
  onOpen: (d: AssistantDeliverable) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const open = async () => {
    setFailed(false);
    if (!(await onOpen(d)) && mounted.current) setFailed(true);
  };

  const change = async (status: DeliverableAction) => {
    setBusy(true);
    await onStatus(d.id, status);
    if (mounted.current) setBusy(false);
  };

  return (
    <li className="flex items-start gap-3 border-b border-border py-3 last:border-b-0">
      <span aria-hidden className="mt-0.5 shrink-0 text-base leading-none">
        {fileIcon(d.path)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <span className="min-w-0 truncate">{d.title}</span>
          <span
            data-testid="deliverable-status"
            className={`shrink-0 rounded px-1.5 text-[11px] font-normal ${STATUS_TONE[d.status] ?? STATUS_TONE.new}`}
          >
            {deliverableStatusLabel(d.status)}
          </span>
        </div>
        {(() => {
          const text = [d.summary.trim(), deliverableTime(d.createdAt, today)].filter((s) => s.length > 0).join(" · ");
          return (
            <div
              data-testid="deliverable-summary"
              title={text}
              onClick={() => setExpanded((v) => !v)}
              className={`mt-0.5 cursor-pointer text-xs text-text-secondary ${expanded ? "break-words" : "truncate"}`}
            >
              {text}
            </div>
          );
        })()}
        {failed && <div className="mt-0.5 text-xs text-amber-600">{OPEN_FAILED_MESSAGE}</div>}
      </div>
      <button
        type="button"
        onClick={() => void open()}
        className="shrink-0 rounded-md border border-primary/40 px-2 py-0.5 text-xs text-primary hover:bg-primary/10"
      >
        打开
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void change("used")}
        className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-text-secondary hover:bg-surface"
      >
        用了
      </button>
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

/** 「蟹哥做好的」：近 3 天的成品（用了的留 24 小时，不用了的不显示）。没有就不显示。 */
export function Deliverables({
  deliverables,
  today,
  onStatus,
}: {
  deliverables: AssistantDeliverable[];
  today: string;
  onStatus: OnDeliverableStatus;
}) {
  const { open, viewer } = useOpenDeliverable(onStatus);
  if (deliverables.length === 0) return null;
  return (
    <Section title="蟹哥做好的" count={deliverables.length}>
      <ul>
        {deliverables.map((d) => (
          <DeliverableRow
            key={d.id}
            deliverable={d}
            today={today}
            onStatus={onStatus}
            onOpen={open}
          />
        ))}
      </ul>
      {viewer}
    </Section>
  );
}
