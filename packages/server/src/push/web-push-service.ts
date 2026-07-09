import webpush from "web-push";
import type { WebPushConfig } from "@cc-pet/shared";
import type { PushSubscriptionStore } from "../storage/push-subscriptions.js";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface WebPushSender {
  sendNotification(sub: unknown, payload: string): Promise<{ statusCode?: number }>;
}

interface ServiceLogger {
  warn(obj: unknown, msg: string): void;
}

export class WebPushService {
  private readonly sender: WebPushSender;
  private readonly config?: WebPushConfig;
  private readonly log?: ServiceLogger;

  constructor(
    private store: PushSubscriptionStore,
    config: WebPushConfig | undefined,
    opts?: { sender?: WebPushSender; logger?: ServiceLogger },
  ) {
    this.config = config;
    this.log = opts?.logger;
    if (config && !opts?.sender) {
      webpush.setVapidDetails(config.subject, config.vapidPublicKey, config.vapidPrivateKey);
    }
    this.sender = opts?.sender ?? {
      sendNotification: (sub, payload) =>
        webpush.sendNotification(sub as webpush.PushSubscription, payload) as Promise<{ statusCode?: number }>,
    };
  }

  get enabled(): boolean {
    return Boolean(this.config);
  }

  publicKey(): string | null {
    return this.config?.vapidPublicKey ?? null;
  }

  async sendToToken(tokenName: string, payload: PushPayload): Promise<void> {
    if (!this.enabled) return;
    const subs = this.store.listByToken(tokenName);
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (s) => {
        const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
        try {
          await this.sender.sendNotification(sub, body);
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            this.store.deleteByEndpoint(s.endpoint);
          } else {
            this.log?.warn({ endpoint: s.endpoint, statusCode }, "web push send failed");
          }
        }
      }),
    );
  }
}
