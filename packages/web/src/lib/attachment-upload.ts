import { WS_EVENTS } from "@cc-pet/shared";
import { getPlatform } from "./platform.js";
import { useMessageStore } from "./store/message.js";

/**
 * Staged attachment sending — a two-phase operation with two distinct failure domains.
 *
 * Phase 1 (HTTP): the file is streamed to disk on the server. The outbox cannot own this
 * phase — nothing has been transmitted yet, and a `File` handle is not serializable, so a
 * queued entry would be unresendable after a reload. Retry here means re-reading the
 * local file, which only works while this page still holds it.
 *
 * Phase 2 (WebSocket): only the staged *paths* are sent. This is ordinary message
 * delivery, so it goes through the outbox and gets ack tracking, auto-retry on reconnect
 * and per-bubble manual retry. The payload is a few hundred bytes, so unlike the base64
 * fallback it stays well under PERSIST_MAX_BYTES and survives a reload intact.
 */

interface RetainedUpload {
  chatKey: string;
  connectionId: string;
  sessionKey: string;
  files: File[];
  caption?: string;
}

/**
 * Files kept alive for a phase-1 retry, keyed by bubble id.
 *
 * Deliberately module state rather than the store: `File` cannot be persisted, and
 * putting it in zustand would imply a durability this cannot deliver. A page reload
 * legitimately loses these — the bubble then tells the user to pick the file again.
 */
const retained = new Map<string, RetainedUpload>();

/** Bubble ids whose upload is in flight, so a double-tap on retry cannot race. */
const inFlight = new Set<string>();

export function retainedUploadCount(): number {
  return retained.size;
}

/** Drop retained files for a chat (e.g. history cleared) so they can be collected. */
export function forgetRetainedUploads(chatKey: string): void {
  for (const [bubbleId, entry] of retained) {
    if (entry.chatKey === chatKey) retained.delete(bubbleId);
  }
}

async function runUpload(bubbleId: string): Promise<void> {
  const entry = retained.get(bubbleId);
  if (!entry) return;
  if (inFlight.has(bubbleId)) return;
  inFlight.add(bubbleId);

  const { chatKey, connectionId, sessionKey, files, caption } = entry;
  const { patchMessage, reidentifyMessage } = useMessageStore.getState();
  patchMessage(chatKey, bubbleId, { uploading: true, uploadProgress: 0, uploadError: undefined });

  const staged: { file_name: string; size: number; agent_path: string }[] = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const result = await getPlatform().uploadAttachment(connectionId, file, (percent) => {
        // Weight per-file progress into one bar; uploads run sequentially because
        // parallel multi-hundred-MB transfers just contend for the same uplink.
        const overall = Math.floor((index * 100 + percent) / files.length);
        patchMessage(chatKey, bubbleId, { uploading: true, uploadProgress: overall });
      });
      staged.push({ file_name: result.name, size: result.size, agent_path: result.agentPath });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    patchMessage(chatKey, bubbleId, {
      uploading: false,
      uploadProgress: undefined,
      uploadError: message,
    });
    inFlight.delete(bubbleId);
    return;
  }

  // Phase 2: hand delivery to the outbox. Its clientMsgId becomes the bubble id so the
  // bubble can render pending/failed and offer the standard retry.
  const clientMsgId = getPlatform().sendWsMessage(
    {
      type: WS_EVENTS.SEND_FILE,
      connectionId,
      sessionKey,
      content: caption ?? "",
      files: staged,
    },
    "auto",
  );
  patchMessage(chatKey, bubbleId, {
    uploading: false,
    uploadProgress: undefined,
    uploadError: undefined,
  });
  if (clientMsgId) reidentifyMessage(chatKey, bubbleId, clientMsgId);

  // The bytes are on the server now; a phase-1 retry would only re-upload a duplicate.
  retained.delete(bubbleId);
  inFlight.delete(bubbleId);
}

/**
 * Create the optimistic bubble and start streaming the files to the workspace.
 *
 * The bubble exists from the start: a multi-hundred-MB upload can take minutes, and an
 * empty transcript during that time reads as "nothing happened".
 */
export async function sendStagedAttachments(params: {
  chatKey: string;
  connectionId: string;
  sessionKey: string;
  files: File[];
  caption?: string;
}): Promise<string> {
  const { chatKey, connectionId, sessionKey, files, caption } = params;
  const bubbleId = `upload-${crypto.randomUUID()}`;
  useMessageStore.getState().addMessage(chatKey, {
    id: bubbleId,
    role: "user",
    content: caption ?? "",
    files: files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      size: file.size,
    })),
    timestamp: Date.now(),
    connectionId,
    sessionKey,
    uploading: true,
    uploadProgress: 0,
  });
  retained.set(bubbleId, { chatKey, connectionId, sessionKey, files, caption });
  await runUpload(bubbleId);
  return bubbleId;
}

/** Re-run a failed phase-1 upload. No-op once the files are gone (e.g. after reload). */
export async function retryStagedUpload(bubbleId: string): Promise<void> {
  if (retained.has(bubbleId)) {
    await runUpload(bubbleId);
    return;
  }
  // Which chat this bubble belongs to is unknown once the retain entry is gone, so patch
  // wherever it lives rather than guessing.
  const { messagesByChat } = useMessageStore.getState();
  for (const [chatKey, list] of Object.entries(messagesByChat)) {
    if (list.some((m) => m.id === bubbleId)) {
      useMessageStore.getState().patchMessage(chatKey, bubbleId, {
        uploading: false,
        uploadError: "本地文件已失效（页面刷新过），请重新选择文件。",
      });
      return;
    }
  }
}

/** Test seam: drop all retained files. */
export function resetRetainedUploads(): void {
  retained.clear();
  inFlight.clear();
}
