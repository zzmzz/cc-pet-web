import { getPlatform } from "./platform.js";

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window
  );
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.ready);
}

/** Subscribe this browser for push. Returns true on success. Assumes Notification permission already granted. */
export async function subscribePush(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const keyRes = await getPlatform().fetchApi<{ publicKey: string | null }>("/api/push/vapid-public-key");
  if (!keyRes.publicKey) return false;
  const reg = await getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    // TS 6.0 types Uint8Array as generic over its buffer; cast to the DOM BufferSource
    // the PushManager expects (the runtime value is a valid application server key).
    applicationServerKey: urlBase64ToUint8Array(keyRes.publicKey) as BufferSource,
  });
  const json = sub.toJSON();
  await getPlatform().fetchApi("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  return true;
}

export async function unsubscribePush(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await getPlatform()
    .fetchApi("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) })
    .catch(() => {});
}
