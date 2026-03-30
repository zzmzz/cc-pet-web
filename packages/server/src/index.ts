import Fastify from "fastify";
import cors from "@fastify/cors";

const PORT = parseInt(process.env.CC_PET_PORT ?? "3000", 10);

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

app.get("/api/health", async () => ({ status: "ok", timestamp: Date.now() }));

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`CC Pet Server running on http://localhost:${PORT}`);
