import type { FastifyReply, FastifyRequest } from "fastify";
import type { TokenConfig } from "@cc-pet/shared";
import { findTokenIdentity, getBearerToken, type AuthIdentity } from "../auth/token-auth.js";

const requestAuth = new WeakMap<FastifyRequest, AuthIdentity>();

type FailureCounter = {
  count: number;
  windowStartedAt: number;
  lockedUntil: number;
};

const WINDOW_MS = 60_000;
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;

const failuresByIp = new Map<string, FailureCounter>();

function getClientIp(req: FastifyRequest): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function isPathExempt(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/assets/") ||
    pathname === "/api/auth/verify"
  );
}

function shouldProtect(pathname: string): boolean {
  if (isPathExempt(pathname)) return false;
  return pathname.startsWith("/api/") || pathname === "/ws";
}

function getPathname(url: string): string {
  const parsed = new URL(url, "http://localhost");
  return parsed.pathname;
}

function isLocked(ip: string, now: number): boolean {
  const state = failuresByIp.get(ip);
  if (!state) return false;
  return state.lockedUntil > now;
}

function recordFailure(ip: string, now: number): void {
  const state = failuresByIp.get(ip);
  if (!state) {
    failuresByIp.set(ip, { count: 1, windowStartedAt: now, lockedUntil: 0 });
    return;
  }
  if (now - state.windowStartedAt > WINDOW_MS) {
    state.count = 1;
    state.windowStartedAt = now;
    state.lockedUntil = 0;
    return;
  }
  state.count += 1;
  if (state.count > MAX_FAILURES) {
    state.lockedUntil = now + LOCK_MS;
  }
}

function clearFailures(ip: string): void {
  failuresByIp.delete(ip);
}

export function getRequestAuthIdentity(req: FastifyRequest): AuthIdentity | null {
  return requestAuth.get(req) ?? null;
}

export function authGuard(tokens: TokenConfig[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const pathname = getPathname(req.url);
    if (!shouldProtect(pathname)) return;

    const ip = getClientIp(req);
    const now = Date.now();
    if (isLocked(ip, now)) {
      reply.code(429).send({ error: "Too many auth failures. Try later." });
      return;
    }

    const token = getBearerToken(req.headers.authorization);
    const identity = findTokenIdentity(tokens, token);
    if (!identity) {
      recordFailure(ip, now);
      req.log.warn({ ip, pathname }, "Rejected request: unauthorized token");
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    clearFailures(ip);
    requestAuth.set(req, identity);
  };
}
