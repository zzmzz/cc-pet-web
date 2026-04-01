import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ChatMessage, Session, SessionTaskState } from "@cc-pet/shared";
import { makeChatKey } from "@cc-pet/shared";
import { useSessionStore } from "../lib/store/session.js";
import { useMessageStore } from "../lib/store/message.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { getPlatform } from "../lib/platform.js";

const EMPTY_SESSIONS: Session[] = [];
const RECENT_VISIBLE = 2;

function formatTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const oneDay = 86_400_000;
  if (diff < oneDay) {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  if (diff < oneDay * 7) {
    const days = Math.floor(diff / oneDay);
    return days === 1 ? "昨天" : `${days}天前`;
  }
  return new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** Aligns with ../cc-pet labels; accepts shared `TaskPhase` and legacy bridge strings. */
export function formatSessionPhase(phase?: string | null): string {
  if (!phase || phase === "idle") return "空闲";
  if (phase === "thinking") return "思考中";
  if (phase === "processing" || phase === "working") return "处理中";
  if (phase === "waiting_confirm" || phase === "awaiting_confirmation") return "待确认";
  if (phase === "completed") return "已完成";
  if (phase === "failed") return "失败";
  if (phase === "possibly_stuck" || phase === "stalled") return "可能卡住";
  return "空闲";
}

function formatUnread(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function sessionLabelText(s: Session): string {
  return s.label?.trim() || s.key.split(":").pop() || s.key;
}

/** Shown next to session title: last message time, not “last opened”. */
function lastMessageOrCreatedAt(
  connectionId: string,
  session: Session,
  messagesByChat: Record<string, ChatMessage[]>,
): number {
  const msgs = messagesByChat[makeChatKey(connectionId, session.key)] ?? [];
  if (msgs.length === 0) return session.createdAt;
  return Math.max(...msgs.map((m) => m.timestamp));
}

function phaseForSession(
  connectionId: string,
  sessionKey: string,
  taskStateByConnection: Record<string, Record<string, SessionTaskState>>,
): string {
  const p = taskStateByConnection[connectionId]?.[sessionKey]?.phase;
  return formatSessionPhase(p ?? "idle");
}

function latestMessageByConnection(messagesByChat: Record<string, ChatMessage[]>): Record<string, number> {
  const latest: Record<string, number> = {};
  for (const [chatKey, messages] of Object.entries(messagesByChat)) {
    if (!Array.isArray(messages) || messages.length === 0) continue;
    const sep = chatKey.indexOf("::");
    if (sep <= 0) continue;
    const connectionId = chatKey.slice(0, sep);
    const lastTs = Math.max(...messages.map((m) => m.timestamp));
    latest[connectionId] = Math.max(latest[connectionId] ?? 0, lastTs);
  }
  return latest;
}

function unreadByConnection(unreadMap: Record<string, number>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [chatKey, unread] of Object.entries(unreadMap)) {
    const sep = chatKey.indexOf("::");
    if (sep <= 0) continue;
    const connectionId = chatKey.slice(0, sep);
    totals[connectionId] = (totals[connectionId] ?? 0) + (unread ?? 0);
  }
  return totals;
}

export type SessionDropdownProps = {
  /** When true, session delete controls stay visible (for tests; JSDOM cannot emulate group-hover). */
  testShowDeleteButtons?: boolean;
  /** Desktop sidebar uses always-visible panel; mobile keeps dropdown interaction. */
  variant?: "dropdown" | "panel";
};

export function SessionDropdown(props: SessionDropdownProps = {}) {
  const { testShowDeleteButtons = false, variant = "dropdown" } = props;
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelMode = variant === "panel";

  const connections = useConnectionStore((s) => s.connections);
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const setActiveConnection = useConnectionStore((s) => s.setActiveConnection);

  const sessions = useSessionStore((s) =>
    activeConnectionId ? s.sessions[activeConnectionId] ?? EMPTY_SESSIONS : EMPTY_SESSIONS,
  );
  const activeKey = useSessionStore((s) =>
    activeConnectionId ? s.activeSessionKey[activeConnectionId] ?? "default" : "default",
  );
  const unreadMap = useSessionStore((s) => s.unread);
  const taskStateByConnection = useSessionStore((s) => s.taskStateByConnection);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const clearSessionUnread = useSessionStore((s) => s.clearSessionUnread);
  const removeSession = useSessionStore((s) => s.removeSession);
  const setSessions = useSessionStore((s) => s.setSessions);
  const messagesByChat = useMessageStore((s) => s.messagesByChat);

  useEffect(() => {
    if (panelMode || !open) return;
    function handleClick(e: globalThis.MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowAll(false);
        setConfirmDeleteId(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, panelMode]);

  useEffect(() => {
    if (!open) setConfirmDeleteId(null);
  }, [open]);

  const connectionActivity = latestMessageByConnection(messagesByChat);
  const unreadTotalsByConnection = unreadByConnection(unreadMap);
  const bridgeList = [...connections].sort((a, b) => {
    const ta = connectionActivity[a.id] ?? 0;
    const tb = connectionActivity[b.id] ?? 0;
    if (tb !== ta) return tb - ta;
    return connections.findIndex((c) => c.id === a.id) - connections.findIndex((c) => c.id === b.id);
  });

  if (!activeConnectionId || bridgeList.length === 0) {
    return <span className="text-[12px] font-semibold text-gray-300 px-2">CC Pet</span>;
  }

  const activeConnection = bridgeList.find((c) => c.id === activeConnectionId);
  const activeConnectionName = activeConnection?.name ?? activeConnectionId;
  const isConnected = activeConnection?.connected ?? false;

  const currentSession = sessions.find((s) => s.key === activeKey);
  const activeLabel = currentSession ? sessionLabelText(currentSession) : activeKey;
  const activeStatusLabel = phaseForSession(activeConnectionId, activeKey, taskStateByConnection);

  const unreadFor = (sessionKey: string): number => {
    const ck = makeChatKey(activeConnectionId, sessionKey);
    return unreadMap[ck] ?? 0;
  };

  const totalUnread = Object.values(unreadMap).reduce((sum, n) => sum + (n ?? 0), 0);
  const hasUnread = totalUnread > 0;

  const buttonLabel =
    bridgeList.length > 1
      ? `${activeConnectionName}${activeLabel ? ` · ${activeLabel}` : ""}`
      : activeLabel || activeConnectionName;

  const inactive = sessions
    .filter((s) => s.key !== activeKey)
    .sort(
      (a, b) =>
        lastMessageOrCreatedAt(activeConnectionId, b, messagesByChat) -
        lastMessageOrCreatedAt(activeConnectionId, a, messagesByChat),
    );

  const recentInactive = showAll ? inactive : inactive.slice(0, RECENT_VISIBLE);
  const hiddenCount = inactive.length - RECENT_VISIBLE;

  const otherConnections = bridgeList.filter((b) => b.id !== activeConnectionId);

  const switchSession = (key: string) => {
    if (!activeConnectionId) return;
    setActiveSession(activeConnectionId, key);
    clearSessionUnread(activeConnectionId, key);
    setOpen(false);
    setShowAll(false);
    setConfirmDeleteId(null);
  };

  const handleSwitchConnection = (connId: string) => {
    setOpen(false);
    setShowAll(false);
    setConfirmDeleteId(null);
    setActiveConnection(connId);
  };

  const handleDeleteClick = (e: ReactMouseEvent, sessionKey: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (!activeConnectionId) return;
    if (confirmDeleteId === sessionKey) {
      void getPlatform()
        .fetchApi(`/api/sessions/${encodeURIComponent(activeConnectionId)}/${encodeURIComponent(sessionKey)}`, {
          method: "DELETE",
        })
        .catch((err) => console.error("delete session failed:", err));
      removeSession(activeConnectionId, sessionKey);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(sessionKey);
    }
  };

  const createSession = async () => {
    if (!activeConnectionId) return;
    const key = `session-${Date.now()}`;
    try {
      await getPlatform().fetchApi("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ connectionId: activeConnectionId, key }),
      });
      const list = useSessionStore.getState().sessions[activeConnectionId] ?? [];
      const now = Date.now();
      setSessions(activeConnectionId, [
        ...list,
        { key, connectionId: activeConnectionId, createdAt: now, lastActiveAt: now },
      ]);
      setActiveSession(activeConnectionId, key);
      setOpen(false);
      setShowAll(false);
      setConfirmDeleteId(null);
    } catch (e) {
      console.error("create session failed:", e);
    }
  };

  if (sessions.length === 0 && bridgeList.length <= 1) {
    return <span className="text-[12px] font-semibold text-gray-300 px-2">CC Pet</span>;
  }

  function DeleteBtn({ sid, className }: { sid: string; className?: string }) {
    const confirming = confirmDeleteId === sid;
    const showGrip = testShowDeleteButtons
      ? "flex w-4 h-4 hover:bg-red-950/40 text-red-400 hover:text-red-300"
      : `hidden ${className ?? ""} w-4 h-4 hover:bg-red-950/40 text-red-400 hover:text-red-300`;
    return (
      <button
        type="button"
        onMouseDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
        onClick={(e) => handleDeleteClick(e, sid)}
        className={`items-center justify-center rounded flex-shrink-0 transition-colors ${
          confirming ? "flex w-auto px-1 bg-red-950/60 text-red-300 text-[9px]" : showGrip
        }`}
        title={confirming ? "再次点击确认删除" : "删除会话"}
      >
        {confirming ? (
          <span className="leading-none whitespace-nowrap">确认?</span>
        ) : (
          <span className="text-[10px] leading-none">✕</span>
        )}
      </button>
    );
  }

  const panel = (
    <div
      className={
        panelMode
          ? "w-full bg-surface-tertiary/50 border border-border rounded-xl overflow-hidden"
          : "absolute top-full left-0 mt-1 w-60 bg-surface-secondary border border-border rounded-xl shadow-lg z-50 overflow-hidden"
      }
    >
          {bridgeList.length > 1 && (
            <>
              <div className="px-3 pt-2.5 pb-1">
                <p className="text-xs font-semibold text-gray-700 mb-1">连接</p>
                {bridgeList.map((conn) => (
                  <button
                    key={conn.id}
                    type="button"
                    onClick={() => {
                      if (conn.id !== activeConnectionId) {
                        handleSwitchConnection(conn.id);
                      }
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors text-left ${
                      conn.id === activeConnectionId
                        ? "bg-accent/10 border border-accent/20 text-accent"
                        : "hover:bg-surface-tertiary text-gray-800"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${conn.connected ? "bg-green-500" : "bg-red-400"}`}
                    />
                    <span
                      className={`text-[13px] truncate flex-1 ${
                        conn.id === activeConnectionId ? "text-accent font-medium" : "text-gray-800"
                      }`}
                    >
                      {conn.name}
                    </span>
                    {(unreadTotalsByConnection[conn.id] ?? 0) > 0 && (
                      <span className="inline-flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-semibold leading-none flex-shrink-0">
                        {formatUnread(unreadTotalsByConnection[conn.id] ?? 0)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="border-t border-border mx-2" />
            </>
          )}

          {sessions.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1">
                <p className="text-xs font-semibold text-gray-700 mb-1">当前会话</p>
                <div className="flex items-center gap-2 px-2 py-1.5 bg-accent/10 rounded-lg group/active border border-accent/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                  <span className="text-[13px] text-accent font-medium truncate flex-1">{activeLabel}</span>
                  <span className="text-xs text-accent/90 flex-shrink-0">{activeStatusLabel}</span>
                  {unreadFor(activeKey) > 0 && (
                    <span className="inline-flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-semibold leading-none flex-shrink-0">
                      {formatUnread(unreadFor(activeKey))}
                    </span>
                  )}
                  {currentSession && confirmDeleteId !== activeKey && (
                    <span className="text-xs text-gray-600 flex-shrink-0 group-hover/active:hidden">
                      {formatTime(lastMessageOrCreatedAt(activeConnectionId, currentSession, messagesByChat))}
                    </span>
                  )}
                  {sessions.length > 1 && <DeleteBtn sid={activeKey} className="group-hover/active:flex" />}
                </div>
              </div>

              {inactive.length > 0 && (
                <div className="px-3 pb-1">
                  <p className="text-xs font-semibold text-gray-700 mb-1">最近会话</p>
                  {recentInactive.map((sess) => (
                    <div
                      key={sess.key}
                      role="button"
                      tabIndex={0}
                      onClick={() => switchSession(sess.key)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          switchSession(sess.key);
                        }
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-tertiary transition-colors text-left group/item cursor-pointer"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-500 flex-shrink-0" />
                      <span className="text-[13px] text-gray-800 truncate flex-1">{sessionLabelText(sess)}</span>
                      <span className="text-xs text-gray-600 flex-shrink-0">
                        {phaseForSession(activeConnectionId, sess.key, taskStateByConnection)}
                      </span>
                      {unreadFor(sess.key) > 0 && (
                        <span className="inline-flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-semibold leading-none flex-shrink-0">
                          {formatUnread(unreadFor(sess.key))}
                        </span>
                      )}
                      {confirmDeleteId !== sess.key && (
                        <span className="text-xs text-gray-600 flex-shrink-0 group-hover/item:hidden">
                          {formatTime(lastMessageOrCreatedAt(activeConnectionId, sess, messagesByChat))}
                        </span>
                      )}
                      <DeleteBtn sid={sess.key} className="group-hover/item:flex" />
                    </div>
                  ))}

                  {!showAll && hiddenCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowAll(true)}
                      className="w-full flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-surface-tertiary transition-colors text-accent text-[10px]"
                    >
                      <span>▶</span>
                      <span>显示 {hiddenCount} 个更旧的会话</span>
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          <div className="border-t border-border mx-2" />
          <div className="px-3 py-1.5">
            <button
              type="button"
              onClick={() => void createSession()}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-accent/10 transition-colors text-accent text-[11px] font-medium"
            >
              <span>＋</span>
              <span>新建会话</span>
            </button>
          </div>
        </div>
  );

  if (panelMode) {
    return (
      <div ref={ref} className="w-full min-w-0">
        {panel}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative flex items-center min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-surface-tertiary transition-colors min-w-0 max-w-[220px]"
        title={buttonLabel}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isConnected ? "bg-green-500" : "bg-red-400"}`}
        />
        <span className="text-sm font-semibold text-gray-800 truncate">{buttonLabel}</span>
        <span className="text-xs text-gray-600 flex-shrink-0">{activeStatusLabel}</span>
        {hasUnread && (
          <span className="inline-flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-semibold leading-none flex-shrink-0">
            {formatUnread(totalUnread)}
          </span>
        )}
        <span className="text-xs text-gray-600 flex-shrink-0">{open ? "▲" : "▼"}</span>
      </button>

      {open && panel}
    </div>
  );
}
