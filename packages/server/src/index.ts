import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fstatic from "@fastify/static";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { COMMANDS_PROBE_REPLY_CTX, SKILLS_PROBE_REPLY_CTX, WS_EVENTS } from "@cc-pet/shared";
import type { BridgeIncoming, FileAttachment } from "@cc-pet/shared";
import type { SlashCommand } from "@cc-pet/shared";
import { findTokenIdentity } from "./auth/token-auth.js";
import { parseSlashCommandsFromProbeCard, parseSlashCommandsFromProbeText } from "./bridge/parse-skills-probe.js";
import { normalizeBridgeCard } from "./bridge/card-normalize.js";
import {
  bridgeFileData,
  bridgeFileName,
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
import { SessionsCleanup } from "./cleanup/sessions-cleanup.js";
import { AttachmentsCleanup } from "./cleanup/attachments-cleanup.js";
import { registerConfigRoutes } from "./api/config.js";
import { registerSessionRoutes } from "./api/sessions.js";
import { registerHistoryRoutes } from "./api/history.js";
import { registerFileRoutes, saveBase64File } from "./api/files.js";
import { registerAttachmentRoutes } from "./api/attachments.js";
import { registerMiscRoutes } from "./api/misc.js";
import { registerPetImageRoutes } from "./api/pet-images.js";
import { registerQuotaRoutes } from "./api/quota.js";
import { registerSearchRoutes } from "./api/search.js";
import { registerSiriRoutes } from "./api/siri.js";
import { registerSiriAskRoute } from "./api/siri-ask.js";
import { registerWorkspaceRoutes } from "./api/workspace.js";
import { QuotaScraper } from "./quota-scraper.js";
import { authGuard, getRequestAuthIdentity } from "./middleware/auth.js";
import { ReplyCollector } from "./siri/reply-collector.js";
import { ResidentRegistry } from "./resident/registry.js";
import { onResidentAssistantMessage } from "./resident/incoming.js";
import { ProactiveDetector } from "./resident/proactive-detector.js";
import { PushSubscriptionStore } from "./storage/push-subscriptions.js";
import { WebPushService } from "./push/web-push-service.js";
import { registerPushRoutes } from "./api/push.js";

const PORT = parseInt(process.env.CC_PET_PORT ?? "3000", 10);
const DATA_DIR = process.env.CC_PET_DATA_DIR ?? "./data";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = createDatabase(DATA_DIR);
const messageStore = new MessageStore(db);
const sessionStore = new SessionStore(db);
const configStore = new ConfigStore(db, { dataDir: DATA_DIR });
const initialConfig = configStore.load();
if (initialConfig.tokens.length === 0) {
  throw new Error(
    "No auth tokens configured. Add a non-empty `tokens` array to cc-pet.config.json (under CC_PET_DATA_DIR) or seed config via the app.",
  );
}

const bridgeManager = new BridgeManager();
const latestSkillsByConnection = new Map<string, SlashCommand[]>();
const latestProbeCommandsByConnection = new Map<
  string,
  { skills: SlashCommand[]; commands: SlashCommand[] }
>();

function mergeSlashCommands(skills: SlashCommand[], commands: SlashCommand[]): SlashCommand[] {
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const list of [skills, commands]) {
    for (const c of list) {
      const key = c.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

function setLatestProbeCommands(
  connectionId: string,
  source: "skills" | "commands",
  commands: SlashCommand[],
): SlashCommand[] {
  const prev = latestProbeCommandsByConnection.get(connectionId) ?? { skills: [], commands: [] };
  const next = source === "skills"
    ? { skills: commands, commands: prev.commands }
    : { skills: prev.skills, commands };
  latestProbeCommandsByConnection.set(connectionId, next);
  const merged = mergeSlashCommands(next.skills, next.commands);
  latestSkillsByConnection.set(connectionId, merged);
  return merged;
}

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
bridgeManager.setLogger(app.log);
const residentRegistry = new ResidentRegistry(initialConfig, app.log);
residentRegistry.bootstrap(sessionStore);
const proactiveDetector = new ProactiveDetector();
const pushSubscriptionStore = new PushSubscriptionStore(db);
const webPush = new WebPushService(pushSubscriptionStore, initialConfig.webPush, { logger: app.log });
if (!webPush.enabled) {
  app.log.warn("Web push disabled: no valid webPush config; RESIDENT push notifications will not be sent");
}
await app.register(cors, { origin: true });
await app.register(multipart);

const webDistPath = path.resolve(__dirname, "../../web/dist");
try {
  await app.register(fstatic, { root: webDistPath, prefix: "/", wildcard: false });
} catch {
  app.log.warn("Web dist not found at %s, skipping static file serving", webDistPath);
}

app.get("/api/health", async () => ({ status: "ok", timestamp: Date.now() }));
app.post<{ Body: { token?: string } }>("/api/auth/verify", async (req, reply) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const identity = findTokenIdentity(initialConfig.tokens, token);
  if (!identity) {
    reply.code(401);
    return { valid: false, error: "Invalid token" };
  }
  return { valid: true, name: identity.tokenName, bridgeIds: Array.from(identity.bridgeIds) };
});
app.addHook("onRequest", authGuard(initialConfig.tokens));
registerConfigRoutes(app, configStore);
registerSessionRoutes(app, sessionStore, messageStore);
registerPushRoutes(app, {
  store: pushSubscriptionStore,
  webPush,
  getAuthIdentity: getRequestAuthIdentity,
});
registerHistoryRoutes(app, messageStore);
registerFileRoutes(app, DATA_DIR);
registerPetImageRoutes(app);
registerMiscRoutes(app);
registerSearchRoutes(app, db);
registerWorkspaceRoutes(app, configStore);
registerAttachmentRoutes(app, configStore);
// Initialize AI quota scraper if credentials are provided
const quotaCookie = process.env.AI_QUOTA_COOKIE;
let quotaScraper: QuotaScraper | null = null;
if (quotaCookie) {
  quotaScraper = new QuotaScraper(db, quotaCookie);
  void quotaScraper.scheduleScraping(); // Start scraping service
} else {
  app.log.warn("AI quota cookie not provided via environment variable AI_QUOTA_COOKIE - skipping quota scraping service");
}
registerQuotaRoutes(app, { db, scraper: quotaScraper });

/** 从 hass-agent/.env 读 HA 地址和令牌，供快通道直连 HA。读不到就返回 undefined（退化成全部走模型）。 */
function siriFastPath(dir: string) {
  try {
    const env = Object.fromEntries(
      readFileSync(path.join(dir, ".env"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")];
        }),
    );
    if (!env.HA_URL || !env.HA_TOKEN) return undefined;
    return { dir, haUrl: env.HA_URL, haToken: env.HA_TOKEN };
  } catch {
    return undefined;
  }
}

const replyCollector = new ReplyCollector();
registerSiriRoutes(app, {
  bridgeManager,
  messageStore,
  replyCollector,
  getAuthIdentity: getRequestAuthIdentity,
  getDefaultConnectionId: (bridgeIds) => [...bridgeIds][0],
  onUserSend: (connectionId, sessionKey) => {
    if (residentRegistry.isResident(connectionId, sessionKey)) {
      proactiveDetector.markUserSend(connectionId, sessionKey);
    }
  },
});

// Siri 走的同步通道：直接 spawn claude 跑受限的家居助手会话，一次请求拿到答案，
// 快捷指令那边不用写轮询循环。超时的活转交常驻会话（见 siri-ask.ts）。
registerSiriAskRoute(app, {
  bridgeManager,
  messageStore,
  residentRegistry,
  getAuthIdentity: getRequestAuthIdentity,
  claude: {
    bin: process.env.SIRI_CLAUDE_BIN ?? "claude",
    cwd: process.env.SIRI_CLAUDE_CWD ?? "/code/hass-agent",
    model: process.env.SIRI_CLAUDE_MODEL ?? "claude-haiku-4-5",
    // 这轮整体跑多久算超时（超了转交第二大脑），不是 HTTP 响应时间
    timeoutMs: Number(process.env.SIRI_CLAUDE_TIMEOUT_MS ?? 90_000),
  },
  // 同步等这么久还没结果就改发 pollId。iOS 的「获取 URL 内容」超过 25 秒会报错，
  // 而实测一轮家居查询要 15～25 秒，所以这里取 10 秒留足余量。
  handoffMs: Number(process.env.SIRI_ASK_HANDOFF_MS ?? 10_000),
  // 快通道：开关灯这类确定性动作直接查表调 HA，不过模型。HA 的地址和令牌复用
  // hass-agent/.env（那份 HA 长期令牌本来就是给这个工作目录用的）。
  fastPath: siriFastPath(process.env.SIRI_CLAUDE_CWD ?? "/code/hass-agent"),
});

app.post<{ Params: { id: string } }>("/api/bridges/:id/connect", async (req, reply) => {
  const auth = getRequestAuthIdentity(req);
  if (!auth?.bridgeIds.has(req.params.id)) return reply.code(403).send({ error: "Forbidden" });
  const cfg = configStore.load();
  const bridge = cfg.bridges.find((b) => b.id === req.params.id);
  if (!bridge) return { error: "Bridge not found" };
  app.log.info({ bridgeId: req.params.id, host: bridge.host, port: bridge.port }, "Bridge connect requested");
  bridgeManager.connect(bridge);
  return { ok: true };
});

app.post<{ Params: { id: string } }>("/api/bridges/:id/disconnect", async (req, reply) => {
  const auth = getRequestAuthIdentity(req);
  if (!auth?.bridgeIds.has(req.params.id)) return reply.code(403).send({ error: "Forbidden" });
  app.log.info({ bridgeId: req.params.id }, "Bridge disconnect requested");
  bridgeManager.disconnect(req.params.id);
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/api/bridges/:id/status", async (req, reply) => {
  const auth = getRequestAuthIdentity(req);
  if (!auth?.bridgeIds.has(req.params.id)) return reply.code(403).send({ error: "Forbidden" });
  const connected = bridgeManager.getStatus(req.params.id);
  app.log.debug({ bridgeId: req.params.id, connected }, "Bridge status queried");
  return { connected };
});

await app.listen({ port: PORT, host: "0.0.0.0" });

const hub = new ClientHub(app.server, initialConfig.tokens, app.log);
hub.onClientConnected = (client, send) => {
  const cfg = configStore.load();
  const allowedBridges = cfg.bridges.filter((b) => client.auth.bridgeIds.has(b.id));
  app.log.info(
    { tokenName: client.auth.tokenName, bridges: allowedBridges.length },
    "Syncing bridge manifest and status to new dashboard websocket client",
  );
  send(WS_EVENTS.BRIDGE_MANIFEST, {
    // `attachmentStaging` tells the dashboard whether it may stream attachments to disk
    // for this bridge. Without a configured workspace there is no shared directory the
    // agent could read from, so those connections keep the base64 WebSocket fallback.
    bridges: allowedBridges.map((b) => ({
      id: b.id,
      name: b.name,
      attachmentStaging: typeof b.workspacePath === "string" && b.workspacePath.trim().length > 0,
    })),
  });
  for (const bridge of allowedBridges) {
    send(WS_EVENTS.BRIDGE_CONNECTED, {
      connectionId: bridge.id,
      connected: bridgeManager.getStatus(bridge.id),
    });
    const commands = latestSkillsByConnection.get(bridge.id);
    if (commands && commands.length > 0) {
      send(WS_EVENTS.BRIDGE_SKILLS_UPDATED, {
        connectionId: bridge.id,
        commands,
      });
    }
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

bridgeManager.on("skillsProbe", (connId: string, event: Record<string, unknown>) => {
  app.log.info({ connectionId: connId, ...event }, "Bridge skills probe event");
});

/** Frame types that carry chat content: without a session_key the dashboard has to guess a target session. */
const CONTENT_BEARING_BRIDGE_TYPES = new Set([
  "reply",
  "reply_stream",
  "card",
  "file",
  "buttons",
  "audio",
  "preview_start",
  "update_message",
]);

bridgeManager.on("message", (connId: string, msg: BridgeIncoming) => {
  const raw = msg as unknown as Record<string, unknown>;
  const sessionKey = bridgeSessionKey(raw);
  if (!sessionKey && CONTENT_BEARING_BRIDGE_TYPES.has(msg.type)) {
    // The dashboard falls back to its sticky/active session for these, which is
    // how content from one conversation can surface in another. Logged so such a
    // leak is diagnosable after the fact instead of only being visible client-side.
    app.log.warn(
      { connectionId: connId, type: msg.type },
      "Bridge content frame carries no session_key — dashboard must guess the target session",
    );
  }

  const bumpResidentUnread = (contentPreview: string): void => {
    if (!sessionKey) return;
    const r = onResidentAssistantMessage({ registry: residentRegistry, sessionStore }, connId, sessionKey);
    if (!r) return;
    hub.broadcast(WS_EVENTS.RESIDENT_UNREAD, {
      connectionId: connId,
      sessionKey,
      unreadCount: r.unreadCount,
    });
    if (r.ownerToken && proactiveDetector.isProactive(connId, sessionKey)) {
      const label = residentRegistry.pairs().find((p) => p.connectionId === connId && p.key === sessionKey)?.label;
      void webPush.sendToToken(r.ownerToken, {
        title: label ? `常驻助手 · ${label}` : "常驻助手",
        body: contentPreview.slice(0, 120) || "有新的主动消息",
        data: { connectionId: connId, sessionKey },
      });
    }
  };

  switch (msg.type) {
    case "register_ack":
      app.log.info({ connectionId: connId, ok: msg.ok, error: msg.error }, "Bridge register acknowledged");
      break;
    case "reply": {
      const replyCtx = bridgeReplyCtx(raw);
      if (replyCtx === SKILLS_PROBE_REPLY_CTX || replyCtx === COMMANDS_PROBE_REPLY_CTX) {
        const probeSource = replyCtx === SKILLS_PROBE_REPLY_CTX ? "skills" : "commands";
        const commands = parseSlashCommandsFromProbeText(bridgeReplyTextContent(raw));
        const merged = setLatestProbeCommands(connId, probeSource, commands);
        app.log.info(
          {
            connectionId: connId,
            probe: probeSource,
            commands: commands.length,
            merged: merged.length,
            preview: merged.slice(0, 8).map((c) => c.name),
          },
          "Bridge slash probe parsed commands",
        );
        hub.broadcast(WS_EVENTS.BRIDGE_SKILLS_UPDATED, { connectionId: connId, commands: merged });
        break;
      }
      const replyContent = bridgeReplyTextContent(raw);
      const replyMsgId = `msg-${randomUUID()}`;
      const replySeq = messageStore.save({
        id: replyMsgId, role: "assistant", content: replyContent,
        timestamp: Date.now(), connectionId: connId, sessionKey,
      });
      bumpResidentUnread(replyContent);
      hub.broadcast(WS_EVENTS.BRIDGE_MESSAGE, {
        connectionId: connId,
        sessionKey,
        content: replyContent,
        replyCtx: replyCtx || undefined,
        msgId: replyMsgId,
        seq: replySeq,
      });
      replyCollector.onReply(connId, sessionKey ?? "default", replyContent);
      break;
    }
    case "reply_stream": {
      const replyCtx = bridgeReplyCtx(raw);
      if (replyCtx === SKILLS_PROBE_REPLY_CTX || replyCtx === COMMANDS_PROBE_REPLY_CTX) {
        if (bridgeReplyStreamDone(raw)) {
          const full = extractReplyStreamFullText(raw);
          if (full) {
            const probeSource = replyCtx === SKILLS_PROBE_REPLY_CTX ? "skills" : "commands";
            const commands = parseSlashCommandsFromProbeText(full);
            const merged = setLatestProbeCommands(connId, probeSource, commands);
            app.log.info(
              {
                connectionId: connId,
                probe: probeSource,
                commands: commands.length,
                merged: merged.length,
                preview: merged.slice(0, 8).map((c) => c.name),
              },
              "Bridge slash probe parsed stream commands",
            );
            hub.broadcast(WS_EVENTS.BRIDGE_SKILLS_UPDATED, { connectionId: connId, commands: merged });
          } else {
            app.log.warn({ connectionId: connId }, "Bridge slash probe stream done without full_text");
          }
        }
        break;
      }
      if (bridgeReplyStreamDone(raw)) {
        const fullText = extractReplyStreamFullText(raw);
        let doneMsgId: string | undefined;
        let doneSeq: number | undefined;
        if (fullText) {
          doneMsgId = `msg-${randomUUID()}`;
          doneSeq = messageStore.save({
            id: doneMsgId, role: "assistant", content: fullText,
            timestamp: Date.now(), connectionId: connId, sessionKey,
          });
          bumpResidentUnread(fullText ?? "");
        }
        hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DONE, { connectionId: connId, sessionKey, fullText, msgId: doneMsgId, seq: doneSeq });
        replyCollector.onDone(connId, sessionKey ?? "default", fullText);
      } else {
        const delta = extractReplyStreamChunk(raw) ?? (typeof raw.content === "string" ? raw.content : undefined);
        hub.broadcast(WS_EVENTS.BRIDGE_STREAM_DELTA, { connectionId: connId, sessionKey, delta });
        if (delta) replyCollector.onDelta(connId, sessionKey ?? "default", delta);
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
    case "file": {
      // Bridge `file` frames carry the payload as base64; field names vary across
      // cc-connect versions, so resolve name/data defensively. Persist to the shared
      // files store so the dashboard gets a downloadable URL, falling back to a
      // name-only chip if the payload is missing/undecodable.
      const fileName = bridgeFileName(raw) ?? "file";
      const fileData = bridgeFileData(raw);
      app.log.info(
        { connectionId: connId, fileName, hasData: !!fileData },
        "Bridge file frame received",
      );
      let attachment: FileAttachment = { id: `file-${randomUUID()}`, name: fileName, size: 0 };
      if (fileData) {
        try {
          attachment = saveBase64File(DATA_DIR, fileName, fileData);
        } catch (err) {
          app.log.error({ err, connectionId: connId, name: fileName }, "Failed to persist bridge file attachment");
        }
      }
      const fileMsgId = `msg-${randomUUID()}`;
      const fileReceivedSeq = messageStore.save({
        id: fileMsgId,
        role: "assistant",
        content: fileName,
        files: [attachment],
        timestamp: Date.now(),
        connectionId: connId,
        sessionKey,
      });
      bumpResidentUnread(fileName);
      hub.broadcast(WS_EVENTS.BRIDGE_FILE_RECEIVED, {
        connectionId: connId, sessionKey, name: fileName, file: attachment,
        msgId: fileMsgId, seq: fileReceivedSeq,
      });
      break;
    }
    case "card":
      const cardReplyCtx = bridgeReplyCtx(raw);
      if (cardReplyCtx === SKILLS_PROBE_REPLY_CTX || cardReplyCtx === COMMANDS_PROBE_REPLY_CTX) {
        const probeSource = cardReplyCtx === SKILLS_PROBE_REPLY_CTX ? "skills" : "commands";
        const commands = parseSlashCommandsFromProbeCard(msg.card);
        const merged = setLatestProbeCommands(connId, probeSource, commands);
        app.log.info(
          {
            connectionId: connId,
            probe: probeSource,
            commands: commands.length,
            merged: merged.length,
            preview: merged.slice(0, 8).map((c) => c.name),
          },
          "Bridge slash probe parsed card commands",
        );
        hub.broadcast(WS_EVENTS.BRIDGE_SKILLS_UPDATED, { connectionId: connId, commands: merged });
        break;
      }
      const normalizedCard = msg.card ? normalizeBridgeCard(msg.card) : undefined;
      const cardMsgId = `msg-${randomUUID()}`;
      const cardSeq = messageStore.save({
        id: cardMsgId, role: "assistant",
        content: msg.card?.header?.title ?? "",
        card: normalizedCard,
        timestamp: Date.now(), connectionId: connId, sessionKey,
      });
      bumpResidentUnread(msg.card?.header?.title ?? "");
      hub.broadcast(WS_EVENTS.BRIDGE_CARD, {
        connectionId: connId, sessionKey, card: normalizedCard, msgId: cardMsgId, seq: cardSeq,
      });
      break;
    case "audio": {
      const audioMsgId = `msg-${randomUUID()}`;
      const audioSeq = messageStore.save({
        id: audioMsgId, role: "assistant",
        content: "[音频消息]",
        timestamp: Date.now(), connectionId: connId, sessionKey,
      });
      hub.broadcast(WS_EVENTS.BRIDGE_AUDIO, {
        connectionId: connId, sessionKey, data: msg.data, format: msg.format ?? "mp3", msgId: audioMsgId, seq: audioSeq,
      });
      break;
    }
    case "skills_updated":
      latestSkillsByConnection.set(connId, msg.commands);
      hub.broadcast(WS_EVENTS.BRIDGE_SKILLS_UPDATED, { connectionId: connId, commands: msg.commands });
      break;
    case "preview_start":
    case "update_message":
    case "delete_message": {
      // cc-connect pushes a live-updating progress card (tool steps) through the
      // preview channel. It sends ref_id (preview_start) / preview_handle
      // (update/delete) rather than a stable "preview_id"; correlating those is
      // brittle, and there is at most one progress card per session at a time,
      // so we key by session. The frontend renders progress-like content (tool
      // steps) and ignores text previews (the final reply carries the text).
      const previewId = `pv-${connId}-${sessionKey ?? "default"}`;
      const evt =
        msg.type === "preview_start"
          ? WS_EVENTS.BRIDGE_PREVIEW_START
          : msg.type === "update_message"
            ? WS_EVENTS.BRIDGE_PREVIEW_UPDATE
            : WS_EVENTS.BRIDGE_PREVIEW_DELETE;
      const content = msg.type === "delete_message" ? undefined : msg.content;
      hub.broadcast(evt, { connectionId: connId, sessionKey, previewId, content });
      break;
    }
    case "error":
      hub.broadcast(WS_EVENTS.BRIDGE_ERROR, { connectionId: connId, error: msg.message });
      break;
  }
});

hub.onMessage = (msg: any, client) => {
  const { type, connectionId, sessionKey, content, buttonId, customInput, fileId, name, data, mimeType, files, clientMsgId } = msg;
  if (typeof connectionId === "string" && connectionId.length > 0 && !client.auth.bridgeIds.has(connectionId)) {
    app.log.warn(
      { tokenName: client.auth.tokenName, connectionId, eventType: type },
      "Rejected dashboard websocket event: unauthorized bridge",
    );
    return;
  }
  switch (type) {
    case WS_EVENTS.SEND_MESSAGE: {
      const msgId = typeof clientMsgId === "string" && clientMsgId.length > 0
        ? clientMsgId
        : `msg-${randomUUID()}`;
      app.log.info(
        {
          connectionId,
          sessionKey,
          contentLength: typeof content === "string" ? content.length : 0,
          msgId,
          clientMsgId,
        },
        "Dashboard sent message"
      );
      const { seq, inserted } = messageStore.saveWithStatus({
        id: msgId, role: "user", content,
        timestamp: Date.now(), connectionId, sessionKey,
      });
      // Ack even on a resend: the client is retrying because it never saw the
      // first ack, and it needs one to clear its outbox entry.
      if (typeof clientMsgId === "string" && clientMsgId.length > 0) {
        hub.broadcast(WS_EVENTS.MESSAGE_ACK, {
          connectionId, sessionKey, clientMsgId, id: msgId, seq,
        });
      }
      if (!inserted) {
        app.log.info({ connectionId, sessionKey, msgId }, "Skipped bridge forward for already-known message id");
        break;
      }
      bridgeManager.send(connectionId, {
        type: "message",
        msg_id: msgId,
        session_key: sessionKey,
        user_id: connectionId,
        user_name: "cc-pet-user",
        reply_ctx: sessionKey,
        content,
      });
      if (residentRegistry.isResident(connectionId, sessionKey)) {
        proactiveDetector.markUserSend(connectionId, sessionKey);
      }
      break;
    }
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
    case WS_EVENTS.SEND_FILE: {
      const caption = typeof content === "string" ? content : "";

      // Staged attachments: already streamed to disk inside the connection's workspace,
      // so only their paths travel over the bridge. Phrased exactly like cc-connect's
      // own file handoff so agents treat both channels identically.
      const stagedFiles = Array.isArray(files)
        ? files.filter((file: any) => typeof file?.agent_path === "string" && file.agent_path.length > 0)
        : [];
      if (stagedFiles.length > 0) {
        const paths = stagedFiles.map((file: any) => String(file.agent_path));
        const notice = `(Files saved locally, please read them: ${paths.join(", ")})`;
        app.log.info(
          { connectionId, sessionKey, files: paths.length },
          "Dashboard sent staged attachment paths",
        );
        // The row id MUST be the clientMsgId, exactly as the base64 path does. Two
        // things depend on it: the ack that clears the sender's outbox entry, and
        // saveWithStatus's dedupe — which is what stops a replayed entry from being
        // forwarded to the agent a second time. Generating a fresh `msg-${Date.now()}`
        // here broke both: nothing ever acked, so the entry stayed pending in
        // localStorage and every page reload re-delivered the same attachment.
        const stagedMsgId = typeof clientMsgId === "string" && clientMsgId.length > 0
          ? clientMsgId
          : `msg-${randomUUID()}`;
        const { seq: stagedSeq, inserted: stagedInserted } = messageStore.saveWithStatus({
          id: stagedMsgId,
          role: "user",
          content: caption,
          files: stagedFiles.map((file: any) => ({
            id: `file-${randomUUID()}-${String(file.file_name ?? "attachment")}`,
            name: String(file.file_name ?? "attachment"),
            size: Number.isFinite(file?.size) ? Number(file.size) : 0,
          })),
          timestamp: Date.now(),
          connectionId,
          sessionKey,
        });
        // Ack even on a resend: the client is retrying precisely because it never saw
        // the first ack, and it needs one to clear its outbox entry.
        if (typeof clientMsgId === "string" && clientMsgId.length > 0) {
          hub.broadcast(WS_EVENTS.MESSAGE_ACK, {
            connectionId, sessionKey, clientMsgId, id: stagedMsgId, seq: stagedSeq,
          });
        }
        if (!stagedInserted) {
          app.log.info(
            { connectionId, sessionKey, msgId: stagedMsgId },
            "Skipped bridge forward for already-known staged attachment message id",
          );
          break;
        }
        bridgeManager.send(connectionId, {
          type: "message",
          msg_id: `msg-file-${randomUUID()}`,
          session_key: sessionKey,
          user_id: connectionId,
          user_name: "cc-pet-user",
          reply_ctx: sessionKey,
          content: caption ? `${caption}\n\n${notice}` : notice,
        });
        break;
      }

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
      app.log.info({ connectionId, sessionKey, files: normalizedFiles.length, clientMsgId }, "Dashboard sent file");
      const fileMsgId = typeof clientMsgId === "string" && clientMsgId.length > 0
        ? clientMsgId
        : `msg-${randomUUID()}`;
      const { seq: fileSeq, inserted: fileInserted } = messageStore.saveWithStatus({
        id: fileMsgId,
        role: "user",
        content: caption,
        files: normalizedFiles.map((file) => ({
          id: `file-${randomUUID()}-${file.file_name}`,
          name: file.file_name,
          // base64 length → decoded byte count; the old hardcoded 0 made every
          // historical attachment render as an empty file.
          size: Math.floor((file.data.length * 3) / 4),
        })),
        timestamp: Date.now(),
        connectionId,
        sessionKey,
      });
      if (typeof clientMsgId === "string" && clientMsgId.length > 0) {
        hub.broadcast(WS_EVENTS.MESSAGE_ACK, {
          connectionId, sessionKey, clientMsgId, id: fileMsgId, seq: fileSeq,
        });
      }
      if (!fileInserted) {
        app.log.info({ connectionId, sessionKey, msgId: fileMsgId }, "Skipped bridge forward for already-known file message id");
        break;
      }
      bridgeManager.send(connectionId, {
        type: "message",
        msg_id: `msg-file-${randomUUID()}`,
        session_key: sessionKey,
        user_id: connectionId,
        user_name: "cc-pet-user",
        reply_ctx: sessionKey,
        content: caption,
        files: normalizedFiles,
      });
      break;
    }
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

// 启动会话清理定时任务，每天清理10天没有交互的会话
const sessionsCleanup = new SessionsCleanup(sessionStore, db);
sessionsCleanup.startCleanupSchedule(10);

// Staged attachments are never removed by the send path, so the staging directory grows
// without bound. Read bridges fresh on each sweep so a config change takes effect
// without a restart. Note this also prunes files cc-connect staged there itself.
const attachmentsCleanup = new AttachmentsCleanup(() => configStore.load().bridges, app.log);
attachmentsCleanup.startCleanupSchedule(30);

console.log(`CC Pet Server running on http://localhost:${PORT}`);
