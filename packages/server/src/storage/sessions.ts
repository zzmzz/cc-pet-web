import type Database from "better-sqlite3";
import type { Session } from "@cc-pet/shared";

const AUTO_TITLE_MAX_LEN = 15;

function deriveSessionLabel(stored: string | null, firstUserContent: string | null): string | undefined {
  const s = stored?.trim();
  if (s && s.length > 0) return s;
  const t = firstUserContent?.trim();
  if (!t) return undefined;
  return t.length > AUTO_TITLE_MAX_LEN ? `${t.slice(0, AUTO_TITLE_MAX_LEN)}…` : t;
}

export class SessionStore {
  constructor(private db: Database.Database) {}

  create(session: Session): void {
    this.db.prepare(
      `INSERT INTO sessions (connection_id, key, label, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, key) DO UPDATE SET
         label = excluded.label,
         created_at = excluded.created_at,
         last_active_at = excluded.last_active_at`
    ).run(session.connectionId, session.key, session.label ?? null, session.createdAt, session.lastActiveAt);
  }

  listByConnection(connectionId: string): Session[] {
    // Left-join the first user message so sessions that pre-date server-side
    // auto-title persistence still show a meaningful label without forcing
    // the client to load history. Stored labels still win when present.
    const rows = this.db.prepare(
      `SELECT s.*, (
         SELECT m.content FROM messages m
         WHERE m.connection_id = s.connection_id
           AND m.session_key = s.key
           AND m.role = 'user'
         ORDER BY m.timestamp ASC
         LIMIT 1
       ) AS first_user_content
       FROM sessions s
       WHERE s.connection_id = ?
       ORDER BY s.last_active_at DESC`
    ).all(connectionId) as any[];
    return rows.map((r) => ({
      key: r.key,
      connectionId: r.connection_id,
      label: deriveSessionLabel(r.label, r.first_user_content),
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      isResident: (r.is_resident ?? 0) === 1,
      unreadCount: r.unread_count ?? 0,
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

  markResident(connectionId: string, key: string, label?: string): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO sessions (connection_id, key, label, created_at, last_active_at, is_resident, unread_count)
       VALUES (?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(connection_id, key) DO UPDATE SET
         is_resident = 1,
         label = COALESCE(excluded.label, sessions.label)`
    ).run(connectionId, key, label ?? null, now, now);
  }

  incrementUnread(connectionId: string, key: string): number {
    this.db.prepare(
      `UPDATE sessions SET unread_count = unread_count + 1 WHERE connection_id = ? AND key = ?`
    ).run(connectionId, key);
    return this.getUnread(connectionId, key);
  }

  clearUnread(connectionId: string, key: string): void {
    this.db.prepare(
      `UPDATE sessions SET unread_count = 0 WHERE connection_id = ? AND key = ?`
    ).run(connectionId, key);
  }

  getUnread(connectionId: string, key: string): number {
    const row = this.db.prepare(
      `SELECT unread_count FROM sessions WHERE connection_id = ? AND key = ?`
    ).get(connectionId, key) as { unread_count?: number } | undefined;
    return row?.unread_count ?? 0;
  }
}
