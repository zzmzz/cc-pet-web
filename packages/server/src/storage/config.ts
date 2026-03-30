import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig, BridgeConfig, TokenConfig } from "@cc-pet/shared";

const DEFAULT_CONFIG: AppConfig = {
  bridges: [],
  tokens: [],
  corsOrigins: [],
  pet: { opacity: 1, size: 120 },
  server: { port: 3000, dataDir: "./data" },
};

const CONFIG_FILENAME = "cc-pet.config.json";

function normalizeBridge(b: unknown): BridgeConfig | null {
  if (!b || typeof b !== "object") return null;
  const x = b as Record<string, unknown>;
  if (typeof x.id !== "string" || typeof x.host !== "string") return null;
  const port =
    typeof x.port === "number" && Number.isFinite(x.port)
      ? x.port
      : parseInt(String(x.port ?? ""), 10);
  if (!Number.isFinite(port)) return null;
  return {
    id: x.id,
    name: typeof x.name === "string" ? x.name : x.id,
    host: x.host,
    port,
    token: typeof x.token === "string" ? x.token : "",
    enabled: typeof x.enabled === "boolean" ? x.enabled : true,
  };
}

function normalizeToken(t: unknown): TokenConfig | null {
  if (!t || typeof t !== "object") return null;
  const x = t as Record<string, unknown>;
  if (typeof x.token !== "string" || x.token.trim().length === 0) return null;
  const bridgeIds = Array.isArray(x.bridgeIds)
    ? x.bridgeIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  return {
    token: x.token,
    name: typeof x.name === "string" && x.name.trim().length > 0 ? x.name : "token",
    bridgeIds,
  };
}

function normalizeAppConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid ${CONFIG_FILENAME}: root must be a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  const bridgesRaw = o.bridges;
  const bridges = Array.isArray(bridgesRaw)
    ? (bridgesRaw.map(normalizeBridge).filter(Boolean) as BridgeConfig[])
    : DEFAULT_CONFIG.bridges;
  const tokensRaw = o.tokens;
  const tokens = Array.isArray(tokensRaw)
    ? (tokensRaw.map(normalizeToken).filter(Boolean) as TokenConfig[])
    : DEFAULT_CONFIG.tokens;
  const corsOriginsRaw = o.corsOrigins;
  const corsOrigins = Array.isArray(corsOriginsRaw)
    ? corsOriginsRaw.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : DEFAULT_CONFIG.corsOrigins;

  const pet =
    o.pet && typeof o.pet === "object"
      ? { ...DEFAULT_CONFIG.pet, ...(o.pet as AppConfig["pet"]) }
      : { ...DEFAULT_CONFIG.pet };

  const server =
    o.server && typeof o.server === "object"
      ? { ...DEFAULT_CONFIG.server, ...(o.server as AppConfig["server"]) }
      : { ...DEFAULT_CONFIG.server };

  return { bridges, tokens, corsOrigins, pet, server };
}

export interface ConfigStoreOptions {
  /** Relative paths are resolved from `process.cwd()` */
  dataDir?: string;
  /** Tests / callers: force a config file path (absolute or cwd-relative) */
  configFilePath?: string;
}

export class ConfigStore {
  /** When set, `save()` writes here instead of SQLite */
  private persistFilePath: string | null = null;

  constructor(
    private db: Database.Database,
    private options?: ConfigStoreOptions,
  ) {}

  private defaultDataDirConfigPath(): string | undefined {
    if (!this.options?.dataDir) return undefined;
    const dir = path.resolve(process.cwd(), this.options.dataDir);
    return path.join(dir, CONFIG_FILENAME);
  }

  /** Resolved path for file-backed config (explicit env, option override, or default under dataDir). */
  private resolveConfigFileCandidate(): string | undefined {
    if (this.options?.configFilePath) {
      const p = this.options.configFilePath;
      return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    }
    return this.defaultDataDirConfigPath();
  }

  load(): AppConfig {
    const candidate = this.resolveConfigFileCandidate();
    const wantsExplicitFile = Boolean(this.options?.configFilePath?.trim());

    if (candidate && fs.existsSync(candidate)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      } catch (e) {
        throw new Error(
          `Failed to read ${CONFIG_FILENAME} at ${candidate}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const merged = normalizeAppConfig(parsed);
      this.persistFilePath = candidate;
      return merged;
    }

    if (candidate && wantsExplicitFile) {
      this.persistFilePath = candidate;
    } else {
      this.persistFilePath = null;
    }

    const row = this.db.prepare(`SELECT data FROM config WHERE id = 1`).get() as any;
    const base = row ? normalizeAppConfig(JSON.parse(row.data) as AppConfig) : { ...DEFAULT_CONFIG };
    return base;
  }

  save(config: AppConfig): void {
    const payload = JSON.stringify(config, null, 2);
    if (this.persistFilePath) {
      fs.mkdirSync(path.dirname(this.persistFilePath), { recursive: true });
      fs.writeFileSync(this.persistFilePath, payload, "utf8");
      return;
    }
    this.db.prepare(`INSERT OR REPLACE INTO config (id, data) VALUES (1, ?)`).run(JSON.stringify(config));
  }
}
