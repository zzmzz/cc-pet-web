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

  it("restores in-flight task state after module re-init (simulate page refresh)", async () => {
    const now = Date.now();
    localStorage.setItem(
      "cc-pet-task-state",
      JSON.stringify({
        "cc-connect": {
          "session-a": {
            activeRequestId: "r1",
            phase: "working",
            startedAt: now - 1000,
            lastActivityAt: now - 500,
            firstTokenAt: now - 800,
            stalledReason: null,
          },
        },
      }),
    );

    const { useSessionStore } = await import("./session.js");
    const task = useSessionStore.getState().taskStateByConnection["cc-connect"]?.["session-a"];
    expect(task).toBeDefined();
    expect(task?.phase).toBe("working");
    expect(useSessionStore.getState().hasProcessingSessions()).toBe(true);
  });

  it("discards stale task state entries on restore", async () => {
    const staleTime = Date.now() - 10 * 60 * 1000;
    localStorage.setItem(
      "cc-pet-task-state",
      JSON.stringify({
        "cc-connect": {
          "session-old": {
            activeRequestId: "r-old",
            phase: "working",
            startedAt: staleTime - 5000,
            lastActivityAt: staleTime,
            firstTokenAt: staleTime - 3000,
            stalledReason: null,
          },
        },
      }),
    );

    const { useSessionStore } = await import("./session.js");
    expect(useSessionStore.getState().taskStateByConnection["cc-connect"]).toBeUndefined();
    expect(useSessionStore.getState().hasProcessingSessions()).toBe(false);
  });

  it("discards completed/idle task state entries on restore", async () => {
    const now = Date.now();
    localStorage.setItem(
      "cc-pet-task-state",
      JSON.stringify({
        "cc-connect": {
          "session-done": {
            activeRequestId: null,
            phase: "completed",
            startedAt: now - 2000,
            lastActivityAt: now - 100,
            firstTokenAt: now - 1500,
            stalledReason: null,
          },
        },
      }),
    );

    const { useSessionStore } = await import("./session.js");
    expect(useSessionStore.getState().taskStateByConnection["cc-connect"]).toBeUndefined();
  });

  it("persists task state when patchSessionTaskState is called", async () => {
    const { useSessionStore } = await import("./session.js");
    const now = Date.now();
    useSessionStore.getState().patchSessionTaskState("cc-connect", "session-a", {
      activeRequestId: "r1",
      phase: "working",
      startedAt: now,
      lastActivityAt: now,
      firstTokenAt: now,
      stalledReason: null,
    });

    const stored = JSON.parse(localStorage.getItem("cc-pet-task-state") ?? "{}");
    expect(stored["cc-connect"]?.["session-a"]?.phase).toBe("working");
  });
});
