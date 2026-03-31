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
  useSessionStore.setState({ sessions: {}, activeSessionKey: {}, unread: {}, taskStateByConnection: {} });
  useUIStore.setState({ chatOpen: false, petState: "idle", isMobile: false });
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

  it("incrementUnread sets pet to talking when no session is processing", () => {
    useUIStore.getState().setPetState("idle");
    useSessionStore.getState().incrementUnread(chatKey);
    expect(useSessionStore.getState().unread[chatKey]).toBe(1);
    expect(useUIStore.getState().petState).toBe("talking");
  });

  it("incrementUnread keeps pet thinking when another session is still processing", () => {
    useUIStore.getState().setPetState("thinking");
    useSessionStore.setState({
      taskStateByConnection: {
        [conn]: {
          [sid]: {
            activeRequestId: "r1",
            phase: "working",
            startedAt: 1,
            lastActivityAt: 1,
            firstTokenAt: 1,
            stalledReason: null,
          },
        },
      },
    });
    const otherKey = makeChatKey(conn, "session-b");
    useSessionStore.getState().incrementUnread(otherKey);
    expect(useSessionStore.getState().unread[otherKey]).toBe(1);
    expect(useUIStore.getState().petState).toBe("thinking");
  });

  it("clearSessionUnread sets pet to idle when no unread remains and pet was talking", () => {
    useUIStore.getState().setPetState("talking");
    useSessionStore.setState({ unread: { [chatKey]: 2 } });

    useSessionStore.getState().clearSessionUnread(conn, sid);

    expect(useSessionStore.getState().unread[chatKey]).toBe(0);
    expect(useUIStore.getState().petState).toBe("idle");
  });

  it("clearSessionUnread sets pet to thinking when no unread remains but a session is still processing", () => {
    useUIStore.getState().setPetState("talking");
    useSessionStore.setState({
      unread: { [chatKey]: 1 },
      taskStateByConnection: {
        [conn]: {
          [sid]: {
            activeRequestId: "r1",
            phase: "working",
            startedAt: 1,
            lastActivityAt: 1,
            firstTokenAt: 1,
            stalledReason: null,
          },
        },
      },
    });

    useSessionStore.getState().clearSessionUnread(conn, sid);

    expect(useSessionStore.getState().unread[chatKey]).toBe(0);
    expect(useUIStore.getState().petState).toBe("thinking");
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

  it("removeSession clears task state for removed session", () => {
    useSessionStore.setState({
      sessions: {
        [conn]: [
          { key: sid, connectionId: conn, createdAt: 1, lastActiveAt: 1 },
          { key: "session-b", connectionId: conn, createdAt: 2, lastActiveAt: 2 },
        ],
      },
      activeSessionKey: { [conn]: sid },
      taskStateByConnection: {
        [conn]: {
          [sid]: { activeRequestId: "r1", phase: "thinking", startedAt: 1, lastActivityAt: 1, firstTokenAt: null, stalledReason: null },
          "session-b": { activeRequestId: "r2", phase: "working", startedAt: 2, lastActivityAt: 2, firstTokenAt: 2, stalledReason: null },
        },
      },
    });
    useSessionStore.getState().removeSession(conn, sid);
    const st = useSessionStore.getState();
    expect(st.taskStateByConnection[conn]?.[sid]).toBeUndefined();
    expect(st.taskStateByConnection[conn]?.["session-b"]?.phase).toBe("working");
  });

  it("patchSessionTaskState updates phase and keeps existing fields", () => {
    useSessionStore.getState().setSessionTaskState(conn, sid, {
      activeRequestId: "r1",
      phase: "thinking",
      startedAt: 100,
      lastActivityAt: 100,
      firstTokenAt: null,
      stalledReason: null,
    });
    useSessionStore.getState().patchSessionTaskState(conn, sid, {
      phase: "working",
      firstTokenAt: 120,
    });
    const next = useSessionStore.getState().taskStateByConnection[conn]?.[sid];
    expect(next?.activeRequestId).toBe("r1");
    expect(next?.phase).toBe("working");
    expect(next?.startedAt).toBe(100);
    expect(next?.firstTokenAt).toBe(120);
  });

  it("hasProcessingSessions is true only when any session is working/processing", () => {
    expect(useSessionStore.getState().hasProcessingSessions()).toBe(false);

    useSessionStore.getState().setSessionTaskState(conn, sid, {
      activeRequestId: "r1",
      phase: "awaiting_confirmation",
      startedAt: 100,
      lastActivityAt: 100,
      firstTokenAt: null,
      stalledReason: null,
    });
    expect(useSessionStore.getState().hasProcessingSessions()).toBe(false);

    useSessionStore.getState().patchSessionTaskState(conn, sid, { phase: "working" });
    expect(useSessionStore.getState().hasProcessingSessions()).toBe(true);

    useSessionStore.getState().patchSessionTaskState(conn, sid, { phase: "completed" });
    expect(useSessionStore.getState().hasProcessingSessions()).toBe(false);
  });

  it("touchSessionLastActive bumps lastActiveAt", () => {
    const t = 1_000_000;
    useSessionStore.setState({
      sessions: { [conn]: [{ key: sid, connectionId: conn, createdAt: t, lastActiveAt: t }] },
    });
    useSessionStore.getState().touchSessionLastActive(conn, sid);
    expect(useSessionStore.getState().sessions[conn]?.[0]?.lastActiveAt).toBeGreaterThan(t);
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

  it("touchSessionAutoTitle truncates long text to 15 chars with ellipsis", () => {
    useSessionStore.setState({
      sessions: {
        [conn]: [{ key: sid, connectionId: conn, createdAt: 1, lastActiveAt: 1 }],
      },
    });

    const long = "123456789012345678901234567890";
    useSessionStore.getState().touchSessionAutoTitle(conn, sid, long);

    expect(useSessionStore.getState().sessions[conn]?.[0]?.label).toBe("123456789012345…");
  });
});
