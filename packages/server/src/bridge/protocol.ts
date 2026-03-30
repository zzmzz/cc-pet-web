import type { BridgeIncoming } from "@cc-pet/shared";

export function parseBridgeMessage(raw: string): BridgeIncoming {
  try {
    const data = JSON.parse(raw);
    if (!data.type) return { type: "error", message: "Missing type field" };
    return data as BridgeIncoming;
  } catch {
    return { type: "error", message: `Invalid JSON: ${raw.slice(0, 100)}` };
  }
}
