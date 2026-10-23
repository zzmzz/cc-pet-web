import { useEffect, useRef } from "react";
import type { Session } from "@cc-pet/shared";
import { markSessionRead } from "../../lib/sessionActions.js";
import { useConnectionStore } from "../../lib/store/connection.js";
import { useSessionStore } from "../../lib/store/session.js";

/**
 * Finds the resident session (same lookup as SessionDropdown). The chat opens
 * on it once when the page first sees it; after that Yu picks the session and
 * it stays put. Returns null while there is none.
 */
export function useResidentChat(): Session | null {
  const resident = useSessionStore(
    (s) => Object.values(s.sessions).flat().find((x) => x.isResident) ?? null,
  );
  const rc = resident?.connectionId ?? null;
  const rk = resident?.key ?? null;
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const pinned = useRef(false);

  useEffect(() => {
    if (!rc || !rk || pinned.current) return;
    pinned.current = true;
    useConnectionStore.getState().setActiveConnection(rc);
    useSessionStore.getState().setActiveSession(rc, rk);
    markSessionRead(rc, rk);
  }, [rc, rk]);

  // The session list only covers the resident's connection, so keep the chat on it
  // if something else (a manifest from another bridge) moves it away.
  useEffect(() => {
    if (rc && pinned.current && activeConnectionId !== rc) {
      useConnectionStore.getState().setActiveConnection(rc);
    }
  }, [rc, activeConnectionId]);

  return resident;
}
