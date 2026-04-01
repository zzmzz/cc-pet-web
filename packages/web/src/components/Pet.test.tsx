import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { PetFull } from "./Pet.js";
import { useUIStore } from "../lib/store/ui.js";

describe("Pet", () => {
  beforeEach(() => {
    useUIStore.setState({ chatOpen: true, petState: "idle", isMobile: false, windowMode: "chat" });
    localStorage.clear();
    localStorage.setItem("cc-pet-token", "pet-token");
    vi.restoreAllMocks();
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
});
