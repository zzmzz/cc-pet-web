const INITIAL_DELAY_MS: number = 1000;
const MAX_DELAY_MS: number = 30000;

/** Exponential backoff matching the web client: min(30s, 1s * 2^attempt). */
export function backoffDelayMs(attempt: number): number {
  const safeAttempt: number = attempt < 0 ? 0 : attempt;
  const delay: number = INITIAL_DELAY_MS * Math.pow(2, safeAttempt);
  return delay > MAX_DELAY_MS ? MAX_DELAY_MS : delay;
}
