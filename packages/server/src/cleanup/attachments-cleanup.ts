import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig } from "@cc-pet/shared";
import { ATTACHMENT_STAGING_DIR } from "../api/attachments.js";

/**
 * Age-based pruning of the attachment staging directory.
 *
 * Staged chat attachments are streamed to disk and never deleted by the send path — a
 * 165 MB zip stays there forever — so without pruning the directory grows without bound.
 *
 * IMPORTANT: this directory is cc-connect's own staging area, shared with files it
 * receives from Telegram/WeChat. Pruning by age therefore also removes those, which is
 * intended (they accumulate the same way) but means this is NOT a pet-web-only sweep.
 * The 30-day default is deliberately far longer than any live conversation, so an agent
 * cannot lose a file it is still working with.
 */

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

export interface AttachmentCleanupLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface AttachmentCleanupResult {
  deleted: number;
  freedBytes: number;
  /** Directories that could not be swept, keyed by connection id. */
  failures: { connectionId: string; error: string }[];
}

/**
 * Delete regular files older than `retentionDays` from one staging directory.
 *
 * Only regular files are touched: directories are left alone (cc-connect may organise
 * files into them) and symlinks are never followed, so a link planted in the staging
 * directory cannot be used to delete something outside it.
 */
export async function pruneStagingDirectory(
  stagingDir: string,
  retentionDays: number,
  now: number,
): Promise<{ deleted: number; freedBytes: number }> {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let freedBytes = 0;

  let entries: string[];
  try {
    entries = await readdir(stagingDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { deleted, freedBytes };
    throw error;
  }

  for (const entry of entries) {
    const absolute = path.join(stagingDir, entry);
    try {
      const info = await lstat(absolute);
      if (!info.isFile()) continue;
      if (info.mtimeMs >= cutoff) continue;
      await unlink(absolute);
      deleted += 1;
      freedBytes += info.size;
    } catch (error) {
      // A file vanishing mid-sweep (or a permission quirk on one entry) must not abort
      // the rest of the sweep.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }

  return { deleted, freedBytes };
}

export class AttachmentsCleanup {
  constructor(
    private readonly loadBridges: () => BridgeConfig[],
    private readonly logger?: AttachmentCleanupLogger,
  ) {}

  async runOnce(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<AttachmentCleanupResult> {
    const result: AttachmentCleanupResult = { deleted: 0, freedBytes: 0, failures: [] };
    const now = Date.now();
    // Two bridges can share one workspace (e.g. `yu` and `csyu` both map to /hywork);
    // sweeping the same directory twice would double-count the freed bytes.
    const seen = new Set<string>();

    for (const bridge of this.loadBridges()) {
      const root = bridge.workspacePath?.trim();
      if (!root) continue;
      const stagingDir = path.join(root, ATTACHMENT_STAGING_DIR);
      if (seen.has(stagingDir)) continue;
      seen.add(stagingDir);
      try {
        const swept = await pruneStagingDirectory(stagingDir, retentionDays, now);
        result.deleted += swept.deleted;
        result.freedBytes += swept.freedBytes;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failures.push({ connectionId: bridge.id, error: message });
      }
    }

    return result;
  }

  /** Run immediately, then daily. Mirrors SessionsCleanup.startCleanupSchedule. */
  startCleanupSchedule(retentionDays: number = DEFAULT_RETENTION_DAYS): NodeJS.Timeout {
    const sweep = async (label: string): Promise<void> => {
      try {
        const result = await this.runOnce(retentionDays);
        this.logger?.info(
          {
            deleted: result.deleted,
            freedMB: Math.round(result.freedBytes / (1024 * 1024)),
            failures: result.failures.length,
            retentionDays,
          },
          `${label} attachment cleanup completed`,
        );
        for (const failure of result.failures) {
          this.logger?.warn(failure, "Attachment cleanup failed for a workspace");
        }
      } catch (error) {
        this.logger?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          `${label} attachment cleanup failed`,
        );
      }
    };

    void sweep("Initial");
    return setInterval(() => void sweep("Daily"), CLEANUP_INTERVAL_MS);
  }
}
