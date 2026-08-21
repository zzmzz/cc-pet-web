import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { PetFull, PetMini } from "./Pet.js";
import { useUIStore } from "../lib/store/ui.js";
import { setPlatform } from "../lib/platform.js";

const noop = () => {};
const minimalPlatform = {
  connectWs: noop,
  disconnectWs: noop,
  onWsEvent: () => () => {},
  sendWsMessage: vi.fn().mockReturnValue(""),
  flushOutbox: noop,
  fetchApi: vi.fn().mockResolvedValue({}),
};

describe("Pet", () => {
  beforeEach(() => {
    useUIStore.setState({
      chatOpen: true,
      petState: "idle",
      isMobile: false,
      settingsOpen: false,
    });
    localStorage.clear();
    localStorage.setItem("cc-pet-token", "pet-token");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setPlatform(minimalPlatform);
  });

  it("requests token pet image from server api", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["pet-bytes"], { type: "image/png" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:pet-idle"),
      }),
    );

    render(<PetFull />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/pet-images/idle", {
        headers: { Authorization: "Bearer pet-token" },
      });
    });
  });

  it("renders mini pet with transparent background", () => {
    const { getByRole } = render(<PetMini />);
    const button = getByRole("button");

    expect(button.className).toContain("bg-transparent");
    expect(button.className).not.toContain("bg-surface-tertiary");
  });

  it("renders full pet image with transparent background", () => {
    const { container } = render(<PetFull />);
    const image = container.querySelector("img[alt='pet']");

    expect(image).not.toBeNull();
    expect(image!.className).toContain("bg-transparent");
  });

  // The full pet paints at 112px and the mini avatar at 32px. Shipping one
  // 1024px source for both cost 3.6MB of precache for pixels nobody sees.
  it("serves the 256px asset to the full pet and the 96px asset to the mini pet", () => {
    localStorage.removeItem("cc-pet-token");

    const full = render(<PetFull />);
    expect(full.container.querySelector("img[alt='pet']")!.getAttribute("src")).toContain("idle-256");

    const mini = render(<PetMini />);
    expect(mini.container.querySelector("img[alt='pet']")!.getAttribute("src")).toContain("idle-96");
  });

  describe("custom pet image persistence", () => {
    let cacheStore: Map<string, Response>;

    const stubCaches = () => {
      cacheStore = new Map();
      vi.stubGlobal("caches", {
        open: async () => ({
          match: async (k: string) => cacheStore.get(k),
          put: async (k: string, res: Response) => {
            cacheStore.set(k, res);
          },
        }),
      });
    };

    // Distinct urls per blob so assertions can tell which bytes were rendered.
    const stubObjectUrl = () =>
      vi.stubGlobal(
        "URL",
        Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => `blob:size-${b.size}`) }),
      );

    beforeEach(() => {
      stubCaches();
      stubObjectUrl();
    });

    // Five base64 data urls consumed ~3.75MB of a ~5MB localStorage quota, and
    // that quota is shared with the outbox the retry queue persists into.
    it("persists the override into Cache Storage instead of localStorage", async () => {
      localStorage.setItem("cc-pet-token", "cache-write-token");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("pet-bytes", { headers: { "Content-Type": "image/webp" } })),
      );

      const { container } = render(<PetFull />);

      await waitFor(() => {
        expect(container.querySelector("img[alt='pet']")!.getAttribute("src")).toBe("blob:size-9");
      });
      expect(cacheStore.size).toBe(1);
      expect(Object.keys(localStorage).filter((k) => k.startsWith("cc-pet-image::"))).toEqual([]);
    });

    it("reclaims the quota by dropping legacy localStorage pet images", async () => {
      localStorage.setItem("cc-pet-token", "sweep-token");
      localStorage.setItem("cc-pet-image::sweep-token::idle", "data:image/png;base64,AAAA");
      localStorage.setItem("cc-pet-image::other::happy", "data:image/png;base64,BBBB");
      localStorage.setItem("cc-pet-outbox", "[]");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

      render(<PetFull />);

      await waitFor(() => {
        expect(Object.keys(localStorage).filter((k) => k.startsWith("cc-pet-image::"))).toEqual([]);
      });
      expect(localStorage.getItem("cc-pet-outbox")).toBe("[]");
    });

    it("shows the cached override when the server is unreachable", async () => {
      localStorage.setItem("cc-pet-token", "offline-token");
      cacheStore.set(
        "/__pet-image/offline-token/idle",
        new Response("cached-pet-bytes", { headers: { "Content-Type": "image/webp" } }),
      );
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

      const { container } = render(<PetFull />);

      await waitFor(() => {
        expect(container.querySelector("img[alt='pet']")!.getAttribute("src")).toBe("blob:size-16");
      });
    });

    // Cache-first forever would strand a user who swaps their configured image
    // behind a "clear site data" step, so the fetch still revalidates.
    it("replaces the cached override when the configured image changes", async () => {
      localStorage.setItem("cc-pet-token", "revalidate-token");
      cacheStore.set(
        "/__pet-image/revalidate-token/idle",
        new Response("old", { headers: { "Content-Type": "image/webp" } }),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("brand-new-bytes", { headers: { "Content-Type": "image/webp" } })),
      );

      const { container } = render(<PetFull />);

      await waitFor(() => {
        expect(container.querySelector("img[alt='pet']")!.getAttribute("src")).toBe("blob:size-15");
      });
      const stored = await cacheStore.get("/__pet-image/revalidate-token/idle")!.blob();
      expect(stored.size).toBe(15);
    });
  });
});
