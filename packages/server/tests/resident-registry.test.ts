import { describe, it, expect, vi } from "vitest";
import { ResidentRegistry } from "../src/resident/registry.js";
import type { AppConfig } from "@cc-pet/shared";

function cfg(partial: Partial<AppConfig>): AppConfig {
  return { bridges: [], tokens: [], pet: { opacity: 1, size: 1 }, server: { port: 0, dataDir: "." }, ...partial };
}

describe("ResidentRegistry", () => {
  it("collects valid resident pairs and answers isResident/ownerToken", () => {
    const reg = new ResidentRegistry(
      cfg({
        tokens: [
          { token: "t1", name: "Ziiimo", bridgeIds: ["cc", "oc"], residentSession: { bridgeId: "cc", key: "resident", label: "脑" } },
          { token: "t2", name: "Yu", bridgeIds: ["yu"], residentSession: { bridgeId: "yu", key: "resident" } },
        ],
      }),
    );
    expect(reg.pairs()).toHaveLength(2);
    expect(reg.isResident("cc", "resident")).toBe(true);
    expect(reg.isResident("cc", "other")).toBe(false);
    expect(reg.ownerToken("yu", "resident")).toBe("Yu");
  });

  it("skips residentSession whose bridgeId is not in the token bridgeIds", () => {
    const warn = vi.fn();
    const reg = new ResidentRegistry(
      cfg({ tokens: [{ token: "t", name: "Z", bridgeIds: ["cc"], residentSession: { bridgeId: "zzz", key: "resident" } }] }),
      { warn },
    );
    expect(reg.pairs()).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("bootstrap marks each pair resident on the store", () => {
    const reg = new ResidentRegistry(
      cfg({ tokens: [{ token: "t", name: "Z", bridgeIds: ["cc"], residentSession: { bridgeId: "cc", key: "resident", label: "脑" } }] }),
    );
    const markResident = vi.fn();
    reg.bootstrap({ markResident });
    expect(markResident).toHaveBeenCalledWith("cc", "resident", "脑");
  });
});
