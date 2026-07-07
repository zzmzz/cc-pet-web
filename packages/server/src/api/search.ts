import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildMatchQuery, makeSnippet } from "../storage/fts.js";

export interface SearchResult {
  messageId: string;
  snippet: string;
  role: string;
  timestamp: number;
  connectionId: string | null;
  sessionKey: string | null;
  sessionLabel: string | null;
}

interface SearchRow {
  messageId: string;
  content: string;
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

    // Segment CJK into per-character tokens so substring searches match; a
    // whitespace/punctuation-only query yields no searchable tokens.
    const ftsQuery = buildMatchQuery(q);
    if (!ftsQuery) return { results: [], total: 0 };

    const limit = Math.min(Math.max(parseInt(req.query.limit ?? "50", 10) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset ?? "0", 10) || 0, 0);

    const connFilter = req.query.connectionId;
    const connClause = connFilter ? " AND m.connection_id = ?" : "";
    const baseParams = connFilter ? [ftsQuery, connFilter] : [ftsQuery];
    const visibleSessionClause = " AND (m.session_key = 'default' OR s.key IS NOT NULL)";

    // The FTS content column stores segmented text (unsuitable for display), so
    // select the original message content and build the snippet in JS.
    const rows = db.prepare(`
      SELECT
        m.id AS messageId,
        m.content AS content,
        m.role,
        m.timestamp,
        m.connection_id AS connectionId,
        m.session_key AS sessionKey,
        s.label AS sessionLabel
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      LEFT JOIN sessions s ON s.connection_id = m.connection_id AND s.key = m.session_key
      WHERE messages_fts MATCH ?${connClause}${visibleSessionClause}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).all(...baseParams, limit, offset) as SearchRow[];

    const countRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      LEFT JOIN sessions s ON s.connection_id = m.connection_id AND s.key = m.session_key
      WHERE messages_fts MATCH ?${connClause}${visibleSessionClause}
    `).get(...baseParams) as { total: number };

    const results: SearchResult[] = rows.map(({ content, ...rest }) => ({
      ...rest,
      snippet: makeSnippet(content, q),
    }));

    return { results, total: countRow.total };
  });
}
