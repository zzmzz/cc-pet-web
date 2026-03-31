import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getRequestAuthIdentity } from "../middleware/auth.js";

const PET_STATES = new Set(["idle", "thinking", "talking", "happy", "error"]);

function guessImageMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function resolveImagePath(rawPath: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

export function registerPetImageRoutes(app: FastifyInstance) {
  app.get<{ Params: { state: string } }>("/api/pet-images/:state", async (req, reply) => {
    if (!PET_STATES.has(req.params.state)) {
      return reply.code(404).send({ error: "Pet state not found" });
    }
    const auth = getRequestAuthIdentity(req);
    const petImages = auth?.petImages;
    if (!petImages?.idle) {
      return reply.code(404).send({ error: "Token pet image not configured" });
    }
    const imagePath =
      petImages[req.params.state as keyof typeof petImages] ??
      petImages.idle;
    const resolvedPath = resolveImagePath(imagePath);
    try {
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return reply.code(404).send({ error: "Image file not found" });
      }
      const bytes = fs.readFileSync(resolvedPath);
      reply.header("Content-Type", guessImageMime(resolvedPath));
      return reply.send(bytes);
    } catch {
      return reply.code(404).send({ error: "Image file not found" });
    }
  });
}
