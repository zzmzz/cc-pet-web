import { describe, it, expect } from "vitest";
import { WS_EVENTS } from "./events.js";

describe("WS_EVENTS", () => {
  it("includes the resident unread event", () => {
    expect(WS_EVENTS.RESIDENT_UNREAD).toBe("resident:unread");
  });
});
