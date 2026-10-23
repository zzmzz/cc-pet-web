import { createContext, useContext } from "react";
import { threadForItem, type AssistantThread, type ThreadStatus as Status } from "../../lib/assistantBoard.js";

const NO_THREADS: AssistantThread[] = [];

/** Thread states from the board, read by the session list and the item rows. */
export const ThreadsContext = createContext<AssistantThread[]>(NO_THREADS);

export function useSessionThread(sessionKey: string): AssistantThread | undefined {
  return useContext(ThreadsContext).find((t) => t.sessionKey === sessionKey);
}

export function useItemThread(itemId: number): AssistantThread | undefined {
  return threadForItem(useContext(ThreadsContext), itemId);
}

const LOOK: Record<Status, { dot: string; text: string; label: string }> = {
  running: { dot: "bg-amber-400", text: "text-amber-700", label: "在做" },
  done: { dot: "bg-green-500", text: "text-green-700", label: "做好了" },
  stuck: { dot: "bg-red-500", text: "text-red-600", label: "卡住了" },
};

/** 黄点「在做」带进度、绿点「做好了」、红点「卡住了」。 */
export function ThreadStatus({ thread, className = "" }: { thread: AssistantThread | undefined; className?: string }) {
  const look = thread ? LOOK[thread.status as Status] : undefined;
  if (!thread || !look) return null;
  const progress = thread.status === "running" ? thread.progress.trim() : "";
  return (
    <span data-testid="thread-status" className={`flex min-w-0 items-center gap-1 text-xs ${look.text} ${className}`}>
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${look.dot}`} />
      <span className="shrink-0">{look.label}</span>
      {progress && <span className="min-w-0 truncate text-text-secondary">· {progress}</span>}
    </span>
  );
}
