import type Database from "better-sqlite3";
import type { Session } from "@cc-pet/shared";

export class SessionStore {
  constructor(private db: Database.Database) {}

  create(session: Session): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO sessions (connection_id, key, label, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(session.connectionId, session.key, session.label ?? null, session.createdAt, session.lastActiveAt);
  }

  listByConnection(connectionId: string): Session[] {
    const rows = this.db.prepare(
      `SELECT * FROM sessions WHERE connection_id = ? ORDER BY last_active_at DESC`
    ).all(connectionId) as any[];
    return rows.map((r) => ({
      key: r.key,
      connectionId: r.connection_id,
      label: r.label ?? undefined,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
    }));
  }

  delete(connectionId: string, key: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE connection_id = ? AND key = ?`).run(connectionId, key);
  }

  updateLabel(connectionId: string, key: string, label: string): void {
    this.db.prepare(`UPDATE sessions SET label = ? WHERE connection_id = ? AND key = ?`).run(label, connectionId, key);
  }

  touchActive(connectionId: string, key: string): void {
    this.db.prepare(`UPDATE sessions SET last_active_at = ? WHERE connection_id = ? AND key = ?`).run(Date.now(), connectionId, key);
  }
}
