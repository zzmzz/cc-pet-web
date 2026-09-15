export interface ResidentSessionConfig {
  bridgeId: string;
  key: string;
  label?: string;
}

export interface WebPushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  subject: string;
}

export interface AppConfig {
  bridges: BridgeConfig[];
  tokens: TokenConfig[];
  pet: PetConfig;
  server: ServerConfig;
  webPush?: WebPushConfig;
}

export interface BridgeConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  token: string;
  enabled: boolean;
  workspacePath?: string;
  /**
   * Absolute path of `workspacePath` as the *agent* sees it. The server may reach the
   * workspace through a bind mount under a different name (e.g. the container sees
   * `/hywork` while the agent on the host sees `/root/code/hyworkspace`), so staged
   * attachment paths must be translated before being handed to the agent. Defaults to
   * `workspacePath` when unset.
   */
  workspaceAgentPath?: string;
}

export interface TokenConfig {
  token: string;
  name: string;
  bridgeIds: string[];
  petImages?: TokenPetImages;
  residentSession?: ResidentSessionConfig;
}

export interface TokenPetImages {
  idle: string;
  thinking?: string;
  talking?: string;
  happy?: string;
  error?: string;
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
