import { useState } from "react";
import type { Session } from "@cc-pet/shared";
import { useSessionStore } from "../../lib/store/session.js";
import { ChatWindow } from "../ChatWindow.js";
import { ChatSessionList } from "./ChatSessionList.js";
import { chatTitle, isItemSession } from "./chatSessions.js";

export type ChatView = "list" | "chat";

function useActiveSession(resident: Session | null): Session | null {
  return useSessionStore((s) => {
    if (!resident) return null;
    const key = s.activeSessionKey[resident.connectionId];
    return s.sessions[resident.connectionId]?.find((x) => x.key === key) ?? null;
  });
}

function CurrentTitle({ session }: { session: Session | null }) {
  if (!session) return <span className="truncate">秋来</span>;
  return (
    <>
      {isItemSession(session) && (
        <span className="shrink-0 rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-700">事项</span>
      )}
      <span className="min-w-0 truncate">{chatTitle(session)}</span>
    </>
  );
}

interface Props {
  resident: Session | null;
  onOpen: (key: string) => void;
  onNew: () => void;
}

/** 电脑上：聊天栏顶上一条会话标题，点开是会话列表。 */
export function DesktopChatPane({ resident, onOpen, onNew }: Props) {
  const [listOpen, setListOpen] = useState(false);
  const active = useActiveSession(resident);
  if (!resident) {
    return <div className="flex h-full items-center justify-center text-sm text-text-secondary">秋来还没配置好</div>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <button
          type="button"
          aria-expanded={listOpen}
          aria-controls="assistant-session-list"
          onClick={() => setListOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-text-primary hover:bg-surface-tertiary"
        >
          <CurrentTitle session={active} />
          <span className="ml-auto shrink-0 text-xs text-text-secondary">{listOpen ? "收起" : "全部会话"}</span>
        </button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ChatWindow />
        {listOpen && (
          <div id="assistant-session-list" className="absolute inset-0 z-10 overflow-y-auto bg-surface-secondary">
            <ChatSessionList
              resident={resident}
              onOpen={(key) => {
                setListOpen(false);
                onOpen(key);
              }}
              onNew={() => {
                setListOpen(false);
                onNew();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** 手机上：先是会话列表，点进去才是对话，带返回。 */
export function MobileChatPane({
  resident,
  onOpen,
  onNew,
  view,
  onBack,
}: Props & { view: ChatView; onBack: () => void }) {
  const active = useActiveSession(resident);
  if (!resident) {
    return <div className="flex h-full items-center justify-center text-sm text-text-secondary">秋来还没配置好</div>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {view === "list" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <h2 className="px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] text-lg font-semibold text-text-primary">
            聊天
          </h2>
          <ChatSessionList resident={resident} onOpen={onOpen} onNew={onNew} />
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-secondary px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 rounded-md px-2 py-1 text-sm text-accent hover:bg-surface-tertiary"
          >
            ‹ 返回
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-text-primary">
            <CurrentTitle session={active} />
          </div>
        </div>
      )}
      {/* Kept mounted behind the list so a half-typed message survives going back. */}
      <div className={view === "chat" ? "min-h-0 flex-1 overflow-hidden" : "hidden"}>
        <ChatWindow />
      </div>
    </div>
  );
}
