import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

export interface SearchResult {
  messageId: string;
  snippet: string;
  role: string;
  timestamp: number;
  connectionId: string | null;
  sessionKey: string | null;
  sessionLabel: string | null;
}

export function registerSearchRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{
    Querystring: { q?: string; connectionId?: string; limit?: string; offset?: string };
  }>("/api/search", async (req) => {
    const q = req.query.q?.trim();
    if (!q) return { results: [], total: 0 };

    const limit = Math.min(Math.max(parseInt(req.query.limit ?? "50", 10) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset ?? "0", 10) || 0, 0);
    const ftsQuery = `"${q.replace(/"/g, '""')}"`;

    const connFilter = req.query.connectionId;
    const connClause = connFilter ? " AND m.connection_id = ?" : "";
    const baseParams = connFilter ? [ftsQuery, connFilter] : [ftsQuery];

    const rows = db.prepare(`
      SELECT
        m.id AS messageId,
        snippet(messages_fts, 1, '<<hl>>', '<</hl>>', '...', 32) AS snippet,
        m.role,
        m.timestamp,
        m.connection_id AS connectionId,
        m.session_key AS sessionKey,
        s.label AS sessionLabel
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.id
      LEFT JOIN sessions s ON s.connection_id = m.connection_id AND s.key = m.session_key
      WHERE messages_fts MATCH ?${connClause}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).all(...baseParams, limit, offset) as SearchResult[];

    const countRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.id
      WHERE messages_fts MATCH ?${connClause}
    `).get(...baseParams) as { total: number };

    return { results: rows, total: countRow.total };
  });
}
