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
  `);
}
