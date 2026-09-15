import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { ConfigStore } from "../storage/config.js";
import { WorkspaceResolutionError, resolveConnectionWorkspace } from "../workspace/resolver.js";

/**
 * Chat attachments used to travel as a single base64 WebSocket frame, which capped the
 * usable file size at ~75 MiB (100 MiB `ws` maxPayload / 1.333 base64 inflation) and
 * — worse — failed *silently*: the frame was dropped server-side while the browser's
 * send buffer drained normally, so the UI reported 100% success and the message simply
 * never reached the agent.
 *
 * Instead we stream the upload straight to disk inside the connection's workspace and
 * hand the agent a path. Nothing is buffered in memory, so the ceiling becomes free
 * disk space, and this mirrors what cc-connect already does with files it receives from
 * Telegram/WeChat (it writes them to the same directory and tells the agent to read the
 * path), so agents need no adaptation.
 */

/** Directory, relative to the workspace root, that cc-connect itself stages files in. */
export const ATTACHMENT_STAGING_DIR = path.join(".cc-connect", "attachments");

/** Reject absurd names early; the filesystem would too, but with a worse message. */
const MAX_FILENAME_LENGTH = 200;

/**
 * Hard ceiling per attachment. Not a memory constraint (nothing is buffered) — just a
 * backstop so a runaway or malicious upload cannot fill the workspace disk. Genuine
 * disk exhaustion is still handled separately via ENOSPC.
 *
 * NOTE: this MUST be passed to `req.file()` explicitly. @fastify/multipart v9 defaults
 * `limits.fileSize` to `fastify.initialConfig.bodyLimit`, which is Fastify's 1 MiB
 * default here — relying on the global `app.register(multipart)` would cap uploads at
 * 1 MiB.
 */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024 * 1024;

export interface StagedAttachment {
  /** Filename as actually written (may be de-duplicated). */
  name: string;
  /** Bytes written to disk. */
  size: number;
  /** Absolute path as the *agent* sees it. */
  agentPath: string;
}

/**
 * Strip directory components and characters that would let a filename escape the
 * staging directory or confuse the shell commands agents run over these paths.
 */
export function sanitizeAttachmentName(rawName: string): string {
  const base = path.basename(rawName ?? "");
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim();
  const safe = cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : "attachment";
  if (safe.length <= MAX_FILENAME_LENGTH) return safe;
  // Truncate the stem, never the extension — agents branch on it.
  const ext = path.extname(safe).slice(0, 24);
  return safe.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

/**
 * cc-connect's staging directory is a flat shared dump — it already holds same-stem
 * collisions like `授课老师.rar` / `授课老师.zip`. Never clobber an existing file: a
 * silent overwrite would destroy a file the agent may still be working on.
 */
export async function reserveAttachmentPath(stagingDir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = attempt === 0 ? name : `${stem}-${attempt}${ext}`;
    const absolute = path.join(stagingDir, candidate);
    try {
      await stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute;
      throw error;
    }
  }
  throw new Error(`Could not find a free filename for ${name}`);
}

/** Absolute staging path as the agent sees it, honouring the bind-mount translation. */
export function toAgentPath(
  workspaceRoot: string,
  workspaceAgentRoot: string | undefined,
  absolutePath: string,
): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  const agentRoot = workspaceAgentRoot?.trim();
  if (!agentRoot) return absolutePath;
  return path.join(agentRoot, relative);
}

export function registerAttachmentRoutes(app: FastifyInstance, configStore: ConfigStore) {
  app.post<{ Params: { connectionId: string } }>(
    "/api/attachments/:connectionId",
    async (req, reply) => {
      let stagedPath: string | undefined;
      try {
        if (!req.isMultipart()) {
          return reply.code(400).send({
            error: "ATTACHMENT_CONTENT_INVALID",
            message: "需要 multipart/form-data 请求体。",
          });
        }
        const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
        const bridge = configStore
          .load()
          .bridges.find((candidate) => candidate.id === req.params.connectionId);

        const stagingDir = path.join(workspace.rootPath, ATTACHMENT_STAGING_DIR);
        await mkdir(stagingDir, { recursive: true });

        // Streamed, never buffered — so the practical ceiling is disk space, not RAM.
        const part = await req.file({
          limits: { fileSize: ATTACHMENT_MAX_BYTES },
          // Surface the cap as `part.file.truncated` instead of a thrown
          // RequestFileTooLargeError, so the client gets a specific 413 rather than a
          // generic 500 it cannot act on.
          throwFileSizeLimit: false,
        });
        if (!part) {
          return reply.code(400).send({
            error: "ATTACHMENT_CONTENT_INVALID",
            message: "未在请求中找到上传文件。",
          });
        }

        const name = sanitizeAttachmentName(part.filename);
        stagedPath = await reserveAttachmentPath(stagingDir, name);
        await pipeline(part.file, createWriteStream(stagedPath));

        if (part.file.truncated) {
          // Treat a partial file as a failure rather than handing the agent a corrupt
          // archive it would report as a confusing unzip error.
          return reply.code(413).send({
            error: "ATTACHMENT_TOO_LARGE",
            message: `文件过大，单个附件不超过 ${Math.floor(ATTACHMENT_MAX_BYTES / (1024 * 1024 * 1024))} GB。`,
          });
        }

        const written = await stat(stagedPath);
        const staged: StagedAttachment = {
          name: path.basename(stagedPath),
          size: written.size,
          agentPath: toAgentPath(workspace.rootPath, bridge?.workspaceAgentPath, stagedPath),
        };
        req.log.info(
          { connectionId: req.params.connectionId, name: staged.name, size: staged.size },
          "Staged chat attachment to workspace",
        );
        return { ok: true, attachment: staged };
      } catch (error) {
        // A half-written file is worse than none: the agent would read a truncated
        // archive and report a confusing corruption error instead of an upload failure.
        if (stagedPath) await unlink(stagedPath).catch(() => {});
        if (error instanceof WorkspaceResolutionError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        }
        const message = error instanceof Error ? error.message : String(error);
        req.log.error(
          { connectionId: req.params.connectionId, error: message },
          "Failed staging chat attachment",
        );
        const isDiskFull = (error as NodeJS.ErrnoException).code === "ENOSPC";
        return reply.code(isDiskFull ? 507 : 500).send({
          error: isDiskFull ? "ATTACHMENT_DISK_FULL" : "ATTACHMENT_WRITE_FAILED",
          message: isDiskFull ? "工作区磁盘空间不足，上传未完成。" : `上传失败：${message}`,
        });
      }
    },
  );
}
