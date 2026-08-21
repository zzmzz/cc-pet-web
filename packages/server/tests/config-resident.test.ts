import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/db.js";
import { ConfigStore } from "../src/storage/config.js";

describe("ConfigStore resident + webPush parsing", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cc-pet-cfg-"));
    db = new Database(":memory:");
    initSchema(db);
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("parses residentSession on a token and root webPush", async () => {
    const file = path.join(dir, "cc-pet.config.json");
    await writeFile(
      file,
      JSON.stringify({
        bridges: [{ id: "cc", host: "h", port: 1, token: "t" }],
        tokens: [
          {
            token: "tok",
            name: "Z",
            bridgeIds: ["cc"],
            residentSession: { bridgeId: "cc", key: "resident", label: "第二大脑" },
          },
        ],
        webPush: { vapidPublicKey: "pub", vapidPrivateKey: "priv", subject: "mailto:a@b.c" },
      }),
      "utf8",
    );
    const store = new ConfigStore(db, { configFilePath: file });
    const cfg = store.load();
    expect(cfg.tokens[0].residentSession).toEqual({
      bridgeId: "cc",
      key: "resident",
      label: "第二大脑",
    });
    expect(cfg.webPush).toEqual({
      vapidPublicKey: "pub",
      vapidPrivateKey: "priv",
      subject: "mailto:a@b.c",
    });
  });

  it("drops malformed residentSession and webPush", async () => {
    const file = path.join(dir, "cc-pet.config.json");
    await writeFile(
      file,
      JSON.stringify({
        tokens: [{ token: "tok", name: "Z", bridgeIds: ["cc"], residentSession: { key: 5 } }],
        webPush: { vapidPublicKey: "" },
      }),
      "utf8",
    );
    const store = new ConfigStore(db, { configFilePath: file });
    const cfg = store.load();
    expect(cfg.tokens[0].residentSession).toBeUndefined();
    expect(cfg.webPush).toBeUndefined();
  });
});
