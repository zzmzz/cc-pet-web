import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { BridgeConfig } from "@cc-pet/shared";
import { ATTACHMENT_STAGING_DIR } from "../src/api/attachments.js";
import { AttachmentsCleanup, pruneStagingDirectory } from "../src/cleanup/attachments-cleanup.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("attachment staging cleanup", () => {
  let tempDir: string;
  let workspaceDir: string;
  let stagingDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cc-pet-cleanup-"));
    workspaceDir = path.join(tempDir, "workspace");
    stagingDir = path.join(workspaceDir, ATTACHMENT_STAGING_DIR);
    await mkdir(stagingDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeAged(name: string, ageDays: number, content = "x"): Promise<string> {
    const absolute = path.join(stagingDir, name);
    await writeFile(absolute, content, "utf8");
    const when = new Date(Date.now() - ageDays * DAY_MS);
    await utimes(absolute, when, when);
    return absolute;
  }

  it("deletes files older than the retention window and keeps newer ones", async () => {
    await writeAged("ancient.zip", 45, "aaaa");
    await writeAged("stale.zip", 31);
    await writeAged("fresh.zip", 29);
    await writeAged("today.zip", 0);

    const result = await pruneStagingDirectory(stagingDir, 30, Date.now());

    expect(result.deleted).toBe(2);
    expect(result.freedBytes).toBe(5);
    const remaining = (await readdir(stagingDir)).sort();
    expect(remaining).toEqual(["fresh.zip", "today.zip"]);
  });

  it("leaves directories alone", async () => {
    const nested = path.join(stagingDir, "old-folder");
    await mkdir(nested);
    const when = new Date(Date.now() - 90 * DAY_MS);
    await utimes(nested, when, when);

    const result = await pruneStagingDirectory(stagingDir, 30, Date.now());

    expect(result.deleted).toBe(0);
    await expect(stat(nested)).resolves.toBeTruthy();
  });

  it("never follows a symlink out of the staging directory", async () => {
    const outsideFile = path.join(tempDir, "precious.txt");
    await writeFile(outsideFile, "do not delete", "utf8");
    const link = path.join(stagingDir, "escape.txt");
    await symlink(outsideFile, link);
    const when = new Date(Date.now() - 90 * DAY_MS);
    await utimes(link, when, when);

    const result = await pruneStagingDirectory(stagingDir, 30, Date.now());

    // The symlink is not a regular file, so it is skipped entirely — and crucially the
    // file it points at, outside the staging directory, is untouched.
    expect(result.deleted).toBe(0);
    await expect(stat(outsideFile)).resolves.toBeTruthy();
  });

  it("treats a missing staging directory as a no-op", async () => {
    const result = await pruneStagingDirectory(path.join(tempDir, "nope"), 30, Date.now());
    expect(result).toEqual({ deleted: 0, freedBytes: 0 });
  });

  it("sweeps a shared workspace only once across bridges", async () => {
    await writeAged("old.zip", 60, "abcdefgh");
    // `yu` and `csyu` both point at the same workspace in the real deployment; counting
    // the sweep twice would report double the space actually freed.
    const bridges: BridgeConfig[] = [
      { id: "yu", name: "yu", host: "h", port: 1, token: "t", enabled: true, workspacePath: workspaceDir },
      { id: "csyu", name: "csyu", host: "h", port: 2, token: "t", enabled: true, workspacePath: workspaceDir },
    ];

    const result = await new AttachmentsCleanup(() => bridges).runOnce(30);

    expect(result.deleted).toBe(1);
    expect(result.freedBytes).toBe(8);
    expect(result.failures).toEqual([]);
  });

  it("skips bridges without a workspace", async () => {
    const bridges: BridgeConfig[] = [
      { id: "cx", name: "cx", host: "h", port: 1, token: "t", enabled: true },
    ];

    const result = await new AttachmentsCleanup(() => bridges).runOnce(30);

    expect(result).toEqual({ deleted: 0, freedBytes: 0, failures: [] });
  });
});
