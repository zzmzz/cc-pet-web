import { makeChatKey, type Session } from "@cc-pet/shared";
import { formatSessionTime, formatUnread, sessionLastActivity } from "../../lib/sessionActions.js";
import { useMessageStore } from "../../lib/store/message.js";
import { useSessionStore } from "../../lib/store/session.js";
import { chatTitle, isItemSession } from "./chatSessions.js";
import { ThreadStatus, useSessionThread } from "./threads.js";

const EMPTY: Session[] = [];

function lastText(content: string | undefined): string {
  return (content ?? "").replace(/\s+/g, " ").trim();
}

function Row({
  session,
  active,
  onOpen,
}: {
  session: Session;
  active: boolean;
  onOpen: (key: string) => void;
}) {
  const cid = session.connectionId;
  const chatKey = makeChatKey(cid, session.key);
  const unread = useSessionStore((s) => s.unread[chatKey] ?? 0);
  const messagesByChat = useMessageStore((s) => s.messagesByChat);
  const msgs = messagesByChat[chatKey];
  const preview = msgs && msgs.length > 0 ? lastText(msgs[msgs.length - 1].content) : "";
  const title = chatTitle(session);
  const item = isItemSession(session);
  const thread = useSessionThread(session.key);

  return (
    <li>
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={() => onOpen(session.key)}
        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
          active ? "bg-accent/10" : "hover:bg-surface-tertiary"
        }`}
      >
        <span
          aria-hidden
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
            session.isResident ? "bg-primary text-white" : "bg-surface-tertiary text-primary"
          }`}
        >
          {session.isResident ? "蟹" : title.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {item && (
              <span className="shrink-0 rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-700">事项</span>
            )}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{title}</span>
            <span className="shrink-0 text-[11px] text-text-secondary">
              {formatSessionTime(sessionLastActivity(cid, session, messagesByChat))}
            </span>
          </span>
          <ThreadStatus thread={thread} className="mt-0.5" />
          <span className="mt-0.5 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{preview}</span>
            {unread > 0 && (
              <span
                aria-label={`${unread} 条未读`}
                className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-none text-white"
              >
                {formatUnread(unread)}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * 蟹哥的会话列表：主会话固定在最上面，然后是「新话题」，
 * 再往下是同一个连接里的其他会话，最近说过话的在前。
 */
export function ChatSessionList({
  resident,
  onOpen,
  onNew,
}: {
  resident: Session;
  onOpen: (key: string) => void;
  onNew: () => void;
}) {
  const cid = resident.connectionId;
  const sessions = useSessionStore((s) => s.sessions[cid] ?? EMPTY);
  const activeKey = useSessionStore((s) => s.activeSessionKey[cid]);
  const messagesByChat = useMessageStore((s) => s.messagesByChat);
  const others = sessions
    .filter((s) => !s.isResident)
    .sort((a, b) => sessionLastActivity(cid, b, messagesByChat) - sessionLastActivity(cid, a, messagesByChat));

  return (
    <ul aria-label="会话" className="divide-y divide-border">
      <Row session={resident} active={activeKey === resident.key} onOpen={onOpen} />
      <li>
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm font-medium text-accent hover:bg-accent/10"
        >
          <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-accent/50">
            ＋
          </span>
          新话题
        </button>
      </li>
      {others.map((s) => (
        <Row key={s.key} session={s} active={activeKey === s.key} onOpen={onOpen} />
      ))}
    </ul>
  );
}
