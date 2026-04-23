import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tester = net.createServer();
    tester.once("error", reject);
    tester.listen(0, "127.0.0.1", () => {
      const address = tester.address();
      if (!address || typeof address === "string") {
        tester.close();
        reject(new Error("failed to allocate test port"));
        return;
      }
      tester.close((err) => {
        if (err) reject(err);
        else resolve(address.port);
      });
    });
  });
}

async function startServer() {
  const serverPort = await getFreePort();
  const dashboardToken = "e2e-delete-token";
  const connectionId = "test-conn";
  const dataDir = await mkdtemp(path.join(tmpdir(), "cc-pet-e2e-del-"));

  const configPath = path.join(dataDir, "cc-pet.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      bridges: [],
      tokens: [{ token: dashboardToken, name: "e2e", bridgeIds: [connectionId] }],
      pet: { opacity: 1, size: 120 },
      server: { port: serverPort, dataDir: "./data" },
    }),
    "utf8",
  );

  const serverProcess = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      CC_PET_PORT: String(serverPort),
      CC_PET_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  serverProcess.stdout.on("data", () => {});
  serverProcess.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/health`, {
        headers: { Authorization: `Bearer ${dashboardToken}` },
      });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const authHeader = { Authorization: `Bearer ${dashboardToken}` };
  const jsonHeaders = { ...authHeader, "Content-Type": "application/json" };

  const api = {
    async createSession(key: string) {
      return fetch(`http://127.0.0.1:${serverPort}/api/sessions`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ connectionId, key }),
      });
    },
    async listSessions() {
      const res = await fetch(
        `http://127.0.0.1:${serverPort}/api/sessions?connectionId=${encodeURIComponent(connectionId)}`,
        { headers: authHeader },
      );
      return (await res.json()) as { sessions: Array<{ key: string }> };
    },
    async deleteSession(key: string) {
      return fetch(
        `http://127.0.0.1:${serverPort}/api/sessions/${encodeURIComponent(connectionId)}/${encodeURIComponent(key)}`,
        { method: "DELETE", headers: authHeader },
      );
    },
    async getHistory(sessionKey: string) {
      const chatKey = encodeURIComponent(`${connectionId}::${sessionKey}`);
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/history/${chatKey}`, { headers: authHeader });
      return (await res.json()) as { messages: Array<{ role: string; content: string }> };
    },
  };

  const stop = async () => {
    serverProcess.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      serverProcess.once("exit", () => resolve());
      setTimeout(() => resolve(), 2_000);
    });
    await rm(dataDir, { recursive: true, force: true });
    if (stderr.includes("EADDRINUSE")) {
      throw new Error(`server port conflict during test\n${stderr}`);
    }
  };

  return { api, stop, connectionId };
}

describe("e2e session deletion", () => {
  it("DELETE /api/sessions/:connectionId/:key removes the session", async () => {
    const { api, stop } = await startServer();

    try {
      // Create two sessions
      const r1 = await api.createSession("sess-1");
      expect(r1.status).toBe(200);
      const r2 = await api.createSession("sess-2");
      expect(r2.status).toBe(200);

      // Verify both exist
      const before = await api.listSessions();
      expect(before.sessions.map((s) => s.key).sort()).toEqual(["sess-1", "sess-2"]);

      // Delete sess-1
      const delRes = await api.deleteSession("sess-1");
      const delBody = await delRes.text();
      console.log("DELETE status:", delRes.status, "body:", delBody);
      expect(delRes.status).toBe(200);

      // Verify only sess-2 remains
      const after = await api.listSessions();
      console.log("sessions after delete:", JSON.stringify(after.sessions));
      expect(after.sessions.map((s) => s.key)).toEqual(["sess-2"]);
    } finally {
      await stop();
    }
  }, 30_000);

  it("DELETE also removes associated messages from history", async () => {
    const { api, stop } = await startServer();

    try {
      await api.createSession("with-msgs");

      // Directly check that history is empty initially
      const histBefore = await api.getHistory("with-msgs");
      expect(histBefore.messages).toHaveLength(0);

      // Delete the session
      const delRes = await api.deleteSession("with-msgs");
      expect(delRes.status).toBe(200);

      // Session should be gone
      const sessions = await api.listSessions();
      expect(sessions.sessions.find((s) => s.key === "with-msgs")).toBeUndefined();

      // History should also be empty (no orphan messages to resurrect)
      const histAfter = await api.getHistory("with-msgs");
      expect(histAfter.messages).toHaveLength(0);
    } finally {
      await stop();
    }
  }, 30_000);
});
