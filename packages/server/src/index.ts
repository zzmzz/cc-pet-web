import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fstatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_PROBE_REPLY_CTX, WS_EVENTS } from "@cc-pet/shared";
import type { BridgeIncoming } from "@cc-pet/shared";
import { parseSkillCommandsFromSkillsText } from "./bridge/parse-skills-probe.js";
import {
  bridgeReplyCtx,
  bridgeReplyStreamDone,
  bridgeReplyTextContent,
  bridgeSessionKey,
  extractReplyStreamChunk,
  extractReplyStreamFullText,
} from "./bridge/incoming-fields.js";
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
const SECRET = process.env.CC_PET_SECRET ?? "";
const DATA_DIR = process.env.CC_PET_DATA_DIR ?? "./data";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = createDatabase(DATA_DIR);
const messageStore = new MessageStore(db);
const sessionStore = new SessionStore(db);
const configStore = new ConfigStore(db, { dataDir: DATA_DIR });

const bridgeManager = new BridgeManager();

/** 本地/非 production 默认人类可读；生产保留 JSON 便于采集。可设 CC_PET_LOG_PRETTY=0 强制 JSON，或 =1 强制美化。 */
const usePrettyLog =
  process.env.CC_PET_LOG_PRETTY === "1" ||
  (process.env.NODE_ENV !== "production" && process.env.CC_PET_LOG_PRETTY !== "0");

const app = Fastify({
  logger: usePrettyLog
    ? {
        level: process.env.LOG_LEVEL ?? "info",
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
      }
    : { level: process.env.LOG_LEVEL ?? "info" },
});
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
  app.log.info({ bridgeId: req.params.id, host: bridge.host, port: bridge.port }, "Bridge connect requested");
  bridgeManager.connect(bridge);
  return { ok: true };
});

app.post<{ Params: { id: string } }>("/api/bridges/:id/disconnect", async (req) => {
  app.log.info({ bridgeId: req.params.id }, "Bridge disconnect requested");
  bridgeManager.disconnect(req.params.id);
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/api/bridges/:id/status", async (req) => {
  const connected = bridgeManager.getStatus(req.params.id);
  app.log.debug({ bridgeId: req.params.id, connected }, "Bridge status queried");
  return { connected };
});

await app.listen({ port: PORT, host: "0.0.0.0" });

const hub = new ClientHub(app.server, SECRET, app.log);
hub.onClientConnected = (send) => {
  const cfg = configStore.load();
  app.log.info({ bridges: cfg.bridges.length }, "Syncing bridge manifest and status to new dashboard websocket client");
  send(WS_EVENTS.BRIDGE_MANIFEST, {
    bridges: cfg.bridges.map((b) => ({ id: b.id, name: b.name })),
  });
  for (const bridge of cfg.bridges) {
    send(WS_EVENTS.BRIDGE_CONNECTED, {
      connectionId: bridge.id,
      connected: bridgeManager.getStatus(bridge.id),
    });
  }
};

bridgeManager.on("connected", (connId: string) => {
  app.log.info({ connectionId: connId }, "Bridge connected");
  hub.broadcast(WS_EVENTS.BRIDGE_CONNECTED, { connectionId: connId, connected: true });
});

bridgeManager.on("disconnected", (connId: string, reason: string) => {
  app.log.warn({ connectionId: connId, reason }, "Bridge disconnected");
  hub.broadcast(WS_EVENTS.BRIDGE_CONNECTED, { connectionId: connId, connected: false, reason });
  hub.broadcast(WS_EVENTS.BRIDGE_ERROR, {
    connectionId: connId,
    error: `Bridge disconnected: ${reason || "unknown reason"}`,
  });
});

bridgeManager.on("error", (connId: string, err: string) => {
  app.log.error({ connectionId: connId, error: err }, "Bridge runtime error");
  hub.broadcast(WS_EVENTS.BRIDGE_ERROR, { connectionId: connId, error: err });
});

bridgeManager.on("message", (connId: string, msg: BridgeIncoming) => {
  const raw = msg as unknown as Record<string, unknown>;
  const sessionKey = bridgeSessionKey(raw);
  app.log.debug({ connectionId: connId, sessionKey, bridgeMessageType: msg.type }, "Received message from bridge");

  switch (msg.type) {
    case "register_ack":
      app.log.info({ connectionId: connId, ok: msg.ok, error: msg.error }, "Bridge register acknowledged");
      break;
    case "reply": {
      const replyCtx = bridgeReplyCtx(raw);
      if (replyCtx === SKILLS_PROBE_REPLY_CTX) {
        const commands = parseSkillCommandsFromSkillsText(bridgeReplyTextContent(raw));
        hub.broadcast(WS_EVENTS.BRIDGE_SKILLS_UPDATED, { connectionId: connId, commands });
        break;
      }
      const replyContent = bridgeReplyTextContent(raw);
      messageStore.save({
        id: `msg-${Date.now()}`, role: "assistant", content: replyContent,
        timestamp: Date.now(), connectionId: connId, sessionKey,
      });
      hub.broadcast(WS_EVENTS.BRIDGE_MESSAGE, {
        connectionId: connId,
        sessionKey,
        content: replyContent,
        replyCtx: replyCtx || undefined,
      });
      break;
    }
    case "reply_stream": {
      const replyCtx = bridgeReplyCtx(raw);
      if (replyCtx === SKILLS_PROBE_REPLY_CTX) {
        if (bridgeReplyStreamDone(raw)) {
          const full = extractReplyStreamFullText(raw);
          if (full) {
            const commands = parseSkillCommandsFromSkillsText(full);
            hub.broadcast(WS_EVENTS.BRIDGE_SKILLS_UPDATED, { connectionId: connId, commands });
          }
        }
        break;
      }
      if (bridgeReplyStreamDone(raw)) {
        const fullText = extractReplyStreamFullText(raw);
        if (fullText) {
          messageStore.save({
            id: `msg-${Date.now()}`, role: "assistant", content: fullText,
            timestamp: Date.now(), connectionId: connId, sessionKey,
          });
        }
        hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DONE, { connectionId: connId, sessionKey, fullText });
      } else {
        const delta = extractReplyStreamChunk(raw) ?? (typeof raw.content === "string" ? raw.content : undefined);
        hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DELTA, { connectionId: connId, sessionKey, delta });
      }
      break;
    }
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
      messageStore.save({
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: msg.name,
        files: [{ id: `file-${Date.now()}`, name: msg.name, size: 0 }],
        timestamp: Date.now(),
        connectionId: connId,
        sessionKey,
      });
      hub.broadcast(WS_EVENTS.BRIDGE_FILE_RECEIVED, { connectionId: connId, sessionKey, name: msg.name });
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
  const { type, connectionId, sessionKey, content, buttonId, customInput, fileId, name, data, mimeType, files } = msg;
  switch (type) {
    case WS_EVENTS.SEND_MESSAGE:
      const msgId = `msg-${Date.now()}`;
      app.log.info(
        {
          connectionId,
          sessionKey,
          contentLength: typeof content === "string" ? content.length : 0,
          msgId,
        },
        "Dashboard sent message"
      );
      messageStore.save({
        id: msgId, role: "user", content,
        timestamp: Date.now(), connectionId, sessionKey,
      });
      bridgeManager.send(connectionId, {
        type: "message",
        msg_id: msgId,
        session_key: sessionKey,
        user_id: connectionId,
        user_name: "cc-pet-user",
        reply_ctx: sessionKey,
        content,
      });
      break;
    case WS_EVENTS.SEND_BUTTON:
      app.log.info({ connectionId, sessionKey, buttonId }, "Dashboard sent button response");
      bridgeManager.send(connectionId, {
        type: "button_response",
        session_key: sessionKey,
        button_id: buttonId,
        custom_input: customInput,
        reply_ctx: sessionKey,
      });
      break;
    case WS_EVENTS.SEND_FILE:
      const caption = typeof content === "string" ? content : "";
      const rawFiles = Array.isArray(files)
        ? files
        : [{
            file_name: String(name ?? fileId ?? "unknown-file"),
            mime_type: typeof mimeType === "string" && mimeType.trim().length > 0
              ? mimeType
              : "application/octet-stream",
            data: typeof data === "string" ? data : "",
          }];
      const normalizedFiles = rawFiles
        .map((file: any) => ({
          file_name: String(file?.file_name ?? "unknown-file"),
          mime_type: typeof file?.mime_type === "string" && file.mime_type.trim().length > 0
            ? file.mime_type
            : "application/octet-stream",
          data: typeof file?.data === "string" ? file.data : "",
        }))
        .filter((file) => file.data.length > 0);
      if (normalizedFiles.length === 0) {
        app.log.warn({ connectionId, sessionKey }, "Dashboard sent file event with empty payload");
        break;
      }
      app.log.info({ connectionId, sessionKey, files: normalizedFiles.length }, "Dashboard sent file");
      messageStore.save({
        id: `msg-${Date.now()}`,
        role: "user",
        content: caption,
        files: normalizedFiles.map((file) => ({
          id: `file-${Date.now()}-${file.file_name}`,
          name: file.file_name,
          size: 0,
        })),
        timestamp: Date.now(),
        connectionId,
        sessionKey,
      });
      bridgeManager.send(connectionId, {
        type: "message",
        msg_id: `msg-file-${Date.now()}`,
        session_key: sessionKey,
        user_id: connectionId,
        user_name: "cc-pet-user",
        reply_ctx: sessionKey,
        content: caption,
        files: normalizedFiles,
      });
      break;
    default:
      app.log.warn({ type, connectionId, sessionKey }, "Unsupported dashboard websocket event");
      break;
  }
};

const config = configStore.load();
for (const bridge of config.bridges) {
  if (bridge.enabled) {
    app.log.info({ bridgeId: bridge.id, host: bridge.host, port: bridge.port }, "Auto connecting enabled bridge");
    bridgeManager.connect(bridge);
  }
}

console.log(`CC Pet Server running on http://localhost:${PORT}`);
