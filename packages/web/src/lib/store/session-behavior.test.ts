import { beforeEach, describe, expect, it } from "vitest";
import { makeChatKey } from "@cc-pet/shared";
import { useMessageStore } from "./message.js";
import { useSessionStore } from "./session.js";
import { useUIStore } from "./ui.js";

const conn = "bridge-1";
const sid = "session-a";
const chatKey = makeChatKey(conn, sid);

function resetStores() {
  useMessageStore.setState({ messagesByChat: {}, streamingContent: {} });
  useSessionStore.setState({ sessions: {}, activeSessionKey: {}, unread: {} });
  useUIStore.setState({ chatOpen: false, settingsOpen: false, petState: "idle", isMobile: false });
}

describe("session store behavior", () => {
  beforeEach(() => {
    resetStores();
  });

  it("removeSession purges messages, streaming, unread, and session row; reassigns active", () => {
    useSessionStore.setState({
      sessions: {
        [conn]: [
          { key: sid, connectionId: conn, label: "My chat", createdAt: 1, lastActiveAt: 1 },
          { key: "session-b", connectionId: conn, createdAt: 2, lastActiveAt: 2 },
        ],
      },
      activeSessionKey: { [conn]: sid },
      unread: { [chatKey]: 3, [makeChatKey(conn, "session-b")]: 1 },
    });
    useMessageStore.getState().addMessage(chatKey, {
      id: "m1",
      role: "user",
      content: "hi",
      timestamp: 1,
      connectionId: conn,
      sessionKey: sid,
    });
    useMessageStore.getState().appendStreamDelta(chatKey, "partial");

    useSessionStore.getState().removeSession(conn, sid);

    const msg = useMessageStore.getState();
    expect(msg.messagesByChat[chatKey]).toBeUndefined();
    expect(msg.streamingContent[chatKey]).toBeUndefined();

    const sess = useSessionStore.getState();
    expect(sess.sessions[conn]?.map((x) => x.key)).toEqual(["session-b"]);
    expect(sess.unread[chatKey]).toBeUndefined();
    expect(sess.activeSessionKey[conn]).toBe("session-b");
  });

  it("clearSessionUnread sets pet to idle when no unread remains and pet was talking", () => {
    useUIStore.getState().setPetState("talking");
    useSessionStore.setState({ unread: { [chatKey]: 2 } });

    useSessionStore.getState().clearSessionUnread(conn, sid);

    expect(useSessionStore.getState().unread[chatKey]).toBe(0);
    expect(useUIStore.getState().petState).toBe("idle");
  });

  it("clearSessionUnread does not set idle when another chat still has unread", () => {
    useUIStore.getState().setPetState("talking");
    const other = makeChatKey(conn, "session-b");
    useSessionStore.setState({ unread: { [chatKey]: 1, [other]: 1 } });

    useSessionStore.getState().clearSessionUnread(conn, sid);

    expect(useSessionStore.getState().unread[chatKey]).toBe(0);
    expect(useSessionStore.getState().unread[other]).toBe(1);
    expect(useUIStore.getState().petState).toBe("talking");
  });

  it("removeSession clears unread and may set pet idle when it was the last unread", () => {
    useUIStore.getState().setPetState("talking");
    useSessionStore.setState({
      sessions: {
        [conn]: [{ key: sid, connectionId: conn, createdAt: 1, lastActiveAt: 1 }],
      },
      activeSessionKey: { [conn]: sid },
      unread: { [chatKey]: 2 },
    });

    useSessionStore.getState().removeSession(conn, sid);

    expect(useSessionStore.getState().unread[chatKey]).toBeUndefined();
    expect(useUIStore.getState().petState).toBe("idle");
    expect(useSessionStore.getState().activeSessionKey[conn]).toBeUndefined();
  });

  it("touchSessionAutoTitle sets label from first user text when title is still default", () => {
    useSessionStore.setState({
      sessions: {
        [conn]: [{ key: sid, connectionId: conn, createdAt: 1, lastActiveAt: 1 }],
      },
    });

    useSessionStore.getState().touchSessionAutoTitle(conn, sid, "  hello world  ");

    const row = useSessionStore.getState().sessions[conn]?.[0];
    expect(row?.label).toBe("hello world");
  });

  it("syncAutoTitleFromHistoryMessages uses first user message like a history backfill", () => {
    useSessionStore.setState({
      sessions: {
        [conn]: [{ key: sid, connectionId: conn, createdAt: 1, lastActiveAt: 1 }],
      },
    });

    useSessionStore.getState().syncAutoTitleFromHistoryMessages(conn, sid, [
      { role: "assistant", content: "sys" },
      { role: "user", content: "from history" },
    ]);

    expect(useSessionStore.getState().sessions[conn]?.[0]?.label).toBe("from history");
  });

  it("touchSessionAutoTitle skips when label was already customized", () => {
    useSessionStore.setState({
      sessions: {
        [conn]: [
          {
            key: sid,
            connectionId: conn,
            label: "Pinned title",
            createdAt: 1,
            lastActiveAt: 1,
          },
        ],
      },
    });

    useSessionStore.getState().touchSessionAutoTitle(conn, sid, "new text");

    expect(useSessionStore.getState().sessions[conn]?.[0]?.label).toBe("Pinned title");
  });

  it("touchSessionAutoTitle truncates long text to 48 chars with ellipsis", () => {
    useSessionStore.setState({
      sessions: {
        [conn]: [{ key: sid, connectionId: conn, createdAt: 1, lastActiveAt: 1 }],
      },
    });

    const long = "1234567890123456789012345678901234567890123456789";
    useSessionStore.getState().touchSessionAutoTitle(conn, sid, long);

    expect(useSessionStore.getState().sessions[conn]?.[0]?.label).toBe(
      "123456789012345678901234567890123456789012345678…",
    );
  });
});
