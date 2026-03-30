export interface AppConfig {
  bridges: BridgeConfig[];
  tokens: TokenConfig[];
  corsOrigins?: string[];
  pet: PetConfig;
  server: ServerConfig;
}

export interface BridgeConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  token: string;
  enabled: boolean;
}

export interface TokenConfig {
  token: string;
  name: string;
  bridgeIds: string[];
}

export interface PetConfig {
  appearance?: string;
  opacity: number;
  size: number;
}

export interface ServerConfig {
  port: number;
  dataDir: string;
}
