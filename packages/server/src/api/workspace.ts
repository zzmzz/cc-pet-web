import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ConfigStore } from "../storage/config.js";
import { WorkspaceResolutionError, resolveConnectionWorkspace, resolveWorkspacePath } from "../workspace/resolver.js";
import {
  WorkspaceFileError,
  createItem,
  deleteItem,
  listDirectory,
  readFilePreview,
  renameItem,
  writeFileContent,
} from "../workspace/file-service.js";
import type { WorkspaceMeta } from "../workspace/file-service.js";
import { getGitDiff, getGitStatus, listGitScopes } from "../workspace/git-service.js";

function sendWorkspaceError(reply: FastifyReply, error: unknown) {
  if (error instanceof WorkspaceResolutionError || error instanceof WorkspaceFileError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(500).send({ error: "WORKSPACE_INTERNAL_ERROR", message });
}

export function registerWorkspaceRoutes(app: FastifyInstance, configStore: Pick<ConfigStore, "load">) {
  app.get<{ Params: { connectionId: string } }>("/api/workspaces/:connectionId", async (req, reply) => {
    try {
      const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
      const meta: WorkspaceMeta = {
        connectionId: workspace.connectionId,
        configured: true,
        rootName: path.basename(workspace.rootPath),
      };
      return meta;
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.get<{
    Params: { connectionId: string };
    Querystring: { path?: string };
  }>("/api/workspaces/:connectionId/tree", async (req, reply) => {
    try {
      const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
      return await listDirectory(workspace, req.query.path ?? "");
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.get<{
    Params: { connectionId: string };
    Querystring: { path?: string };
  }>("/api/workspaces/:connectionId/file", async (req, reply) => {
    try {
      if (!req.query.path) {
        return reply.code(400).send({
          error: "WORKSPACE_PATH_INVALID",
          message: "File path is required",
        });
      }
      const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
      return await readFilePreview(workspace, req.query.path);
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.get<{
    Params: { connectionId: string };
    Querystring: { path?: string };
  }>("/api/workspaces/:connectionId/file/download", async (req, reply) => {
    try {
      if (!req.query.path) {
        return reply.code(400).send({
          error: "WORKSPACE_PATH_INVALID",
          message: "File path is required",
        });
      }
      const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
      const resolved = await resolveWorkspacePath(workspace, req.query.path);
      const stats = await stat(resolved.absolutePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          throw new WorkspaceFileError("WORKSPACE_FILE_NOT_FOUND", "File was not found", 404);
        }
        throw error;
      });
      if (!stats.isFile()) {
        throw new WorkspaceFileError("WORKSPACE_PATH_NOT_FILE", "Workspace path is not a file", 400);
      }

      const filename = path.basename(resolved.relativePath);
      const asciiFallback = filename.replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_");
      const encoded = encodeURIComponent(filename);
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Length", String(stats.size));
      reply.header(
        "Content-Disposition",
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
      );
      return reply.send(createReadStream(resolved.absolutePath));
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.put<{
    Params: { connectionId: string };
    Body: { path?: unknown; content?: unknown; etag?: unknown };
  }>("/api/workspaces/:connectionId/file", async (req, reply) => {
    try {
      if (typeof req.body?.path !== "string" || !req.body.path) {
        return reply.code(400).send({
          error: "WORKSPACE_PATH_INVALID",
          message: "File path is required",
        });
      }
      const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
      const entry = await writeFileContent(workspace, req.body.path, req.body.content, req.body.etag);
      return { ok: true, entry };
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.post<{
    Params: { connectionId: string };
    Body: { parentPath?: unknown; name?: unknown; kind?: unknown };
  }>("/api/workspaces/:connectionId/items", async (req, reply) => {
    try {
      const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
      const parentPath = typeof req.body?.parentPath === "string" ? req.body.parentPath : "";
      const entry = await createItem(workspace, parentPath, req.body?.name, req.body?.kind);
      return { ok: true, entry };
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.patch<{
    Params: { connectionId: string };
    Body: { path?: unknown; newName?: unknown };
  }>("/api/workspaces/:connectionId/items", async (req, reply) => {
    try {
      if (typeof req.body?.path !== "string" || !req.body.path) {
        return reply.code(400).send({
          error: "WORKSPACE_PATH_INVALID",
          message: "Item path is required",
        });
      }
      const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
      const entry = await renameItem(workspace, req.body.path, req.body.newName);
      return { ok: true, entry };
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.delete<{
    Params: { connectionId: string };
    Body: { path?: unknown; recursive?: unknown };
  }>("/api/workspaces/:connectionId/items", async (req, reply) => {
    try {
      if (typeof req.body?.path !== "string" || !req.body.path) {
        return reply.code(400).send({
          error: "WORKSPACE_PATH_INVALID",
          message: "Item path is required",
        });
      }
      const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
      return await deleteItem(workspace, req.body.path, req.body.recursive === true);
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.get<{
    Params: { connectionId: string };
    Querystring: { scope?: string };
  }>("/api/workspaces/:connectionId/git/status", async (req, reply) => {
    try {
      const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
      return await getGitStatus(workspace, { scope: req.query.scope });
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.get<{
    Params: { connectionId: string };
    Querystring: { path?: string; scope?: string };
  }>("/api/workspaces/:connectionId/git/diff", async (req, reply) => {
    try {
      if (!req.query.path) {
        return reply.code(400).send({
          error: "WORKSPACE_PATH_INVALID",
          message: "Diff path is required",
        });
      }
      const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
      return await getGitDiff(workspace, req.query.path, { scope: req.query.scope });
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.get<{ Params: { connectionId: string } }>(
    "/api/workspaces/:connectionId/git/scopes",
    async (req, reply) => {
      try {
        const workspace = await resolveConnectionWorkspace(req, req.params.connectionId, configStore);
        return await listGitScopes(workspace);
      } catch (error) {
        return sendWorkspaceError(reply, error);
      }
    },
  );
}
