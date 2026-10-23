import { useCallback, useState, type ReactNode } from "react";
import { groupBoard, localDate } from "../../lib/assistantBoard.js";
import { useUIStore } from "../../lib/store/ui.js";
import { useIsMobileTracker } from "../../lib/useIsMobileTracker.js";
import { createSession, markSessionRead } from "../../lib/sessionActions.js";
import { PetFull } from "../Pet.js";
import { useConnectionStore } from "../../lib/store/connection.js";
import { useSessionStore } from "../../lib/store/session.js";
import { BoardHeader } from "./BoardHeader.js";
import { DesktopChatPane, MobileChatPane, type ChatView } from "./ChatPane.js";
import { ScheduleSections, TodaySections } from "./BoardSections.js";
import { useAssistantBoard } from "./useAssistantBoard.js";
import { useResidentChat } from "./useResidentChat.js";

type Tab = "today" | "schedule" | "chat";
const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "今天" },
  { id: "schedule", label: "日程" },
  { id: "chat", label: "聊天" },
];

export function AssistantPage() {
  useIsMobileTracker();
  const isMobile = useUIStore((s) => s.isMobile);
  const [tab, setTab] = useState<Tab>("today");
  const [chatView, setChatView] = useState<ChatView>("list");
  const { board, error, setStatus } = useAssistantBoard();
  const resident = useResidentChat();
  const rc = resident?.connectionId ?? null;

  const openSession = useCallback(
    (key: string) => {
      if (!rc) return;
      useConnectionStore.getState().setActiveConnection(rc);
      useSessionStore.getState().setActiveSession(rc, key);
      markSessionRead(rc, key);
      setChatView("chat");
    },
    [rc],
  );

  const newTopic = useCallback(async () => {
    if (!rc) return;
    useConnectionStore.getState().setActiveConnection(rc);
    if (await createSession(rc, `session-${Date.now()}`)) setChatView("chat");
  }, [rc]);

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
          <div
            role="tabpanel"
            id={`assistant-panel-${tab}`}
            aria-labelledby={`assistant-tab-${tab}`}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
          >
            {header}
            {notice}
            {loading}
            {tab === "today" ? todayView() : schedule}
          </div>
        )}
        {/* Kept mounted while hidden so a half-typed message survives a tab switch. */}
        <div
          role="tabpanel"
          id="assistant-panel-chat"
          aria-labelledby="assistant-tab-chat"
          hidden={tab !== "chat"}
          className={tab === "chat" ? "min-h-0 flex-1 overflow-hidden" : "hidden"}
        >
          <MobileChatPane
            resident={resident}
            view={chatView}
            onBack={() => setChatView("list")}
            onOpen={openSession}
            onNew={() => void newTopic()}
          />
        </div>
        <nav aria-label="页面" className="shrink-0 border-t border-border bg-surface-secondary pb-[env(safe-area-inset-bottom)]">
          <div role="tablist" aria-label="秋来" className="grid grid-cols-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`assistant-tab-${t.id}`}
              aria-controls={`assistant-panel-${t.id}`}
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`py-2.5 text-sm ${tab === t.id ? "font-semibold text-primary" : "text-text-secondary"}`}
            >
              {t.label}
            </button>
          ))}
          </div>
        </nav>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-surface text-text-primary">
      {/* The pet gets its own column so it never sits on top of the board. */}
      <div className="flex w-36 shrink-0 flex-col justify-end p-4">
        <PetFull />
      </div>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-6">
          {header}
          {notice}
          {loading}
          {todayView(schedule)}
        </div>
      </main>
      <aside className="flex w-[400px] shrink-0 flex-col border-l border-border bg-surface-secondary">
        <DesktopChatPane resident={resident} onOpen={openSession} onNew={() => void newTopic()} />
      </aside>
    </div>
  );
}
