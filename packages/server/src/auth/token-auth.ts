import crypto from "node:crypto";
import type { TokenConfig } from "@cc-pet/shared";

export interface AuthIdentity {
  tokenName: string;
  bridgeIds: Set<string>;
}

function secureEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function findTokenIdentity(tokens: TokenConfig[], rawToken: string | null | undefined): AuthIdentity | null {
  if (!rawToken) return null;
  const token = rawToken.trim();
  if (token.length === 0) return null;
  const matched = tokens.find((item) => secureEquals(item.token, token));
  if (!matched) return null;
  return {
    tokenName: matched.name,
    bridgeIds: new Set(matched.bridgeIds),
  };
}

export function getBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ", 2);
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token;
}
