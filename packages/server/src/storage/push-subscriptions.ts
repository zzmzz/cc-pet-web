import type Database from "better-sqlite3";

export interface PushSubscriptionRecord {
  tokenName: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushSubscriptionStore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        token_name TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_push_subs_token ON push_subscriptions(token_name);
    `);
  }

  upsert(rec: PushSubscriptionRecord): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO push_subscriptions (endpoint, token_name, p256dh, auth, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         token_name = excluded.token_name,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         last_used_at = excluded.last_used_at`
    ).run(rec.endpoint, rec.tokenName, rec.p256dh, rec.auth, now, now);
  }

  listByToken(tokenName: string): PushSubscriptionRecord[] {
    const rows = this.db.prepare(
      `SELECT token_name, endpoint, p256dh, auth FROM push_subscriptions WHERE token_name = ?`
    ).all(tokenName) as { token_name: string; endpoint: string; p256dh: string; auth: string }[];
    return rows.map((r) => ({ tokenName: r.token_name, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
  }

  deleteByEndpoint(endpoint: string, tokenName?: string): void {
    if (tokenName !== undefined) {
      this.db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND token_name = ?`).run(endpoint, tokenName);
      return;
    }
    this.db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
  }
}
