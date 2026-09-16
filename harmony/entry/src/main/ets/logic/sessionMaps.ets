/**
 * Serialization for the two `connectionId -> sessionKey` pointer maps
 * (`activeSessionKeys`, `stickySessions`) `SessionStore` persists to
 * preferences.
 *
 * FORMAT DECISION (probed in-project before writing this, per task-3
 * brief): JSON, not `key\tvalue` lines. The brief flagged that ArkTS strict
 * mode bans indexed access on interfaces/classes (arkts-no-props-by-index)
 * and on types (arkts-no-aliases-by-index), and asked whether a parsed JSON
 * object can still be read back key-by-key. A throwaway probe (written,
 * compiled with `hvigorw test`, and deleted — not guessed) showed it can:
 * casting a `JSON.parse` result to `Record<string, Object>` and then doing
 * `Object.keys(obj)` + `obj[k]` compiles cleanly and runs correctly, with no
 * arkts-no-props-by-index/arkts-no-aliases-by-index diagnostic. That rule
 * targets object literals and declared field/type access, not a `Record`
 * produced by a runtime `JSON.parse`. So JSON round-trips through the same
 * `JSON.parse`/`JSON.stringify` already used elsewhere in this codebase
 * (`SessionApi`, `HistoryApi`, `ConnectionGateway`) rather than inventing a
 * bespoke line format and its own escaping rules.
 */

/** `{}` for an empty map — never `undefined`/`null`, so a first-run read is valid JSON. */
export function serializeStringMap(map: Map<string, string>): string {
  const payload: Record<string, string> = {};
  map.forEach((value: string, key: string) => {
    payload[key] = value;
  });
  return JSON.stringify(payload);
}

/**
 * Never throws: garbage input (empty string, non-JSON, a JSON array, a
 * dropped-on-the-floor primitive) yields an empty map instead of crashing
 * store init on a corrupted or pre-migration preferences value.
 *
 * Values that parse but aren't strings (`{"c2":5}`) are skipped one key at
 * a time rather than rejecting the whole map, so one bad entry can't cost
 * every other connection's pointer.
 */
export function deserializeStringMap(text: string): Map<string, string> {
  const result: Map<string, string> = new Map<string, string>();
  let parsed: Object;
  try {
    parsed = JSON.parse(text) as Object;
  } catch (e) {
    return result;
  }
  // `JSON.parse('null')` SUCCEEDS -- it does not reach the catch above -- and
  // `Object.keys(null)` then throws, which would break this function's
  // "never throws" contract on genuinely corrupted preferences data. Same
  // for a persisted scalar or array. Found by the Task 3 review.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return result;
  }
  const obj: Record<string, Object> = parsed as Record<string, Object>;
  const keys: string[] = Object.keys(obj);
  for (const key of keys) {
    const value: Object = obj[key];
    if (typeof value === 'string') {
      result.set(key, value as string);
    }
  }
  return result;
}
