import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export function createDatabase(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "cc-pet.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      connection_id TEXT,
      session_key TEXT,
      extra TEXT,
      seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_key ON messages(chat_key);

    CREATE TABLE IF NOT EXISTS sessions (
      connection_id TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY (connection_id, key)
    );

    CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
      DELETE FROM messages WHERE connection_id = old.connection_id AND session_key = old.key;
    END;

    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_quota_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      usage_data TEXT NOT NULL,
      raw_content TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_quota_timestamp ON ai_quota_history(timestamp);
  `);

  // Migration: add seq column if it doesn't exist yet (idempotent).
  const messageCols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
  if (!messageCols.some((c) => c.name === "seq")) {
    db.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER`);
  }
  backfillMissingSeq(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_key, seq)`);

  initFts(db);
}

/**
 * Assign a seq to every row that still has NULL, ordered by timestamp ASC then
 * rowid ASC. Runs on every start and is a no-op once no NULL rows remain.
 *
 * Assignment starts above the current MAX(seq): the first upgrade sees an
 * all-NULL table and numbers it from 1, while a NULL row appearing later
 * (binary rollback, manual insert) lands past everything already numbered.
 * Numbering such a row by its position in the full history would hand it a seq
 * that another row already owns, and the `seq > ?` sync cursor would skip the
 * duplicate forever.
 *
 * Ordering by timestamp first (not rowid alone) restores the correct display
 * order for rows whose rowid was churned by the historical INSERT OR REPLACE.
 *
 * The ordering is resolved in JS rather than inside the UPDATE: a ROW_NUMBER()
 * subquery over `seq IS NULL` would be re-evaluated against the shrinking set
 * of NULL rows as the same UPDATE fills them in, handing out duplicates.
 */
function backfillMissingSeq(db: Database.Database): void {
  const pending = db
    .prepare(`SELECT id FROM messages WHERE seq IS NULL ORDER BY timestamp ASC, rowid ASC`)
    .all() as { id: string }[];
  if (pending.length === 0) return;
  const { m: base } = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM messages`)
    .get() as { m: number };
  const assign = db.prepare(`UPDATE messages SET seq = ? WHERE id = ?`);
  db.transaction(() => {
    pending.forEach((row, i) => assign.run(base + i + 1, row.id));
  })();
}

function initFts(db: Database.Database): void {
  const ftsExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_fts'"
  ).get();

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      id,
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, id, content) VALUES (new.rowid, new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, id, content) VALUES('delete', old.rowid, old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, id, content) VALUES('delete', old.rowid, old.id, old.content);
      INSERT INTO messages_fts(rowid, id, content) VALUES (new.rowid, new.id, new.content);
    END;
  `);

  if (!ftsExists) {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  }
}
