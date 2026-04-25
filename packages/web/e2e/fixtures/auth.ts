import { test as base, expect } from "@playwright/test";

export const test = base.extend<{ authedPage: ReturnType<typeof base["page"]> }>({
  page: async ({ page }, use) => {
    await page.route("**/api/auth/verify", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ valid: true, name: "e2e", bridgeIds: ["e2e-bridge"] }) }),
    );
    await page.route("**/api/sessions**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [] }) }),
    );
    await page.route("**/api/history/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [] }) }),
    );
    await page.route("**/api/link-preview**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }),
    );
    await page.route("**/api/pet-images/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>" }),
    );

    await page.addInitScript(() => {
      localStorage.setItem("cc-pet-token", "e2e-test-token");

      const RealWebSocket = window.WebSocket;
      // @ts-ignore
      window.WebSocket = class FakeWebSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        CONNECTING = 0;
        OPEN = 1;
        CLOSING = 2;
        CLOSED = 3;
        readyState = 1;
        url: string;
        onopen: ((ev: any) => void) | null = null;
        onmessage: ((ev: any) => void) | null = null;
        onclose: ((ev: any) => void) | null = null;
        onerror: ((ev: any) => void) | null = null;

        constructor(url: string | URL, protocols?: string | string[]) {
          super();
          this.url = String(url);

          if (!this.url.includes("/ws")) {
            // Pass through non-app WebSockets (e.g., Vite HMR)
            const real = new RealWebSocket(url, protocols);
            this.readyState = real.readyState;
            real.onopen = (e) => { this.readyState = real.readyState; this.onopen?.(e); };
            real.onmessage = (e) => this.onmessage?.(e);
            real.onclose = (e) => { this.readyState = real.readyState; this.onclose?.(e); };
            real.onerror = (e) => this.onerror?.(e);
            (this as any)._real = real;
            return;
          }

          queueMicrotask(() => {
            this.onopen?.({ type: "open" } as any);

            const manifest = JSON.stringify({
              type: "bridge:manifest",
              bridges: [{ id: "e2e-bridge", name: "E2E Bridge" }],
            });
            this.onmessage?.({ data: manifest } as any);

            const connected = JSON.stringify({
              type: "bridge:connected",
              connectionId: "e2e-bridge",
              connected: true,
            });
            this.onmessage?.({ data: connected } as any);
          });
        }

        send() {}
        close() {
          this.readyState = 3;
          if ((this as any)._real) (this as any)._real.close();
        }
      };
    });

    await use(page);
  },
});

export { expect };
