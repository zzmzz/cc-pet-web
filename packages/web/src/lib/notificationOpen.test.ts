import { describe, expect, it, vi } from "vitest";
import {
  OPEN_SESSION_MESSAGE,
  notificationUrl,
  onOpenSessionRequest,
  parseOpenRequest,
  takeOpenFromUrl,
} from "./notificationOpen.js";

describe("parseOpenRequest", () => {
  it("accepts a connection and session key", () => {
    expect(parseOpenRequest({ connectionId: "c1", sessionKey: "task-2" })).toEqual({ connectionId: "c1", sessionKey: "task-2" });
    expect(parseOpenRequest({ type: OPEN_SESSION_MESSAGE, connectionId: "c1", sessionKey: "task-2", x: 1 })).toEqual({
      connectionId: "c1",
      sessionKey: "task-2",
    });
  });
  it("rejects anything else", () => {
    for (const v of [null, undefined, "x", {}, { connectionId: "c1" }, { connectionId: "", sessionKey: "a" }, { connectionId: 1, sessionKey: "a" }]) {
      expect(parseOpenRequest(v)).toBeNull();
    }
  });
});

describe("notificationUrl / takeOpenFromUrl", () => {
  it("round-trips through the page URL and then cleans it up", () => {
    const url = notificationUrl({ connectionId: "c 1", sessionKey: "demo:resident:resident" });
    expect(url.startsWith("/?")).toBe(true);
    const u = new URL(url, "https://pet.example");
    const replaceState = vi.fn();
    const got = takeOpenFromUrl({ search: u.search, pathname: "/", hash: "#x" }, { replaceState, state: { a: 1 } });
    expect(got).toEqual({ connectionId: "c 1", sessionKey: "demo:resident:resident" });
    expect(replaceState).toHaveBeenCalledWith({ a: 1 }, "", "/#x");
  });
  it("keeps unrelated query parameters and leaves a plain URL alone", () => {
    const replaceState = vi.fn();
    expect(takeOpenFromUrl({ search: "?debug=1", pathname: "/", hash: "" }, { replaceState, state: null })).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
    takeOpenFromUrl(
      { search: "?debug=1&openConnection=c1&openSession=task-1", pathname: "/", hash: "" },
      { replaceState, state: null },
    );
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?debug=1");
  });
  it("gives the plain root when there is nothing to open", () => {
    expect(notificationUrl(null)).toBe("/");
  });
});

describe("onOpenSessionRequest", () => {
  it("passes on service worker messages of the right type", () => {
    const target = new EventTarget();
    const seen: unknown[] = [];
    const off = onOpenSessionRequest((r) => seen.push(r), target);
    const send = (data: unknown) => target.dispatchEvent(Object.assign(new Event("message"), { data }));
    send({ type: OPEN_SESSION_MESSAGE, connectionId: "c1", sessionKey: "task-1" });
    send({ type: "other", connectionId: "c1", sessionKey: "task-2" });
    send({ type: OPEN_SESSION_MESSAGE, connectionId: "c1" });
    off();
    send({ type: OPEN_SESSION_MESSAGE, connectionId: "c1", sessionKey: "task-3" });
    expect(seen).toEqual([{ connectionId: "c1", sessionKey: "task-1" }]);
  });
  it("does nothing without service worker support", () => {
    expect(() => onOpenSessionRequest(() => {}, null)()).not.toThrow();
  });
});
