/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

/**
 * Activate a newly-deployed worker immediately instead of parking it in
 * `waiting` until every client closes.
 *
 * `vite.config.ts` sets `registerType: "autoUpdate"`, which is easy to read as
 * "updates land on their own". It does not, with `strategies: "injectManifest"`
 * -- that option only makes the generated registration script call
 * `updateSW()`; injecting `skipWaiting`/`clientsClaim` is the custom worker's
 * job, i.e. this file's. Without them the new worker installs and then waits
 * forever, and the old precached bundle keeps being served.
 *
 * In a browser tab that eventually resolves itself, because the user closes
 * every tab sooner or later. In the HarmonyOS WebView shell it never does: the
 * page is the app, so a deploy was invisible on device indefinitely. Reported
 * as "app 上的 web 一直刷不出新页面".
 *
 * `cleanupOutdatedCaches()` is here for the other half of the same failure: a
 * stale precache can hold an `index.html` pointing at a hashed chunk the new
 * build deleted, which renders as a white screen rather than as old content.
 *
 * `clients.claim()` is the plain API rather than workbox-core's `clientsClaim()`
 * so this needs no new dependency -- workbox-core is not currently one.
 */
self.skipWaiting();
self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});
cleanupOutdatedCaches();

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
