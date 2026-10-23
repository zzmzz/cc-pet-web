import { useState, type ReactNode } from "react";
import { groupBoard, localDate } from "../../lib/assistantBoard.js";
import { useUIStore } from "../../lib/store/ui.js";
import { useIsMobileTracker } from "../../lib/useIsMobileTracker.js";
import { ChatWindow } from "../ChatWindow.js";
import { BoardHeader } from "./BoardHeader.js";
import { ScheduleSections, TodaySections } from "./BoardSections.js";
import { useAssistantBoard } from "./useAssistantBoard.js";
import { useResidentChat } from "./useResidentChat.js";

type Tab = "today" | "schedule" | "chat";
const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "今天" },
  { id: "schedule", label: "日程" },
  { id: "chat", label: "聊天" },
];

function ChatPane() {
  const resident = useResidentChat();
  if (!resident) {
    return <div className="flex h-full items-center justify-center text-sm text-text-secondary">秋来还没配置好</div>;
  }
  return <ChatWindow />;
}

export function AssistantPage() {
  useIsMobileTracker();
  const isMobile = useUIStore((s) => s.isMobile);
  const [tab, setTab] = useState<Tab>("today");
  const { board, error, setStatus } = useAssistantBoard();

  const now = new Date();
  const today = localDate(now);
  const groups = board ? groupBoard(board.items, today) : null;

  const header = (
    <BoardHeader
      now={now}
      todayCount={groups ? groups.today.length + groups.overdue.length : 0}
      plannedAt={board?.plannedAt ?? null}
    />
  );
  const notice = error && (
    <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
      {error}
    </p>
  );
  const loading = !groups && !error && <p className="text-xs text-text-secondary">正在加载…</p>;
  const schedule = groups && <ScheduleSections today={today} groups={groups} onStatus={setStatus} />;
  const todayView = (afterToday?: ReactNode) =>
    groups &&
    board && (
      <TodaySections groups={groups} closed={board.closedRecent} onStatus={setStatus} afterToday={afterToday} />
    );

  if (isMobile) {
    return (
      <div className="flex h-full flex-col bg-surface text-text-primary">
        {tab !== "chat" && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            {header}
            {notice}
            {loading}
            {tab === "today" ? todayView() : schedule}
          </div>
        )}
        {/* Kept mounted while hidden so a half-typed message survives a tab switch. */}
        <div className={tab === "chat" ? "min-h-0 flex-1 overflow-hidden" : "hidden"}>
          <ChatPane />
        </div>
        <nav
          role="tablist"
          aria-label="秋来"
          className="grid shrink-0 grid-cols-3 border-t border-border bg-surface-secondary pb-[env(safe-area-inset-bottom)]"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`py-2.5 text-sm ${tab === t.id ? "font-semibold text-primary" : "text-text-secondary"}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-surface text-text-primary">
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-6">
          {header}
          {notice}
          {loading}
          {todayView(schedule)}
        </div>
      </main>
      <aside className="flex w-[400px] shrink-0 flex-col border-l border-border bg-surface-secondary">
        <ChatPane />
      </aside>
    </div>
  );
}
