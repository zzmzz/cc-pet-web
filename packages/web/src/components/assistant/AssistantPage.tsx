import { useCallback, useEffect, useRef, useState } from "react";
import { groupBoard, localDate, type AssistantItem } from "../../lib/assistantBoard.js";
import { useUIStore } from "../../lib/store/ui.js";
import { useIsMobileTracker } from "../../lib/useIsMobileTracker.js";
import { createSession, markSessionRead } from "../../lib/sessionActions.js";
import { useConnectionStore } from "../../lib/store/connection.js";
import { useSessionStore } from "../../lib/store/session.js";
import { BoardHeader } from "./BoardHeader.js";
import { DesktopChatPane, MobileChatPane, type ChatView } from "./ChatPane.js";
import { FullBoard, ScheduleSections, TodaySections } from "./BoardSections.js";
import { useAssistantBoard } from "./useAssistantBoard.js";
import { useItemDiscussion } from "./useItemDiscussion.js";
import { useResidentChat } from "./useResidentChat.js";

type Tab = "today" | "schedule" | "chat";
const CREATE_FAILED_MESSAGE = "没建成，稍后再试";
const NOTICE_MS = 5000;

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

  const showChat = useCallback(() => {
    setTab("chat");
    setChatView("chat");
  }, []);
  // A session the server did not confirm: say so briefly, nothing else happens.
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const createFailed = useCallback(() => setChatNotice(CREATE_FAILED_MESSAGE), []);
  useEffect(() => {
    if (!chatNotice) return;
    const t = setTimeout(() => setChatNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [chatNotice]);

  const discuss = useItemDiscussion(resident, openSession, showChat, createFailed);
  const onDiscuss = resident ? (item: AssistantItem) => void discuss(item) : undefined;

  // A second click while the first one is still waiting on the server is ignored.
  const creatingTopic = useRef(false);
  const newTopic = useCallback(async () => {
    if (!rc || creatingTopic.current) return;
    creatingTopic.current = true;
    try {
      useConnectionStore.getState().setActiveConnection(rc);
      if (await createSession(rc, `session-${Date.now()}`)) {
        setChatNotice(null);
        setChatView("chat");
      } else {
        createFailed();
      }
    } finally {
      creatingTopic.current = false;
    }
  }, [rc, createFailed]);

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
  const chatAlert = chatNotice && (
    <p
      role="alert"
      className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 shadow"
    >
      {chatNotice}
    </p>
  );
  const loading = !groups && !error && <p className="text-xs text-text-secondary">正在加载…</p>;
  const schedule = groups && <ScheduleSections today={today} groups={groups} onStatus={setStatus} onDiscuss={onDiscuss} />;
  const todayView =
    groups && board && (
      <TodaySections groups={groups} closed={board.closedRecent} onStatus={setStatus} onDiscuss={onDiscuss} />
    );
  const fullBoard =
    groups && board && (
      <FullBoard
        today={today}
        groups={groups}
        closed={board.closedRecent}
        onStatus={setStatus}
        onDiscuss={onDiscuss}
      />
    );

  if (isMobile) {
    return (
      <div className="flex h-full flex-col bg-surface text-text-primary">
        {chatAlert}
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
            {tab === "today" ? todayView : schedule}
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
          <div role="tablist" aria-label="蟹哥" className="grid grid-cols-3">
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

  // Chat on the left as the main area; the board is a scrolling column on the right.
  // The pet sits in the board header (PetMini), so it never covers anything.
  return (
    <div className="flex h-full bg-surface text-text-primary">
      {chatAlert}
      <main aria-label="聊天" className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-secondary">
        <DesktopChatPane resident={resident} onOpen={openSession} onNew={() => void newTopic()} />
      </main>
      <aside aria-label="事项" className="min-h-0 w-[480px] shrink-0 overflow-y-auto border-l border-border xl:w-[540px]">
        <div className="space-y-4 p-5">
          {header}
          {notice}
          {loading}
          {fullBoard}
        </div>
      </aside>
    </div>
  );
}
