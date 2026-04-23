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
      extra TEXT
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

  initFts(db);
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
