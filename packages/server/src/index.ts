import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fstatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WS_EVENTS } from "@cc-pet/shared";
import type { BridgeIncoming } from "@cc-pet/shared";
import { createDatabase } from "./storage/db.js";
import { MessageStore } from "./storage/messages.js";
import { SessionStore } from "./storage/sessions.js";
import { ConfigStore } from "./storage/config.js";
import { BridgeManager } from "./bridge/manager.js";
import { ClientHub } from "./ws/hub.js";
import { registerConfigRoutes } from "./api/config.js";
import { registerSessionRoutes } from "./api/sessions.js";
import { registerHistoryRoutes } from "./api/history.js";
import { registerFileRoutes } from "./api/files.js";
import { registerMiscRoutes } from "./api/misc.js";

const PORT = parseInt(process.env.CC_PET_PORT ?? "3000", 10);
const SECRET = process.env.CC_PET_SECRET ?? "cc-pet-dev";
const DATA_DIR = process.env.CC_PET_DATA_DIR ?? "./data";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = createDatabase(DATA_DIR);
const messageStore = new MessageStore(db);
const sessionStore = new SessionStore(db);
const configStore = new ConfigStore(db);

const bridgeManager = new BridgeManager();

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(multipart);

const webDistPath = path.resolve(__dirname, "../../web/dist");
try {
  await app.register(fstatic, { root: webDistPath, prefix: "/", wildcard: false });
} catch {
  app.log.warn("Web dist not found at %s, skipping static file serving", webDistPath);
}

app.get("/api/health", async () => ({ status: "ok", timestamp: Date.now() }));
registerConfigRoutes(app, configStore);
registerSessionRoutes(app, sessionStore);
registerHistoryRoutes(app, messageStore);
registerFileRoutes(app, DATA_DIR);
registerMiscRoutes(app);

app.post<{ Params: { id: string } }>("/api/bridges/:id/connect", async (req) => {
  const cfg = configStore.load();
  const bridge = cfg.bridges.find((b) => b.id === req.params.id);
  if (!bridge) return { error: "Bridge not found" };
  bridgeManager.connect(bridge);
  return { ok: true };
});

app.post<{ Params: { id: string } }>("/api/bridges/:id/disconnect", async (req) => {
  bridgeManager.disconnect(req.params.id);
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/api/bridges/:id/status", async (req) => {
  return { connected: bridgeManager.getStatus(req.params.id) };
});

await app.listen({ port: PORT, host: "0.0.0.0" });

const hub = new ClientHub(app.server, SECRET);

bridgeManager.on("connected", (connId: string) => {
  hub.broadcast(WS_EVENTS.BRIDGE_CONNECTED, { connectionId: connId, connected: true });
});

bridgeManager.on("disconnected", (connId: string, reason: string) => {
  hub.broadcast(WS_EVENTS.BRIDGE_CONNECTED, { connectionId: connId, connected: false, reason });
});

bridgeManager.on("error", (connId: string, err: string) => {
  hub.broadcast(WS_EVENTS.BRIDGE_ERROR, { connectionId: connId, error: err });
});

bridgeManager.on("message", (connId: string, msg: BridgeIncoming) => {
  const sessionKey = "session_key" in msg ? (msg as any).session_key : undefined;

  switch (msg.type) {
    case "reply":
      messageStore.save({
        id: `msg-${Date.now()}`, role: "assistant", content: msg.content,
        timestamp: Date.now(), connectionId: connId, sessionKey,
      });
      hub.broadcast(WS_EVENTS.BRIDGE_MESSAGE, { connectionId: connId, sessionKey, content: msg.content, replyCtx: msg.reply_ctx });
      break;
    case "reply_stream":
      if (msg.done) {
        if (msg.full_text) {
          messageStore.save({
            id: `msg-${Date.now()}`, role: "assistant", content: msg.full_text,
            timestamp: Date.now(), connectionId: connId, sessionKey,
          });
        }
        hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DONE, { connectionId: connId, sessionKey, fullText: msg.full_text });
      } else {
        hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DELTA, { connectionId: connId, sessionKey, delta: msg.content });
      }
      break;
    case "buttons":
      hub.broadcast(WS_EVENTS.BRIDGE_BUTTONS, { connectionId: connId, sessionKey, content: msg.content, buttons: msg.buttons });
      break;
    case "typing_start":
      hub.broadcast(WS_EVENTS.BRIDGE_TYPING_START, { connectionId: connId, sessionKey });
      break;
    case "typing_stop":
      hub.broadcast(WS_EVENTS.BRIDGE_TYPING_STOP, { connectionId: connId, sessionKey });
      break;
    case "file":
      hub.broadcast(WS_EVENTS.BRIDGE_FILE_RECEIVED, { connectionId: connId, name: msg.name });
      break;
    case "skills_updated":
      hub.broadcast(WS_EVENTS.BRIDGE_SKILLS_UPDATED, { connectionId: connId, commands: msg.commands });
      break;
    case "preview_start":
      hub.broadcast(WS_EVENTS.BRIDGE_PREVIEW_START, { connectionId: connId, sessionKey, previewId: msg.preview_id, content: msg.content });
      break;
    case "update_message":
      hub.broadcast(WS_EVENTS.BRIDGE_PREVIEW_UPDATE, { connectionId: connId, sessionKey, previewId: msg.preview_id, content: msg.content });
      break;
    case "delete_message":
      hub.broadcast(WS_EVENTS.BRIDGE_PREVIEW_DELETE, { connectionId: connId, sessionKey, previewId: msg.preview_id });
      break;
    case "error":
      hub.broadcast(WS_EVENTS.BRIDGE_ERROR, { connectionId: connId, error: msg.message });
      break;
  }
});

hub.onMessage = (msg: any) => {
  const { type, connectionId, sessionKey, content, buttonId, customInput, fileId } = msg;
  switch (type) {
    case WS_EVENTS.SEND_MESSAGE:
      messageStore.save({
        id: `msg-${Date.now()}`, role: "user", content,
        timestamp: Date.now(), connectionId, sessionKey,
      });
      bridgeManager.send(connectionId, { type: "message", session_key: sessionKey, content });
      break;
    case WS_EVENTS.SEND_BUTTON:
      bridgeManager.send(connectionId, { type: "button_response", session_key: sessionKey, button_id: buttonId, custom_input: customInput });
      break;
    case WS_EVENTS.SEND_FILE:
      bridgeManager.send(connectionId, { type: "file", session_key: sessionKey, name: fileId, data: "" });
      break;
  }
};

const config = configStore.load();
for (const bridge of config.bridges) {
  if (bridge.enabled) bridgeManager.connect(bridge);
}

console.log(`CC Pet Server running on http://localhost:${PORT}`);
