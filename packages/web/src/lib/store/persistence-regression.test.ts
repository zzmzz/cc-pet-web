import { beforeEach, describe, expect, it, vi } from "vitest";

describe("store persistence regression", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("restores active session map after module re-init (simulate page refresh)", async () => {
    localStorage.setItem(
      "cc-pet-active-session-map",
      JSON.stringify({ "cc-connect": "session-b" }),
    );

    const { useSessionStore } = await import("./session.js");
    expect(useSessionStore.getState().activeSessionKey["cc-connect"]).toBe("session-b");
  });

  it("restores pet state after module re-init (simulate page refresh)", async () => {
    localStorage.setItem(
      "cc-pet-ui-state",
      JSON.stringify({ petState: "thinking" }),
    );

    const { useUIStore } = await import("./ui.js");
    expect(useUIStore.getState().petState).toBe("thinking");
  });
});
