import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { initSchema } from "../src/storage/db.js";
import { ConfigStore } from "../src/storage/config.js";
import { authGuard } from "../src/middleware/auth.js";
import {
  ATTACHMENT_STAGING_DIR,
  registerAttachmentRoutes,
  reserveAttachmentPath,
  sanitizeAttachmentName,
  toAgentPath,
} from "../src/api/attachments.js";

describe("chat attachment staging", () => {
  let db: Database.Database;
  let config: ConfigStore;
  let tempDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initSchema(db);
    config = new ConfigStore(db);
    tempDir = await mkdtemp(path.join(tmpdir(), "cc-pet-attachments-"));
    workspaceDir = await realpath(await mkdtemp(path.join(tempDir, "workspace-")));
    config.save({
      bridges: [
        {
          id: "conn-1",
          name: "Connection One",
          host: "127.0.0.1",
          port: 9810,
          token: "bridge-token",
          enabled: true,
          workspacePath: workspaceDir,
          // The server reaches the workspace through a bind mount; the agent sees it
          // under a different absolute path.
          workspaceAgentPath: "/root/code/hyworkspace",
        },
        {
          id: "no-workspace",
          name: "No Workspace",
          host: "127.0.0.1",
          port: 9811,
          token: "bridge-token",
          enabled: true,
        },
      ],
      tokens: [{ token: "token-1", name: "Token One", bridgeIds: ["conn-1", "no-workspace"] }],
      pet: { images: { idle: "idle.png" } } as any,
      server: { port: 3000 } as any,
    });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function injectUpload(
    connectionId: string,
    parts: { filename?: string; content?: Buffer; omitFile?: boolean },
    token = "token-1",
  ): Promise<{ statusCode: number; body: any }> {
    const app = Fastify();
    await app.register(multipart);
    app.addHook("onRequest", authGuard(config.load().tokens));
    registerAttachmentRoutes(app, config);
    try {
      const boundary = `----TestBoundary${Math.random().toString(16).slice(2)}`;
      const segments: Buffer[] = [];
      if (!parts.omitFile) {
        const filename = parts.filename ?? "upload.bin";
        const content = parts.content ?? Buffer.from("hello upload\n");
        segments.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
              `Content-Type: application/octet-stream\r\n\r\n`,
            "utf8",
          ),
        );
        segments.push(content);
        segments.push(Buffer.from("\r\n", "utf8"));
      }
      segments.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
      const res = await app.inject({
        method: "POST",
        url: `/api/attachments/${connectionId}`,
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat(segments),
      });
      return { statusCode: res.statusCode, body: res.json() };
    } finally {
      await app.close();
    }
  }

  it("streams an upload into the cc-connect staging directory", async () => {
    const payload = Buffer.from("附件正文 body\n", "utf8");
    const result = await injectUpload("conn-1", { filename: "报名材料.zip", content: payload });

    expect(result.statusCode).toBe(200);
    expect(result.body.attachment.name).toBe("报名材料.zip");
    expect(result.body.attachment.size).toBe(payload.byteLength);

    const staged = path.join(workspaceDir, ATTACHMENT_STAGING_DIR, "报名材料.zip");
    expect(await readFile(staged)).toEqual(payload);
  });

  it("reports the agent-visible path, not the server's mount path", async () => {
    const result = await injectUpload("conn-1", { filename: "a.zip" });

    expect(result.statusCode).toBe(200);
    // The agent runs on the host: handing it the container path would make every
    // staged attachment unreadable.
    expect(result.body.attachment.agentPath).toBe(
      "/root/code/hyworkspace/.cc-connect/attachments/a.zip",
    );
    expect(result.body.attachment.agentPath).not.toContain(workspaceDir);
  });

  it("falls back to the server path when no agent path is configured", async () => {
    const cfg = config.load();
    cfg.bridges[0].workspaceAgentPath = undefined;
    config.save(cfg);

    const result = await injectUpload("conn-1", { filename: "b.zip" });

    expect(result.statusCode).toBe(200);
    expect(result.body.attachment.agentPath).toBe(
      path.join(workspaceDir, ATTACHMENT_STAGING_DIR, "b.zip"),
    );
  });

  it("never overwrites an existing staged file", async () => {
    const stagingDir = path.join(workspaceDir, ATTACHMENT_STAGING_DIR);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(path.join(stagingDir, "dup.zip"), "original", "utf8");

    const result = await injectUpload("conn-1", {
      filename: "dup.zip",
      content: Buffer.from("newer", "utf8"),
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.attachment.name).toBe("dup-1.zip");
    // The pre-existing file — which an agent may still be reading — is intact.
    expect(await readFile(path.join(stagingDir, "dup.zip"), "utf8")).toBe("original");
    expect(await readFile(path.join(stagingDir, "dup-1.zip"), "utf8")).toBe("newer");
  });

  it("rejects connections without a configured workspace", async () => {
    const result = await injectUpload("no-workspace", { filename: "c.zip" });

    expect(result.statusCode).toBe(404);
    expect(result.body.error).toBe("WORKSPACE_NOT_CONFIGURED");
  });

  it("rejects a token that is not allowed to reach the connection", async () => {
    const cfg = config.load();
    cfg.tokens = [{ token: "token-2", name: "Token Two", bridgeIds: [] }];
    config.save(cfg);

    const result = await injectUpload("conn-1", { filename: "d.zip" }, "token-2");

    expect(result.statusCode).toBe(403);
  });

  it("rejects a request with no file part", async () => {
    const result = await injectUpload("conn-1", { omitFile: true });

    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe("ATTACHMENT_CONTENT_INVALID");
  });

  it("accepts a payload far larger than the old base64 WebSocket ceiling", async () => {
    // 96 MiB: base64-encoded this is ~128 MiB, over the 100 MiB `ws` frame cap that
    // used to drop such a message silently.
    const payload = Buffer.alloc(96 * 1024 * 1024, 0x41);
    const result = await injectUpload("conn-1", { filename: "big.zip", content: payload });

    expect(result.statusCode).toBe(200);
    expect(result.body.attachment.size).toBe(payload.byteLength);
    const staged = await stat(path.join(workspaceDir, ATTACHMENT_STAGING_DIR, "big.zip"));
    expect(staged.size).toBe(payload.byteLength);
  });
});

describe("attachment name handling", () => {
  it("strips path components so uploads cannot escape the staging directory", () => {
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentName("/abs/evil.sh")).toBe("evil.sh");
  });

  it("keeps unicode names intact", () => {
    expect(sanitizeAttachmentName("网络文艺优选汇申报材料.zip")).toBe("网络文艺优选汇申报材料.zip");
  });

  it("falls back to a placeholder for empty or dot-only names", () => {
    expect(sanitizeAttachmentName("")).toBe("attachment");
    expect(sanitizeAttachmentName("..")).toBe("attachment");
  });

  it("preserves the extension when truncating a very long name", () => {
    const name = `${"长".repeat(400)}.zip`;
    const result = sanitizeAttachmentName(name);
    expect(result.endsWith(".zip")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it("keeps probing until it finds a free filename", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cc-pet-reserve-"));
    try {
      await writeFile(path.join(dir, "x.txt"), "a", "utf8");
      await writeFile(path.join(dir, "x-1.txt"), "b", "utf8");
      expect(await reserveAttachmentPath(dir, "x.txt")).toBe(path.join(dir, "x-2.txt"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the server path unchanged when no agent root is set", () => {
    expect(toAgentPath("/srv/ws", undefined, "/srv/ws/.cc-connect/attachments/a.zip")).toBe(
      "/srv/ws/.cc-connect/attachments/a.zip",
    );
    expect(toAgentPath("/srv/ws", "   ", "/srv/ws/a.zip")).toBe("/srv/ws/a.zip");
  });
});
