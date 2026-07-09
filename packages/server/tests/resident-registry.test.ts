import { describe, it, expect, vi } from "vitest";
import { ResidentRegistry, residentSessionKey } from "../src/resident/registry.js";
import type { AppConfig } from "@cc-pet/shared";

function cfg(partial: Partial<AppConfig>): AppConfig {
  return { bridges: [], tokens: [], pet: { opacity: 1, size: 1 }, server: { port: 0, dataDir: "." }, ...partial };
}

describe("residentSessionKey", () => {
  it("组装合规 key：无冒号时用 {bridgeId}:{key}:{key}", () => {
    expect(residentSessionKey("cc", "resident")).toBe("cc:resident:resident");
  });

  it("已含冒号的完整 key 原样使用", () => {
    expect(residentSessionKey("cc", "cc:scope:user")).toBe("cc:scope:user");
  });
});

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
    expect(reg.isResident("cc", "cc:resident:resident")).toBe(true);
    expect(reg.isResident("cc", "other")).toBe(false);
    expect(reg.ownerToken("yu", "yu:resident:resident")).toBe("Yu");
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
    expect(markResident).toHaveBeenCalledWith("cc", "cc:resident:resident", "脑");
  });

  it("bootstrap 调用 demoteResidentExcept，传入集合含当前 pair、不含无关 key", () => {
    const reg = new ResidentRegistry(
      cfg({ tokens: [{ token: "t", name: "Z", bridgeIds: ["cc"], residentSession: { bridgeId: "cc", key: "resident", label: "脑" } }] }),
    );
    const markResident = vi.fn();
    const demoteResidentExcept = vi.fn();
    reg.bootstrap({ markResident, demoteResidentExcept });
    expect(demoteResidentExcept).toHaveBeenCalledTimes(1);
    const valid = demoteResidentExcept.mock.calls[0][0] as Set<string>;
    expect(valid.has("cc::cc:resident:resident")).toBe(true);
    expect(valid.has("cc::resident")).toBe(false);
    expect(valid.size).toBe(1);
  });
});
