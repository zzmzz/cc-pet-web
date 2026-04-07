export const WS_EVENTS = {
  /** Server → dashboard: fixed bridge list from backend config (no REST config API). */
  BRIDGE_MANIFEST: "bridge:manifest",
  BRIDGE_CONNECTED: "bridge:connected",
  BRIDGE_ERROR: "bridge:error",
  BRIDGE_MESSAGE: "bridge:message",
  BRIDGE_STREAM_DELTA: "bridge:stream-delta",
  BRIDGE_STREAM_DONE: "bridge:stream-done",
  BRIDGE_BUTTONS: "bridge:buttons",
  BRIDGE_TYPING_START: "bridge:typing-start",
  BRIDGE_TYPING_STOP: "bridge:typing-stop",
  BRIDGE_FILE_RECEIVED: "bridge:file-received",
  BRIDGE_SKILLS_UPDATED: "bridge:skills-updated",
  BRIDGE_PREVIEW_START: "bridge:preview-start",
  BRIDGE_PREVIEW_UPDATE: "bridge:preview-update",
  BRIDGE_PREVIEW_DELETE: "bridge:preview-delete",
  BRIDGE_CARD: "bridge:card",
  BRIDGE_AUDIO: "bridge:audio",

  SEND_MESSAGE: "send-message",
  SEND_BUTTON: "send-button",
  SEND_FILE: "send-file",
} as const;
