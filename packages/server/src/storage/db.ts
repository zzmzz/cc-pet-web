import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { segmentForFts } from "./fts.js";

/** Bump when the FTS table/tokenization scheme changes so existing databases
 *  rebuild their index on next startup. v2 = CJK per-character segmentation. */
const FTS_SCHEMA_VERSION = 2;

export function createDatabase(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "cc-pet.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

export function initSchema(db: Database.Database): void {
  // Registered on the connection so triggers and index rebuilds can segment
  // CJK text into per-character tokens (see storage/fts.ts).
  db.function("cc_seg", { deterministic: true }, (text: unknown) =>
    segmentForFts(text == null ? "" : String(text)),
  );

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

  initFts(db);
}

function initFts(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version >= FTS_SCHEMA_VERSION) return;

  // Rebuild from scratch: drop the previous FTS table (older versions used an
  // external-content table with the unicode61 tokenizer, which cannot match
  // CJK substrings) and its triggers, then recreate with per-character
  // segmentation and repopulate from the existing messages.
  db.exec(`
    DROP TRIGGER IF EXISTS messages_fts_ai;
    DROP TRIGGER IF EXISTS messages_fts_ad;
    DROP TRIGGER IF EXISTS messages_fts_au;
    DROP TABLE IF EXISTS messages_fts;

    CREATE VIRTUAL TABLE messages_fts USING fts5(
      id UNINDEXED,
      content,
      tokenize='unicode61'
    );

    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, id, content) VALUES (new.rowid, new.id, cc_seg(new.content));
    END;
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
      INSERT INTO messages_fts(rowid, id, content) VALUES (new.rowid, new.id, cc_seg(new.content));
    END;

    INSERT INTO messages_fts(rowid, id, content)
      SELECT rowid, id, cc_seg(content) FROM messages;
  `);

  db.pragma(`user_version = ${FTS_SCHEMA_VERSION}`);
}
