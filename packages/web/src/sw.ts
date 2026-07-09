/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("push", (event: PushEvent) => {
  let payload: { title?: string; body?: string; data?: Record<string, unknown> } = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { body: event.data?.text() };
  }
  const title = payload.title || "常驻助手";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "有新的主动消息",
      icon: "/pwa-192x192.png",
      badge: "/pwa-192x192.png",
      tag: "resident-proactive",
      data: payload.data ?? {},
    }),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientList.find((c) => "focus" in c) as WindowClient | undefined;
      if (existing) {
        await existing.focus();
      } else {
        await self.clients.openWindow("/");
      }
    })(),
  );
});
