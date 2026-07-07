import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileAttachment } from "@cc-pet/shared";

function filesDirOf(dataDir: string): string {
  const dir = path.join(dataDir, "files");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persist a base64-encoded payload to the shared files store and return a
 * downloadable FileAttachment. Used for bridge-received `file` frames so the
 * dashboard can render/download them the same way as uploaded files.
 */
export function saveBase64File(dataDir: string, name: string, base64: string): FileAttachment {
  const filesDir = filesDirOf(dataDir);
  const id = randomUUID();
  const ext = path.extname(name);
  const filePath = path.join(filesDir, `${id}${ext}`);
  const buf = Buffer.from(base64, "base64");
  fs.writeFileSync(filePath, buf);
  return { id, name, size: buf.length, url: `/api/files/${id}${ext}` };
}

export function registerFileRoutes(app: FastifyInstance, dataDir: string) {
  const filesDir = filesDirOf(dataDir);

  app.post("/api/files/upload", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "No file" });

    const id = randomUUID();
    const ext = path.extname(data.filename);
    const filePath = path.join(filesDir, `${id}${ext}`);
    const buf = await data.toBuffer();
    fs.writeFileSync(filePath, buf);

    return { id, name: data.filename, size: buf.length, url: `/api/files/${id}${ext}` };
  });

  app.get<{ Params: { fileId: string } }>("/api/files/:fileId", async (req, reply) => {
    const filePath = path.join(filesDir, req.params.fileId);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile(req.params.fileId, filesDir);
  });
}
