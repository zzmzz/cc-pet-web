import { useState } from "react";
import type { Session } from "@cc-pet/shared";
import { useSessionStore } from "../lib/store/session.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { getPlatform } from "../lib/platform.js";

export function SessionDropdown() {
  const [open, setOpen] = useState(false);
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const sessions = useSessionStore((s) => activeConnectionId ? s.sessions[activeConnectionId] ?? [] : []);
  const activeKey = useSessionStore((s) => activeConnectionId ? s.activeSessionKey[activeConnectionId] ?? "default" : "default");
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const switchSession = (key: string) => {
    if (!activeConnectionId) return;
    setActiveSession(activeConnectionId, key);
    setOpen(false);
  };

  const createSession = async () => {
    if (!activeConnectionId) return;
    const key = `session-${Date.now()}`;
    await getPlatform().fetchApi("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ connectionId: activeConnectionId, key }),
    });
    setActiveSession(activeConnectionId, key);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button className="text-sm text-gray-300 hover:text-white" onClick={() => setOpen(!open)}>
        📋 {activeKey}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-surface-secondary border border-border rounded-lg shadow-lg z-50 min-w-48">
          {sessions.map((s: Session) => (
            <button
              key={s.key}
              className={`block w-full text-left px-3 py-2 text-sm hover:bg-surface-tertiary ${s.key === activeKey ? "text-accent" : "text-gray-300"}`}
              onClick={() => switchSession(s.key)}
            >
              {s.label || s.key}
            </button>
          ))}
          <button className="block w-full text-left px-3 py-2 text-sm text-accent hover:bg-surface-tertiary border-t border-border"
            onClick={createSession}>
            + 新建会话
          </button>
        </div>
      )}
    </div>
  );
}
