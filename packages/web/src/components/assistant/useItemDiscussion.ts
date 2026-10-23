import { useCallback, useRef } from "react";
import type { Session } from "@cc-pet/shared";
import { discussionPrompt, type AssistantItem } from "../../lib/assistantBoard.js";
import { createSession, sendTextMessage } from "../../lib/sessionActions.js";
import { useConnectionStore } from "../../lib/store/connection.js";
import { useSessionStore } from "../../lib/store/session.js";
import { ITEM_SESSION_PREFIX } from "./chatSessions.js";

/**
 * 「讨论」：每件事一个固定的会话 `item-<id>`。已经有了就切过去；
 * 没有就建一个，再替用户发一条开场消息。
 */
export function useItemDiscussion(
  resident: Session | null,
  openSession: (key: string) => void,
  onOpened: () => void,
  onFailed: () => void,
  onSucceeded: () => void = () => {},
): (item: AssistantItem) => Promise<void> {
  const rc = resident?.connectionId ?? null;
  // A double click must not create the session (and send the opening message) twice.
  const creating = useRef(new Set<string>());

  return useCallback(
    async (item: AssistantItem) => {
      if (!rc) return;
      const key = `${ITEM_SESSION_PREFIX}${item.id}`;
      const exists = (useSessionStore.getState().sessions[rc] ?? []).some((s) => s.key === key);
      if (exists) {
        openSession(key);
        onOpened();
        return;
      }
      if (creating.current.has(key)) return;
      creating.current.add(key);
      try {
        useConnectionStore.getState().setActiveConnection(rc);
        if (!(await createSession(rc, key, `事项：${item.title}`))) {
          onFailed();
          return;
        }
        sendTextMessage(rc, key, discussionPrompt(item));
        onSucceeded();
        onOpened();
      } finally {
        creating.current.delete(key);
      }
    },
    [rc, openSession, onOpened, onFailed, onSucceeded],
  );
}
