import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { ConfigStore } from "../src/storage/config.js";
import { findTokenIdentity } from "../src/auth/token-auth.js";

describe("token ui mode", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cc-pet-ui-"));
    db = new Database(":memory:");
    initSchema(db);
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps ui=assistant and drops other values", async () => {
    const file = path.join(dir, "cc-pet.config.json");
    await writeFile(
      file,
      JSON.stringify({
        tokens: [
          { token: "tok-a", name: "A", bridgeIds: [], ui: "assistant" },
          { token: "tok-b", name: "B", bridgeIds: [], ui: "other" },
          { token: "tok-c", name: "C", bridgeIds: [] },
        ],
      }),
      "utf8",
    );
    const cfg = new ConfigStore(db, { configFilePath: file }).load();
    expect(cfg.tokens[0].ui).toBe("assistant");
    expect(cfg.tokens[1].ui).toBeUndefined();
    expect(cfg.tokens[2].ui).toBeUndefined();
  });

  it("findTokenIdentity carries ui", () => {
    const tokens = [
      { token: "tok-a", name: "A", bridgeIds: [], ui: "assistant" as const },
      { token: "tok-c", name: "C", bridgeIds: [] },
    ];
    expect(findTokenIdentity(tokens, "tok-a")?.ui).toBe("assistant");
    expect(findTokenIdentity(tokens, "tok-c")?.ui).toBeUndefined();
  });
});
