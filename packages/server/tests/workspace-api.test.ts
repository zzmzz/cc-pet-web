import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { initSchema } from "../src/storage/db.js";
import { ConfigStore } from "../src/storage/config.js";
import { authGuard } from "../src/middleware/auth.js";
import { registerWorkspaceRoutes } from "../src/api/workspace.js";
import { FILE_PREVIEW_MAX_BYTES } from "../src/workspace/file-service.js";
import { GIT_OUTPUT_MAX_BYTES } from "../src/workspace/git-service.js";
import {
  assertWritablePath,
  resolveConnectionWorkspace,
  resolveWorkspacePath,
  WorkspaceResolutionError,
} from "../src/workspace/resolver.js";

const execFileAsync = promisify(execFile);

describe("workspace resolver", () => {
  let db: Database.Database;
  let config: ConfigStore;
  let tempDir: string;
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initSchema(db);
    config = new ConfigStore(db);
    tempDir = await mkdtemp(path.join(tmpdir(), "cc-pet-workspace-"));
    workspaceDir = path.join(tempDir, "workspace");
    outsideDir = path.join(tempDir, "outside");
    await mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    workspaceDir = await realpath(workspaceDir);
    outsideDir = await realpath(outsideDir);
    await writeFile(path.join(workspaceDir, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await writeFile(path.join(outsideDir, "secret.txt"), "nope\n", "utf8");
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
        },
        {
          id: "missing-workspace",
          name: "Missing Workspace",
          host: "127.0.0.1",
          port: 9811,
          token: "",
          enabled: true,
        },
        {
          id: "invalid-workspace",
          name: "Invalid Workspace",
          host: "127.0.0.1",
          port: 9812,
          token: "",
          enabled: true,
          workspacePath: path.join(tempDir, "does-not-exist"),
        },
      ],
      tokens: [
        {
          token: "token-1",
          name: "dev",
          bridgeIds: ["conn-1", "missing-workspace", "invalid-workspace"],
        },
        {
          token: "token-2",
          name: "other",
          bridgeIds: ["missing-workspace"],
        },
      ],
      pet: { opacity: 1, size: 120 },
      server: { port: 3000, dataDir: "./data" },
    });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function resolvePath(
    connectionId: string,
    relativePath = "",
    token = "token-1",
    writable = false,
  ): Promise<{ statusCode: number; body: any }> {
    const app = Fastify();
    const loadedConfig = config.load();
    app.addHook("onRequest", authGuard(loadedConfig.tokens));
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof WorkspaceResolutionError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: "INTERNAL_ERROR", message });
    });
    app.get<{ Params: { connectionId: string }; Querystring: { path?: string; writable?: string } }>(
      "/api/workspaces/:connectionId/resolve",
      async (req) => {
        const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, config);
        const resolved = req.query.writable === "1"
          ? await assertWritablePath(workspace, req.query.path)
          : await resolveWorkspacePath(workspace, req.query.path);
        await access(resolved.absolutePath).catch(() => undefined);
        return {
          connectionId: workspace.connectionId,
          rootPath: workspace.rootPath,
          relativePath: resolved.relativePath,
          absolutePath: resolved.absolutePath,
        };
      },
    );

    try {
      const params = new URLSearchParams();
      if (relativePath) params.set("path", relativePath);
      if (writable) params.set("writable", "1");
      const res = await app.inject({
        method: "GET",
        url: `/api/workspaces/${connectionId}/resolve${params.size ? `?${params.toString()}` : ""}`,
        headers: { Authorization: `Bearer ${token}` },
      });
      return { statusCode: res.statusCode, body: res.json() };
    } finally {
      await app.close();
    }
  }

  it("resolves an authorized connection workspace from config", async () => {
    const result = await resolvePath("conn-1", "src/index.ts");

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      connectionId: "conn-1",
      rootPath: workspaceDir,
      relativePath: "src/index.ts",
      absolutePath: path.join(workspaceDir, "src", "index.ts"),
    });
  });

  it("rejects a connection that is not owned by the current token", async () => {
    const result = await resolvePath("conn-1", "", "token-2");

    expect(result.statusCode).toBe(403);
    expect(result.body.error).toBe("WORKSPACE_FORBIDDEN");
  });

  it("reports when a connection has no configured workspace", async () => {
    const result = await resolvePath("missing-workspace");

    expect(result.statusCode).toBe(404);
    expect(result.body.error).toBe("WORKSPACE_NOT_CONFIGURED");
  });

  it("reports when a configured workspace path is invalid", async () => {
    const result = await resolvePath("invalid-workspace");

    expect(result.statusCode).toBe(404);
    expect(result.body.error).toBe("WORKSPACE_UNAVAILABLE");
  });

  it("rejects paths that try to escape the workspace root", async () => {
    const traversal = await resolvePath("conn-1", "../outside/secret.txt");
    const absolute = await resolvePath("conn-1", path.join(outsideDir, "secret.txt"));

    expect(traversal.statusCode).toBe(400);
    expect(traversal.body.error).toBe("WORKSPACE_PATH_OUTSIDE_ROOT");
    expect(absolute.statusCode).toBe(400);
    expect(absolute.body.error).toBe("WORKSPACE_PATH_INVALID");
  });

  it("resolves symlinks that point outside the workspace root through their workspace path", async () => {
    await symlink(outsideDir, path.join(workspaceDir, "linked-outside"), "dir");

    const result = await resolvePath("conn-1", "linked-outside/secret.txt");

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      relativePath: "linked-outside/secret.txt",
      absolutePath: path.join(workspaceDir, "linked-outside", "secret.txt"),
    });
  });

  it("allows writable paths only when their parent stays inside the workspace", async () => {
    const valid = await resolvePath("conn-1", "src/new-file.ts", "token-1", true);
    const invalid = await resolvePath("conn-1", "../outside/new-file.ts", "token-1", true);

    expect(valid.statusCode).toBe(200);
    expect(valid.body.absolutePath).toBe(path.join(workspaceDir, "src", "new-file.ts"));
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body.error).toBe("WORKSPACE_PATH_OUTSIDE_ROOT");
  });
});

describe("workspace file api", () => {
  let db: Database.Database;
  let config: ConfigStore;
  let tempDir: string;
  let workspaceDir: string;
  let nonGitDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initSchema(db);
    config = new ConfigStore(db);
    tempDir = await mkdtemp(path.join(tmpdir(), "cc-pet-workspace-api-"));
    workspaceDir = path.join(tempDir, "workspace");
    nonGitDir = path.join(tempDir, "plain-workspace");
    outsideDir = path.join(tempDir, "outside");
    await mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await mkdir(path.join(workspaceDir, "empty"), { recursive: true });
    await mkdir(nonGitDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    workspaceDir = await realpath(workspaceDir);
    nonGitDir = await realpath(nonGitDir);
    outsideDir = await realpath(outsideDir);
    await writeFile(path.join(workspaceDir, "README.md"), "# Demo\n", "utf8");
    await writeFile(path.join(workspaceDir, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await writeFile(path.join(workspaceDir, "tracked-delete.txt"), "delete me\n", "utf8");
    await writeFile(path.join(nonGitDir, "plain.txt"), "not a repo\n", "utf8");
    await writeFile(path.join(outsideDir, "secret.txt"), "nope\n", "utf8");
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
        },
        {
          id: "missing-workspace",
          name: "Missing Workspace",
          host: "127.0.0.1",
          port: 9811,
          token: "",
          enabled: true,
        },
        {
          id: "plain-workspace",
          name: "Plain Workspace",
          host: "127.0.0.1",
          port: 9812,
          token: "",
          enabled: true,
          workspacePath: nonGitDir,
        },
      ],
      tokens: [
        {
          token: "token-1",
          name: "dev",
          bridgeIds: ["conn-1", "missing-workspace", "plain-workspace"],
        },
        {
          token: "token-2",
          name: "other",
          bridgeIds: ["missing-workspace"],
        },
      ],
      pet: { opacity: 1, size: 120 },
      server: { port: 3000, dataDir: "./data" },
    });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function injectWorkspace(
    url: string,
    token = "token-1",
    options: {
      method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      body?: unknown;
    } = {},
  ): Promise<{ statusCode: number; body: any }> {
    const app = Fastify();
    app.addHook("onRequest", authGuard(config.load().tokens));
    registerWorkspaceRoutes(app, config);
    try {
      const res = await app.inject({
        method: options.method ?? "GET",
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        payload: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      return { statusCode: res.statusCode, body: res.json() };
    } finally {
      await app.close();
    }
  }

  async function git(args: string[]): Promise<void> {
    await execFileAsync("git", ["-C", workspaceDir, ...args]);
  }

  async function initGitRepo(): Promise<void> {
    await git(["init"]);
    await git(["config", "user.name", "CC Pet Test"]);
    await git(["config", "user.email", "cc-pet@example.test"]);
    await git(["add", "."]);
    await git(["commit", "-m", "initial"]);
  }

  it("returns workspace meta for an authorized configured connection", async () => {
    const result = await injectWorkspace("/api/workspaces/conn-1");

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      connectionId: "conn-1",
      configured: true,
      rootName: path.basename(workspaceDir),
    });
  });

  it("lists direct children with file kind and extension metadata", async () => {
    const result = await injectWorkspace("/api/workspaces/conn-1/tree");

    expect(result.statusCode).toBe(200);
    expect(result.body.path).toBe("");
    expect(result.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "README.md", path: "README.md", kind: "file", extension: ".md" }),
        expect.objectContaining({ name: "src", path: "src", kind: "directory" }),
      ]),
    );
  });

  it("returns an empty entries array for empty directories", async () => {
    const result = await injectWorkspace("/api/workspaces/conn-1/tree?path=empty");

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ path: "empty", entries: [] });
  });

  it("lists directory symlinks outside the workspace as expandable directories", async () => {
    await symlink(outsideDir, path.join(workspaceDir, "linked-outside"), "dir");

    const root = await injectWorkspace("/api/workspaces/conn-1/tree");
    const linked = await injectWorkspace("/api/workspaces/conn-1/tree?path=linked-outside");

    expect(root.statusCode).toBe(200);
    expect(root.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "linked-outside",
          path: "linked-outside",
          kind: "directory",
          inaccessible: false,
        }),
        expect.objectContaining({ name: "README.md", inaccessible: false }),
      ]),
    );
    expect(linked.statusCode).toBe(200);
    expect(linked.body).toMatchObject({ path: "linked-outside" });
    expect(linked.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "secret.txt", path: "linked-outside/secret.txt", kind: "file" }),
      ]),
    );
  });

  it("reads a previewable text file with content and size", async () => {
    const result = await injectWorkspace("/api/workspaces/conn-1/file?path=src%2Findex.ts");

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      path: "src/index.ts",
      name: "index.ts",
      previewable: true,
      encoding: "utf8",
      content: "export const ok = true;\n",
    });
    expect(result.body.size).toBeGreaterThan(0);
  });

  it("streams raw bytes for downloads with attachment headers", async () => {
    const binaryPath = path.join(workspaceDir, "中文 名.bin");
    const binaryPayload = Buffer.from([0x00, 0x01, 0xff, 0x10, 0x20, 0x30]);
    await writeFile(binaryPath, binaryPayload);

    const app = Fastify();
    app.addHook("onRequest", authGuard(config.load().tokens));
    registerWorkspaceRoutes(app, config);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/workspaces/conn-1/file/download?path=${encodeURIComponent("中文 名.bin")}`,
        headers: { Authorization: "Bearer token-1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["content-length"]).toBe(String(binaryPayload.length));
      const disposition = String(res.headers["content-disposition"]);
      expect(disposition).toContain("attachment");
      expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("中文 名.bin")}`);
      expect(res.rawPayload.equals(binaryPayload)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("rejects download requests for missing files", async () => {
    const result = await injectWorkspace("/api/workspaces/conn-1/file/download?path=nope.txt");
    expect(result.statusCode).toBe(404);
    expect(result.body).toMatchObject({ error: "WORKSPACE_FILE_NOT_FOUND" });
  });

  it("rejects download requests for directories", async () => {
    const result = await injectWorkspace("/api/workspaces/conn-1/file/download?path=src");
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({ error: "WORKSPACE_PATH_NOT_FILE" });
  });

  it("returns a non-previewable response for files over the preview limit", async () => {
    await writeFile(path.join(workspaceDir, "large.txt"), "x".repeat(FILE_PREVIEW_MAX_BYTES + 1), "utf8");

    const result = await injectWorkspace("/api/workspaces/conn-1/file?path=large.txt");

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      path: "large.txt",
      previewable: false,
      reason: "FILE_TOO_LARGE",
    });
  });

  it("maps workspace resolution errors to testable api error codes", async () => {
    const forbidden = await injectWorkspace("/api/workspaces/conn-1/tree", "token-2");
    const missingWorkspace = await injectWorkspace("/api/workspaces/missing-workspace/tree");

    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body.error).toBe("WORKSPACE_FORBIDDEN");
    expect(missingWorkspace.statusCode).toBe(404);
    expect(missingWorkspace.body.error).toBe("WORKSPACE_NOT_CONFIGURED");
  });

  it("creates files and directories then shows them in the refreshed directory listing", async () => {
    const file = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "POST",
      body: { parentPath: "", name: "notes.txt", kind: "file" },
    });
    const directory = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "POST",
      body: { parentPath: "", name: "docs", kind: "directory" },
    });
    const listing = await injectWorkspace("/api/workspaces/conn-1/tree");

    expect(file.statusCode).toBe(200);
    expect(file.body.entry).toMatchObject({ name: "notes.txt", path: "notes.txt", kind: "file" });
    expect(directory.statusCode).toBe(200);
    expect(directory.body.entry).toMatchObject({ name: "docs", path: "docs", kind: "directory" });
    expect(listing.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "docs", kind: "directory" }),
        expect.objectContaining({ name: "notes.txt", kind: "file" }),
      ]),
    );
  });

  it("rejects empty, path-like, and duplicate item names with clear errors", async () => {
    const emptyName = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "POST",
      body: { parentPath: "", name: "  ", kind: "file" },
    });
    const pathName = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "POST",
      body: { parentPath: "", name: "../escape.txt", kind: "file" },
    });
    const duplicate = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "POST",
      body: { parentPath: "", name: "README.md", kind: "file" },
    });

    expect(emptyName.statusCode).toBe(400);
    expect(emptyName.body.error).toBe("WORKSPACE_NAME_INVALID");
    expect(pathName.statusCode).toBe(400);
    expect(pathName.body.error).toBe("WORKSPACE_NAME_INVALID");
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.body.error).toBe("WORKSPACE_ITEM_ALREADY_EXISTS");
  });

  it("renames files and directories while updating returned paths", async () => {
    const file = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "PATCH",
      body: { path: "README.md", newName: "README-renamed.md" },
    });
    const directory = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "PATCH",
      body: { path: "src", newName: "source" },
    });

    expect(file.statusCode).toBe(200);
    expect(file.body.entry).toMatchObject({ name: "README-renamed.md", path: "README-renamed.md", kind: "file" });
    expect(directory.statusCode).toBe(200);
    expect(directory.body.entry).toMatchObject({ name: "source", path: "source", kind: "directory" });
    await expect(access(path.join(workspaceDir, "README.md"))).rejects.toThrow();
    await access(path.join(workspaceDir, "README-renamed.md"));
    await access(path.join(workspaceDir, "source", "index.ts"));
  });

  it("deletes files and requires explicit recursive confirmation for non-empty directories", async () => {
    const file = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "DELETE",
      body: { path: "README.md" },
    });
    const blockedDirectory = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "DELETE",
      body: { path: "src" },
    });
    const confirmedDirectory = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "DELETE",
      body: { path: "src", recursive: true },
    });

    expect(file.statusCode).toBe(200);
    await expect(access(path.join(workspaceDir, "README.md"))).rejects.toThrow();
    expect(blockedDirectory.statusCode).toBe(400);
    expect(blockedDirectory.body.error).toBe("WORKSPACE_DIRECTORY_NOT_EMPTY");
    expect(confirmedDirectory.statusCode).toBe(200);
    await expect(access(path.join(workspaceDir, "src"))).rejects.toThrow();
  });

  it("saves preview-sized text files and exposes the updated content", async () => {
    const initial = await injectWorkspace("/api/workspaces/conn-1/file?path=README.md");
    const saved = await injectWorkspace("/api/workspaces/conn-1/file", "token-1", {
      method: "PUT",
      body: { path: "README.md", content: "# Updated\n", etag: initial.body.etag },
    });
    const preview = await injectWorkspace("/api/workspaces/conn-1/file?path=README.md");

    expect(initial.body.etag).toEqual(expect.any(String));
    expect(saved.statusCode).toBe(200);
    expect(saved.body.entry).toMatchObject({ name: "README.md", path: "README.md", kind: "file" });
    expect(await readFile(path.join(workspaceDir, "README.md"), "utf8")).toBe("# Updated\n");
    expect(preview.body.content).toBe("# Updated\n");
  });

  it("rejects saving when the file changed after preview and keeps external content", async () => {
    const initial = await injectWorkspace("/api/workspaces/conn-1/file?path=README.md");
    await writeFile(path.join(workspaceDir, "README.md"), "# External change\n", "utf8");

    const staleSave = await injectWorkspace("/api/workspaces/conn-1/file", "token-1", {
      method: "PUT",
      body: { path: "README.md", content: "# User save\n", etag: initial.body.etag },
    });

    expect(staleSave.statusCode).toBe(404);
    expect(staleSave.body.error).toBe("WORKSPACE_LIST_STALE");
    expect(staleSave.body.message).toContain("刷新后继续");
    expect(await readFile(path.join(workspaceDir, "README.md"), "utf8")).toBe("# External change\n");
  });

  it("reports stale lists for externally removed items and target conflicts", async () => {
    await rm(path.join(workspaceDir, "README.md"));
    await writeFile(path.join(workspaceDir, "src", "other.ts"), "export const other = true;\n", "utf8");
    const missingRename = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "PATCH",
      body: { path: "README.md", newName: "later.md" },
    });
    const conflictRename = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "PATCH",
      body: { path: "src/index.ts", newName: "other.ts" },
    });

    expect(missingRename.statusCode).toBe(404);
    expect(missingRename.body.error).toBe("WORKSPACE_LIST_STALE");
    expect(missingRename.body.message).toContain("列表已过期");
    expect(conflictRename.statusCode).toBe(400);
    expect(conflictRename.body.error).toBe("WORKSPACE_ITEM_ALREADY_EXISTS");
    expect(conflictRename.body.message).toContain("刷新后继续");
  });

  it("rejects create, write, rename, and delete requests that escape the workspace root", async () => {
    const createOutside = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "POST",
      body: { parentPath: "../outside", name: "new.txt", kind: "file" },
    });
    const writeOutside = await injectWorkspace("/api/workspaces/conn-1/file", "token-1", {
      method: "PUT",
      body: { path: "../outside/secret.txt", content: "owned" },
    });
    const renameOutside = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "PATCH",
      body: { path: "../outside/secret.txt", newName: "owned.txt" },
    });
    const deleteOutside = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "DELETE",
      body: { path: "../outside/secret.txt" },
    });

    expect(createOutside.statusCode).toBe(400);
    expect(createOutside.body.error).toBe("WORKSPACE_PATH_OUTSIDE_ROOT");
    expect(writeOutside.statusCode).toBe(400);
    expect(writeOutside.body.error).toBe("WORKSPACE_PATH_OUTSIDE_ROOT");
    expect(renameOutside.statusCode).toBe(400);
    expect(renameOutside.body.error).toBe("WORKSPACE_PATH_OUTSIDE_ROOT");
    expect(deleteOutside.statusCode).toBe(400);
    expect(deleteOutside.body.error).toBe("WORKSPACE_PATH_OUTSIDE_ROOT");
  });

  it("rejects write, rename, and delete requests targeting the workspace root", async () => {
    const writeRoot = await injectWorkspace("/api/workspaces/conn-1/file", "token-1", {
      method: "PUT",
      body: { path: ".", content: "owned" },
    });
    const renameRoot = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "PATCH",
      body: { path: ".", newName: "owned" },
    });
    const deleteRoot = await injectWorkspace("/api/workspaces/conn-1/items", "token-1", {
      method: "DELETE",
      body: { path: ".", recursive: true },
    });

    expect(writeRoot.statusCode).toBe(400);
    expect(writeRoot.body).toMatchObject({
      error: "WORKSPACE_PATH_INVALID",
      message: "Workspace root cannot be modified",
    });
    expect(renameRoot.statusCode).toBe(400);
    expect(renameRoot.body.error).toBe("WORKSPACE_PATH_INVALID");
    expect(deleteRoot.statusCode).toBe(400);
    expect(deleteRoot.body.error).toBe("WORKSPACE_PATH_INVALID");
    await access(workspaceDir);
  });

  it("returns git status changes with short status labels", async () => {
    await initGitRepo();
    await writeFile(path.join(workspaceDir, "README.md"), "# Changed\n", "utf8");
    await rm(path.join(workspaceDir, "tracked-delete.txt"));
    await writeFile(path.join(workspaceDir, "new-file.txt"), "new file\n", "utf8");
    await git(["mv", "src/index.ts", "src/main.ts"]);

    const result = await injectWorkspace("/api/workspaces/conn-1/git/status");

    expect(result.statusCode).toBe(200);
    expect(result.body.gitAvailable).toBe(true);
    expect(result.body.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "README.md", status: "M" }),
        expect.objectContaining({ path: "tracked-delete.txt", status: "D" }),
        expect.objectContaining({ path: "new-file.txt", status: "??" }),
        expect.objectContaining({ path: "src/main.ts", previousPath: "src/index.ts", status: "R" }),
      ]),
    );
  });

  it("returns a previewable single-file diff for modified and untracked files", async () => {
    await initGitRepo();
    await writeFile(path.join(workspaceDir, "README.md"), "# Changed\n", "utf8");
    await writeFile(path.join(workspaceDir, "new-file.txt"), "new file\n", "utf8");

    const modified = await injectWorkspace("/api/workspaces/conn-1/git/diff?path=README.md");
    const untracked = await injectWorkspace("/api/workspaces/conn-1/git/diff?path=new-file.txt");

    expect(modified.statusCode).toBe(200);
    expect(modified.body).toMatchObject({ path: "README.md", previewable: true });
    expect(modified.body.diff).toContain("-# Demo");
    expect(modified.body.diff).toContain("+# Changed");
    expect(untracked.statusCode).toBe(200);
    expect(untracked.body).toMatchObject({ path: "new-file.txt", previewable: true });
    expect(untracked.body.diff).toContain("+new file");
  });

  it("returns an empty git status for clean workspaces", async () => {
    await initGitRepo();

    const result = await injectWorkspace("/api/workspaces/conn-1/git/status");

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ gitAvailable: true, changes: [] });
  });

  it("reports non-git workspaces without blocking file browsing", async () => {
    const status = await injectWorkspace("/api/workspaces/plain-workspace/git/status");
    const diff = await injectWorkspace("/api/workspaces/plain-workspace/git/diff?path=plain.txt");
    const tree = await injectWorkspace("/api/workspaces/plain-workspace/tree");

    expect(status.statusCode).toBe(200);
    expect(status.body.gitAvailable).toBe(false);
    expect(status.body.message).toBeTruthy();
    expect(diff.statusCode).toBe(200);
    expect(diff.body).toMatchObject({ path: "plain.txt", previewable: false, reason: "GIT_UNAVAILABLE" });
    expect(tree.statusCode).toBe(200);
    expect(tree.body.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "plain.txt", kind: "file" })]),
    );
  });

  it("returns a non-previewable response for oversized and binary diffs", async () => {
    await initGitRepo();
    await writeFile(path.join(workspaceDir, "big.txt"), "old\n", "utf8");
    await writeFile(path.join(workspaceDir, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    await git(["add", "big.txt", "binary.dat"]);
    await git(["commit", "-m", "add diff fixtures"]);
    await writeFile(path.join(workspaceDir, "big.txt"), "x".repeat(GIT_OUTPUT_MAX_BYTES + 20_000), "utf8");
    await writeFile(path.join(workspaceDir, "binary.dat"), Buffer.from([0, 9, 8, 7, 6]));

    const bigDiff = await injectWorkspace("/api/workspaces/conn-1/git/diff?path=big.txt");
    const binaryDiff = await injectWorkspace("/api/workspaces/conn-1/git/diff?path=binary.dat");

    expect(bigDiff.statusCode).toBe(200);
    expect(bigDiff.body).toMatchObject({ path: "big.txt", previewable: false, reason: "DIFF_TOO_LARGE" });
    expect(binaryDiff.statusCode).toBe(200);
    expect(binaryDiff.body).toMatchObject({ path: "binary.dat", previewable: false, reason: "BINARY_DIFF" });
  });

  it("refreshes git status after files change during viewing", async () => {
    await initGitRepo();
    const clean = await injectWorkspace("/api/workspaces/conn-1/git/status");
    await writeFile(path.join(workspaceDir, "README.md"), "# Refresh\n", "utf8");

    const refreshedStatus = await injectWorkspace("/api/workspaces/conn-1/git/status");
    const refreshedDiff = await injectWorkspace("/api/workspaces/conn-1/git/diff?path=README.md");

    expect(clean.body.changes).toEqual([]);
    expect(refreshedStatus.body.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "README.md", status: "M" })]),
    );
    expect(refreshedDiff.body.diff).toContain("+# Refresh");
  });

  describe("git scope: nested repos", () => {
    async function initNestedRepo(absDir: string): Promise<void> {
      await execFileAsync("git", ["-C", absDir, "init"]);
      await execFileAsync("git", ["-C", absDir, "config", "user.name", "CC Pet Test"]);
      await execFileAsync("git", ["-C", absDir, "config", "user.email", "cc-pet@example.test"]);
      await execFileAsync("git", ["-C", absDir, "add", "."]);
      await execFileAsync("git", ["-C", absDir, "commit", "-m", "initial-nested"]);
    }

    it("returns nested-repo changes with workspace-root-relative paths", async () => {
      await initGitRepo();
      const nestedDir = path.join(workspaceDir, "sub", "embedded");
      await mkdir(nestedDir, { recursive: true });
      await writeFile(path.join(nestedDir, "inner.txt"), "hello\n", "utf8");
      await initNestedRepo(nestedDir);
      await writeFile(path.join(nestedDir, "inner.txt"), "hello changed\n", "utf8");
      await writeFile(path.join(nestedDir, "added.txt"), "new\n", "utf8");

      const status = await injectWorkspace("/api/workspaces/conn-1/git/status?scope=sub%2Fembedded");

      expect(status.statusCode).toBe(200);
      expect(status.body.gitAvailable).toBe(true);
      expect(status.body.repoMode).toBe("nested");
      expect(status.body.repoRoot).toBe("sub/embedded");
      expect(status.body.scope).toBe("sub/embedded");
      expect(status.body.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "sub/embedded/inner.txt", status: "M" }),
          expect.objectContaining({ path: "sub/embedded/added.txt", status: "??" }),
        ]),
      );
    });

    it("recognises a nested repo even when the scope path traverses a symlink", async () => {
      await initGitRepo();
      const realNestedDir = path.join(workspaceDir, "real-nested");
      await mkdir(realNestedDir, { recursive: true });
      await writeFile(path.join(realNestedDir, "inner.txt"), "v1\n", "utf8");
      await initNestedRepo(realNestedDir);
      await symlink(realNestedDir, path.join(workspaceDir, "link-to-nested"), "dir");
      await writeFile(path.join(realNestedDir, "inner.txt"), "v2\n", "utf8");

      const status = await injectWorkspace("/api/workspaces/conn-1/git/status?scope=link-to-nested");

      expect(status.statusCode).toBe(200);
      expect(status.body.gitAvailable).toBe(true);
      expect(status.body.repoMode).toBe("nested");
      expect(status.body.repoRoot).toBe("link-to-nested");
      expect(status.body.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "link-to-nested/inner.txt", status: "M" }),
        ]),
      );
    });

    it("prefixes rename change paths inside a nested repo", async () => {
      await initGitRepo();
      const nestedDir = path.join(workspaceDir, "sub", "embedded");
      await mkdir(nestedDir, { recursive: true });
      await writeFile(path.join(nestedDir, "old-name.txt"), "stay\n", "utf8");
      await initNestedRepo(nestedDir);
      await execFileAsync("git", ["-C", nestedDir, "mv", "old-name.txt", "new-name.txt"]);

      const status = await injectWorkspace("/api/workspaces/conn-1/git/status?scope=sub%2Fembedded");

      expect(status.statusCode).toBe(200);
      expect(status.body.repoMode).toBe("nested");
      const renameChange = (status.body.changes as Array<{ path: string; previousPath?: string; status: string }>).find(
        (c) => c.status === "R",
      );
      expect(renameChange).toBeDefined();
      expect(renameChange?.path).toBe("sub/embedded/new-name.txt");
      expect(renameChange?.previousPath).toBe("sub/embedded/old-name.txt");
    });

    it("returns a diff for files inside a nested repo using workspace-root paths", async () => {
      await initGitRepo();
      const nestedDir = path.join(workspaceDir, "sub", "embedded");
      await mkdir(nestedDir, { recursive: true });
      await writeFile(path.join(nestedDir, "inner.txt"), "hello\n", "utf8");
      await initNestedRepo(nestedDir);
      await writeFile(path.join(nestedDir, "inner.txt"), "hello changed\n", "utf8");

      const diff = await injectWorkspace(
        "/api/workspaces/conn-1/git/diff?path=sub%2Fembedded%2Finner.txt&scope=sub%2Fembedded",
      );

      expect(diff.statusCode).toBe(200);
      expect(diff.body).toMatchObject({
        path: "sub/embedded/inner.txt",
        previewable: true,
        repoMode: "nested",
        repoRoot: "sub/embedded",
        scope: "sub/embedded",
      });
      expect(diff.body.diff).toContain("-hello");
      expect(diff.body.diff).toContain("+hello changed");
    });
  });

  describe("git scope: subpath filter inside root repo", () => {
    it("filters status results to the requested subpath only", async () => {
      await initGitRepo();
      await mkdir(path.join(workspaceDir, "packages", "a"), { recursive: true });
      await mkdir(path.join(workspaceDir, "packages", "b"), { recursive: true });
      await writeFile(path.join(workspaceDir, "packages", "a", "file-a.txt"), "a-original\n", "utf8");
      await writeFile(path.join(workspaceDir, "packages", "b", "file-b.txt"), "b-original\n", "utf8");
      await git(["add", "packages"]);
      await git(["commit", "-m", "add packages"]);

      await writeFile(path.join(workspaceDir, "packages", "a", "file-a.txt"), "a-changed\n", "utf8");
      await writeFile(path.join(workspaceDir, "packages", "b", "file-b.txt"), "b-changed\n", "utf8");
      await writeFile(path.join(workspaceDir, "packages", "a", "new-a.txt"), "fresh\n", "utf8");

      const status = await injectWorkspace("/api/workspaces/conn-1/git/status?scope=packages%2Fa");

      expect(status.statusCode).toBe(200);
      expect(status.body.gitAvailable).toBe(true);
      expect(status.body.repoMode).toBe("subpath");
      expect(status.body.scope).toBe("packages/a");
      expect(status.body.repoRoot).toBe("");
      const paths = status.body.changes.map((c: { path: string }) => c.path);
      expect(paths).toEqual(expect.arrayContaining(["packages/a/file-a.txt"]));
      expect(paths.some((p: string) => p.startsWith("packages/b/"))).toBe(false);
      expect(paths).toEqual(expect.arrayContaining([expect.stringMatching(/^packages\/a\/new-a\.txt$/)]));
    });

    it("rejects diff requests whose path falls outside the requested scope", async () => {
      await initGitRepo();
      await mkdir(path.join(workspaceDir, "packages", "a"), { recursive: true });
      await writeFile(path.join(workspaceDir, "packages", "a", "file-a.txt"), "a\n", "utf8");
      await git(["add", "packages"]);
      await git(["commit", "-m", "add packages"]);
      await writeFile(path.join(workspaceDir, "README.md"), "# Changed\n", "utf8");

      const diff = await injectWorkspace(
        "/api/workspaces/conn-1/git/diff?path=README.md&scope=packages%2Fa",
      );

      expect(diff.statusCode).toBe(200);
      expect(diff.body).toMatchObject({
        path: "README.md",
        previewable: false,
        reason: "DIFF_UNAVAILABLE",
        repoMode: "subpath",
      });
    });
  });

  describe("git scope: validation", () => {
    it("rejects scopes that escape the workspace root", async () => {
      await initGitRepo();
      const escape = await injectWorkspace("/api/workspaces/conn-1/git/status?scope=..%2Foutside");

      expect(escape.statusCode).toBe(400);
      expect(escape.body.error).toBe("WORKSPACE_PATH_OUTSIDE_ROOT");
    });

    it("rejects scopes that do not point to a directory", async () => {
      await initGitRepo();
      const fileScope = await injectWorkspace("/api/workspaces/conn-1/git/status?scope=README.md");

      expect(fileScope.statusCode).toBe(400);
      expect(fileScope.body.error).toBe("WORKSPACE_PATH_INVALID");
    });

    it("returns 404 when scope points to a non-existing directory", async () => {
      await initGitRepo();
      const missing = await injectWorkspace(
        "/api/workspaces/conn-1/git/status?scope=does-not-exist%2Fanywhere",
      );

      expect(missing.statusCode).toBe(404);
      expect(missing.body.error).toBe("WORKSPACE_UNAVAILABLE");
    });
  });

  describe("git scopes listing", () => {
    it("returns workspace root and any nested git repositories", async () => {
      await initGitRepo();
      const nestedDir = path.join(workspaceDir, "sub", "embedded");
      await mkdir(nestedDir, { recursive: true });
      await writeFile(path.join(nestedDir, "inner.txt"), "x\n", "utf8");
      await execFileAsync("git", ["-C", nestedDir, "init"]);

      // Also produce a noise directory that should be ignored.
      await mkdir(path.join(workspaceDir, "node_modules", "skip-me"), { recursive: true });
      await mkdir(path.join(workspaceDir, "node_modules", "skip-me", ".git"), { recursive: true });

      const scopes = await injectWorkspace("/api/workspaces/conn-1/git/scopes");

      expect(scopes.statusCode).toBe(200);
      expect(scopes.body.scopes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "", repoMode: "root" }),
          expect.objectContaining({ path: "sub/embedded", repoMode: "nested" }),
        ]),
      );
      expect(
        scopes.body.scopes.some((s: { path: string }) => s.path.startsWith("node_modules")),
      ).toBe(false);
    });

    it("returns no root entry when workspace itself is not a git repo", async () => {
      const scopes = await injectWorkspace("/api/workspaces/plain-workspace/git/scopes");

      expect(scopes.statusCode).toBe(200);
      expect(scopes.body.scopes).toEqual([]);
    });
  });
});
