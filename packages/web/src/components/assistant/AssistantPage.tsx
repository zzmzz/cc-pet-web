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
import { ThreadsContext } from "./threads.js";
import { ProgressStrip } from "./ProgressStrip.js";
import {
  createAssistantUpdateBatcher,
  onAssistantSessionUpdated,
  refreshAssistantSession,
} from "../../lib/assistantEvents.js";
import { getPlatform } from "../../lib/platform.js";
import type { AssistantDeliverable, AssistantThread } from "../../lib/assistantBoard.js";

const NO_DELIVERABLES: AssistantDeliverable[] = [];
const NO_THREADS: AssistantThread[] = [];

type Tab = "today" | "schedule" | "chat";
/** 电脑上「放大日程」的开关，刷新后保持。 */
export const BOARD_WIDE_KEY = "cc-pet-assistant-board-wide";

function readBoardWide(): boolean {
  try {
    return localStorage.getItem(BOARD_WIDE_KEY) === "1";
  } catch {
    return false;
  }
}

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
  const [boardWide, setBoardWide] = useState(readBoardWide);
  useEffect(() => {
    try {
      if (boardWide) localStorage.setItem(BOARD_WIDE_KEY, "1");
      else localStorage.removeItem(BOARD_WIDE_KEY);
    } catch {
      // Private mode and the like: the toggle still works, it just isn't remembered.
    }
  }, [boardWide]);
  const { board, error, setStatus, setDeliverableStatus, reload } = useAssistantBoard();
  const resident = useResidentChat();
  const rc = resident?.connectionId ?? null;
  const deliverables = board?.deliverables ?? NO_DELIVERABLES;
  const threads = board?.threads ?? NO_THREADS;

  // The backend wrote into a session (a reminder, a sub-session it started):
  // refresh the board for thread states and pull the session list and those chats.
  // A burst of events for one connection becomes a single refresh.
  useEffect(() => {
    const batcher = createAssistantUpdateBatcher((connectionId, sessionKeys) => {
      void reload();
      void refreshAssistantSession(getPlatform(), connectionId, sessionKeys);
    });
    const off = onAssistantSessionUpdated(batcher.push);
    return () => {
      off();
      batcher.cancel();
    };
  }, [reload]);

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

  const clearNotice = useCallback(() => setChatNotice(null), []);
  const discuss = useItemDiscussion(resident, openSession, showChat, createFailed, clearNotice);
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
      desktop={!isMobile}
      boardWide={boardWide}
      onToggleWide={isMobile ? undefined : () => setBoardWide((v) => !v)}
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
  const strip = resident && (
    <ProgressStrip
      residentKey={resident.key}
      threads={threads}
      deliverables={deliverables}
      now={now}
      onOpen={openSession}
      onDeliverableStatus={setDeliverableStatus}
    />
  );
  const loading = !groups && !error && <p className="text-xs text-text-secondary">正在加载…</p>;
  const schedule = groups && <ScheduleSections today={today} groups={groups} onStatus={setStatus} onDiscuss={onDiscuss} />;
  const todayView =
    groups && board && (
      <TodaySections
        groups={groups}
        closed={board.closedRecent}
        today={today}
        deliverables={deliverables}
        onDeliverableStatus={setDeliverableStatus}
        onStatus={setStatus}
        onDiscuss={onDiscuss}
      />
    );

  if (isMobile) {
    return (
      <ThreadsContext.Provider value={threads}>
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
              aboveMain={strip}
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
      </ThreadsContext.Provider>
    );
  }

  // Chat on the left as the wide column, the board in a narrower scrolling column on the right.
  // 「放大日程」 swaps the widths; both stay visible. The full pet sits in the board header.
  return (
    <ThreadsContext.Provider value={threads}>
      <div className="flex h-full bg-surface text-text-primary">
        {chatAlert}
        <section
          aria-label="聊天"
          className={`flex min-h-0 flex-col bg-surface-secondary ${boardWide ? "w-[400px] shrink-0" : "min-w-0 flex-1"}`}
        >
          <DesktopChatPane resident={resident} onOpen={openSession} onNew={() => void newTopic()} aboveMain={strip} />
        </section>
        <section
          aria-label="事项"
          className={`min-h-0 overflow-y-auto border-l border-border ${
            boardWide ? "min-w-0 flex-1" : "w-[480px] shrink-0 xl:w-[540px]"
          }`}
        >
          <div className={`space-y-4 p-5 ${boardWide ? "mx-auto max-w-4xl" : ""}`}>
            {header}
            {notice}
            {loading}
            {groups && board && (
              <FullBoard
                today={today}
                groups={groups}
                closed={board.closedRecent}
                deliverables={deliverables}
                onDeliverableStatus={setDeliverableStatus}
                onStatus={setStatus}
                onDiscuss={onDiscuss}
                weekLayout={boardWide ? "columns" : "rows"}
              />
            )}
          </div>
        </section>
      </div>
    </ThreadsContext.Provider>
  );
}
