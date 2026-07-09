import type { AppConfig } from "@cc-pet/shared";

export interface ResidentPair {
  connectionId: string;
  key: string;
  label?: string;
  tokenName: string;
}

interface RegistryLogger {
  warn(obj: unknown, msg: string): void;
}

interface ResidentMarker {
  markResident(connectionId: string, key: string, label?: string): void;
}

export class ResidentRegistry {
  private readonly _pairs: ResidentPair[] = [];
  private readonly byChatKey = new Map<string, ResidentPair>();

  constructor(config: AppConfig, logger?: RegistryLogger) {
    for (const token of config.tokens) {
      const rs = token.residentSession;
      if (!rs) continue;
      if (!token.bridgeIds.includes(rs.bridgeId)) {
        logger?.warn(
          { tokenName: token.name, bridgeId: rs.bridgeId, bridgeIds: token.bridgeIds },
          "Ignoring residentSession: bridgeId not in token bridgeIds",
        );
        continue;
      }
      const pair: ResidentPair = {
        connectionId: rs.bridgeId,
        key: rs.key,
        label: rs.label,
        tokenName: token.name,
      };
      this._pairs.push(pair);
      this.byChatKey.set(`${pair.connectionId}::${pair.key}`, pair);
    }
  }

  pairs(): ResidentPair[] {
    return [...this._pairs];
  }

  isResident(connectionId: string, key: string): boolean {
    return this.byChatKey.has(`${connectionId}::${key}`);
  }

  ownerToken(connectionId: string, key: string): string | undefined {
    return this.byChatKey.get(`${connectionId}::${key}`)?.tokenName;
  }

  bootstrap(store: ResidentMarker): void {
    for (const p of this._pairs) {
      store.markResident(p.connectionId, p.key, p.label);
    }
  }
}
