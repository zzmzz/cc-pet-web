import type Database from "better-sqlite3";
import type { AppConfig } from "@cc-pet/shared";

const DEFAULT_CONFIG: AppConfig = {
  bridges: [],
  pet: { opacity: 1, size: 120 },
  server: { port: 3000, dataDir: "./data" },
};

export class ConfigStore {
  constructor(private db: Database.Database) {}

  load(): AppConfig {
    const row = this.db.prepare(`SELECT data FROM config WHERE id = 1`).get() as any;
    if (!row) return { ...DEFAULT_CONFIG };
    return JSON.parse(row.data);
  }

  save(config: AppConfig): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO config (id, data) VALUES (1, ?)`
    ).run(JSON.stringify(config));
  }
}
