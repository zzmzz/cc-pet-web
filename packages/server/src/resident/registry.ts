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
  /** 把 is_resident=1 但不在 valid 集合里的会话降级为普通会话，用于常驻 key 变更后的迁移 */
  demoteResidentExcept?(valid: Set<string>): void;
}

/** 组装 cc-connect 合规的 bridge session_key：{platform}:{scope}:{user}。
 *  platform 段必须等于 bridge 的 connectionId（=adapter 名），cron 才能路由回本 bridge。
 *  - 无 ":"：按 {bridgeId}:{key}:{key} 组装（推荐写法，配置里 key 只写 scope 段如 "resident"）。
 *  - 含 ":" 且恰好三段、首段==bridgeId：视为已合规，原样使用。
 *  - 含 ":" 但不合规（段数不对或首段不是 bridgeId）：把 ":" 消毒为 "_" 再组装，
 *    强制首段为 bridgeId，避免手写错误导致 cron 静默路由失败。 */
export function residentSessionKey(bridgeId: string, key: string): string {
  if (key.includes(":")) {
    const parts = key.split(":");
    if (parts.length === 3 && parts[0] === bridgeId) return key;
    const safe = key.replace(/:/g, "_");
    return `${bridgeId}:${safe}:${safe}`;
  }
  return `${bridgeId}:${key}:${key}`;
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
        key: residentSessionKey(rs.bridgeId, rs.key),
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
    const valid = new Set<string>();
    for (const p of this._pairs) {
      store.markResident(p.connectionId, p.key, p.label);
      valid.add(`${p.connectionId}::${p.key}`);
    }
    store.demoteResidentExcept?.(valid);
  }
}
