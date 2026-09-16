/**
 * The one place the typed server address is turned into something the `Web`
 * component can be pointed at. Pure — no preferences, no network — so it is
 * reachable from `hvigorw test`, which cannot instantiate an `@Entry` struct
 * or hand anything a `UIAbilityContext`.
 */

export class BaseUrlResult {
  /** Normalized, ready to hand to `Web({ src })`. Empty when `error` is set. */
  url: string = '';
  /** User-facing Chinese message, empty on success. */
  error: string = '';
}

function ok(url: string): BaseUrlResult {
  const result: BaseUrlResult = new BaseUrlResult();
  result.url = url;
  return result;
}

function bad(message: string): BaseUrlResult {
  const result: BaseUrlResult = new BaseUrlResult();
  result.error = message;
  return result;
}

/**
 * Scheme defaults to `https`, not `http`: §6 of the design pins
 * `mixedMode(MixedMode.None)`, so a shell that silently guessed `http` would
 * produce a page that loads but whose subresources may not. Typing `http://`
 * explicitly is still honoured — that is how the throwaway fixture stack in
 * `scripts/lib/common.sh` is reachable, and it is a plain-http *page*, which
 * `MixedMode.None` does not block (None only blocks http content inside an
 * https page).
 */
export function normalizeBaseUrl(raw: string): BaseUrlResult {
  const trimmed: string = raw.trim();
  if (trimmed.length === 0) {
    return bad('请输入服务器地址');
  }

  const schemeMatch: RegExpMatchArray | null = trimmed.match(/^([A-Za-z][A-Za-z0-9+.\-]*):\/\//);
  let withScheme: string = trimmed;
  if (schemeMatch === null) {
    if (trimmed.includes('://')) {
      return bad('地址格式不正确');
    }
    withScheme = `https://${trimmed}`;
  } else {
    const scheme: string = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      return bad('只支持 http:// 或 https:// 地址');
    }
    withScheme = `${scheme}://${trimmed.substring(schemeMatch[0].length)}`;
  }

  const schemeEnd: number = withScheme.indexOf('://') + 3;
  const rest: string = withScheme.substring(schemeEnd);
  // Trailing slashes are stripped because every path built from this value
  // carries its own leading slash (the shell's own `/` probe, and the web
  // app's `fetch("/api/...")`). Keeping one would produce `//api/...`, which
  // some routers answer and some 404 — not worth finding out per-deployment.
  const host: string = rest.replace(/\/+$/, '');
  if (host.length === 0) {
    return bad('地址缺少主机名');
  }
  if (host.includes(' ')) {
    return bad('地址不能包含空格');
  }

  return ok(`${withScheme.substring(0, schemeEnd)}${host}`);
}
