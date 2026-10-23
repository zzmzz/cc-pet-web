import { useEffect, useRef, useState } from "react";
import {
  elapsedLabel,
  progressRows,
  type AssistantDeliverable,
  type AssistantThread,
} from "../../lib/assistantBoard.js";
import { OPEN_FAILED_MESSAGE, useOpenDeliverable } from "./Deliverables.js";
import type { DeliverableAction } from "./useAssistantBoard.js";

/** 折叠状态，刷新后保持。 */
export const PROGRESS_FOLDED_KEY = "cc-pet-assistant-progress-folded";
/** 超过这么多行时，先只列没做完的。 */
const COMPACT_OVER = 3;

const LOOK: Record<string, { dot: string; text: string; label: string }> = {
  running: { dot: "bg-amber-400", text: "text-amber-700", label: "在做" },
  done: { dot: "bg-green-500", text: "text-green-700", label: "做好了" },
  stuck: { dot: "bg-red-500", text: "text-red-600", label: "卡住了" },
};

function readFolded(): boolean {
  try {
    return localStorage.getItem(PROGRESS_FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

/** 在做的、卡住的：开始到现在多久；做好的：前后用了多久。 */
function timeText(t: AssistantThread, now: Date): string {
  const start = t.createdAt ?? t.updatedAt;
  if (t.status !== "done") return elapsedLabel(start, now);
  const took = elapsedLabel(start, new Date(t.updatedAt.replace(" ", "T")));
  return took === "刚开始" ? "做好了" : `用了 ${took}`;
}

function Row({
  thread: t,
  deliverable,
  now,
  onOpen,
  onOpenFile,
}: {
  thread: AssistantThread;
  deliverable: AssistantDeliverable | undefined;
  now: Date;
  onOpen: (key: string) => void;
  onOpenFile: (d: AssistantDeliverable) => Promise<boolean>;
}) {
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const look = LOOK[t.status] ?? LOOK.running;
  const progress = t.progress.trim();
  const time = timeText(t, now);
  const openFile = async (d: AssistantDeliverable) => {
    setFailed(false);
    if (!(await onOpenFile(d)) && mounted.current) setFailed(true);
  };
  return (
    <li className="flex items-center gap-2 px-3 py-1.5">
      <button
        type="button"
        onClick={() => onOpen(t.sessionKey)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-xs hover:bg-surface-tertiary"
      >
        <span className={`flex shrink-0 items-center gap-1 ${look.text}`}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${look.dot}`} />
          {look.label}
        </span>
        <span className="min-w-0 max-w-[45%] shrink-0 truncate font-medium text-text-primary">{t.title}</span>
        {progress && <span className="min-w-0 flex-1 truncate text-text-secondary">{progress}</span>}
        <span className="ml-auto shrink-0 text-text-secondary">{time}</span>
      </button>
      {deliverable && (
        <button
          type="button"
          onClick={() => void openFile(deliverable)}
          className="shrink-0 rounded-md border border-primary/40 px-2 py-0.5 text-xs text-primary hover:bg-primary/10"
        >
          打开成品
        </button>
      )}
      {failed && <span className="shrink-0 text-xs text-amber-600">{OPEN_FAILED_MESSAGE}</span>}
    </li>
  );
}

/**
 * 主会话对话上方的进度栏：主会话派出去的子会话，没做完的和 24 小时内做好的。
 * 点一行进那个子会话；有成品的可以直接打开。
 */
export function ProgressStrip({
  residentKey,
  threads,
  deliverables,
  now,
  onOpen,
  onDeliverableStatus,
}: {
  residentKey: string;
  threads: AssistantThread[];
  deliverables: AssistantDeliverable[];
  now: Date;
  onOpen: (key: string) => void;
  onDeliverableStatus: (id: number, status: DeliverableAction) => Promise<void>;
}) {
  const [folded, setFolded] = useState(readFolded);
  const [showAll, setShowAll] = useState(false);
  const { open, viewer } = useOpenDeliverable(onDeliverableStatus);
  useEffect(() => {
    try {
      if (folded) localStorage.setItem(PROGRESS_FOLDED_KEY, "1");
      else localStorage.removeItem(PROGRESS_FOLDED_KEY);
    } catch {
      // Private mode and the like: folding still works, it just isn't remembered.
    }
  }, [folded]);

  const rows = progressRows(threads, residentKey, now);
  if (rows.length === 0) return viewer || null;

  const unfinished = rows.filter((t) => t.status !== "done");
  const running = rows.filter((t) => t.status === "running").length;
  // compact mode only helps when something is still running; otherwise show everything
  const compact = rows.length > COMPACT_OVER && !showAll && unfinished.length > 0;
  const shown = compact ? unfinished : rows;
  const hiddenDone = rows.length - shown.length;
  // deliverables come newest first, so find() picks the latest file of each session.
  const fileFor = (key: string) => deliverables.find((d) => d.sessionKey === key);
  const summary = [
    running > 0 ? `${running} 个在做` : null,
    unfinished.length - running > 0 ? `${unfinished.length - running} 个卡住了` : null,
    rows.length - unfinished.length > 0 ? `${rows.length - unfinished.length} 个做好了` : null,
  ]
    .filter(Boolean)
    .join("，");

  return (
    <section aria-label="派出去的活" className="shrink-0 border-b border-border bg-surface">
      <button
        type="button"
        aria-expanded={!folded}
        aria-controls="assistant-progress-rows"
        onClick={() => setFolded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-tertiary"
      >
        <span className="font-medium text-text-primary">派出去的活</span>
        <span className="min-w-0 truncate">{summary}</span>
        <span className="ml-auto shrink-0">{folded ? "展开" : "收起"}</span>
      </button>
      <div id="assistant-progress-rows" hidden={folded} className="max-h-48 overflow-y-auto pb-1">
        {!folded && (
          <>
            <ul>
              {shown.map((t) => (
                <Row
                  key={t.sessionKey}
                  thread={t}
                  deliverable={fileFor(t.sessionKey)}
                  now={now}
                  onOpen={onOpen}
                  onOpenFile={open}
                />
              ))}
            </ul>
            {compact && hiddenDone > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="px-3 py-1 text-xs text-accent hover:underline"
              >
                还有 {hiddenDone} 个已完成
              </button>
            )}
          </>
        )}
      </div>
      {viewer}
    </section>
  );
}
