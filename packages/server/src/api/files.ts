import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function registerFileRoutes(app: FastifyInstance, dataDir: string) {
  const filesDir = path.join(dataDir, "files");
  fs.mkdirSync(filesDir, { recursive: true });

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
