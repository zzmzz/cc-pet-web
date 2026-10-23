import { useEffect } from "react";
import type { Session } from "@cc-pet/shared";
import { getPlatform } from "../../lib/platform.js";
import { useConnectionStore } from "../../lib/store/connection.js";
import { useSessionStore } from "../../lib/store/session.js";

/**
 * Finds the resident session (same lookup as SessionDropdown) and keeps the
 * chat pinned to it. Returns null while there is none.
 */
export function useResidentChat(): Session | null {
  const resident = useSessionStore(
    (s) => Object.values(s.sessions).flat().find((x) => x.isResident) ?? null,
  );
  const rc = resident?.connectionId ?? null;
  const rk = resident?.key ?? null;
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const activeKey = useSessionStore((s) => (rc ? s.activeSessionKey[rc] : undefined));

  // Opening the resident session counts as reading it, once per session.
  useEffect(() => {
    if (!rc || !rk) return;
    useSessionStore.getState().clearSessionUnread(rc, rk);
    void getPlatform()
      .fetchApi(`/api/sessions/${encodeURIComponent(rc)}/${encodeURIComponent(rk)}/read`, { method: "POST" })
      .catch((e) => console.error("mark resident read failed:", e));
  }, [rc, rk]);

  // Re-pin whenever something else (a manifest, a new-session event) moves the chat away.
  useEffect(() => {
    if (!rc || !rk) return;
    if (activeConnectionId !== rc) useConnectionStore.getState().setActiveConnection(rc);
    if (activeKey !== rk) useSessionStore.getState().setActiveSession(rc, rk);
  }, [rc, rk, activeConnectionId, activeKey]);

  return resident;
}
