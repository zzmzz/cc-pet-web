import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { RestClient } from './RestClient';
import { petImageUrl } from '../model/Endpoints';
import { PetState } from '../model/Protocol';

const DOMAIN = 0x0000;
const TAG = 'PetImageCache';

/** "File exists" — benign race between an `access()` check and `mkdir`. */
const FILE_EXISTS_ERROR_CODE = 13900015;

/**
 * Cheap, non-cryptographic string hash (FNV-1a, 32-bit) used only to turn a
 * token into a filesystem-safe directory name — not a security boundary.
 * The token's length is folded into the result too, on top of FNV-1a's own
 * mixing, to make same-hash different-token collisions even less likely for
 * the short, high-entropy tokens this app deals with.
 */
function hashToken(token: string): string {
  let hash: number = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex: string = (hash >>> 0).toString(16).padStart(8, '0');
  return `${hex}${token.length.toString(16)}`;
}

/**
 * Per-token disk cache for `GET /api/pet-images/:state`, at
 * `context.filesDir/pet/<tokenHash>/<state>.png`. Gateway, not a Store: it
 * holds no `@Trace` state and nothing observes it reactively, so — like
 * ConnectionGateway/NotificationGateway — it stays a plain
 * `static readonly instance` per Global Constraints (that rule is scoped to
 * Store singletons).
 *
 * The cache key (the directory) is namespaced by a hash of the token, never
 * the raw token itself (avoids putting a bearer credential in a filename)
 * and never omitted (a keyless cache would show the previous user's pet
 * image after switching accounts — see the brief).
 *
 * `uriFor` never throws: a missing custom image (404, or any other fetch
 * failure) is normal, not an error, so it resolves `undefined` and the
 * caller falls back to the bundled `$r('app.media.pet_<state>')` resource.
 */
export class PetImageCache {
  static readonly instance: PetImageCache = new PetImageCache();

  private filesDir: string = '';

  /** Idempotent — safe to call from every component that might need this cache. */
  init(context: common.UIAbilityContext): void {
    if (this.filesDir.length > 0) {
      return;
    }
    this.filesDir = context.filesDir;
  }

  /**
   * Resolves to a `file://` URI for a cached (or freshly fetched-and-cached)
   * per-token custom image, or `undefined` if none exists for this token —
   * callers should fall back to the bundled PNG in that case.
   */
  async uriFor(state: PetState, baseUrl: string, token: string): Promise<string | undefined> {
    if (this.filesDir.length === 0 || baseUrl.length === 0 || token.length === 0) {
      return undefined;
    }
    const dir: string = `${this.filesDir}/pet/${hashToken(token)}`;
    const path: string = `${dir}/${state}.png`;

    if (await this.fileExists(path)) {
      // Diagnostic only (kept permanently, not verification-temp code): lets
      // a cache-hit vs. cache-miss be told apart from `hilog` alone, which is
      // how "reused from the sandbox on relaunch, no second fetch" was
      // actually verified on-device — see the Task 13 report.
      hilog.info(DOMAIN, TAG, 'cache hit for state=%{public}s, no network fetch', state);
      return `file://${path}`;
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await new RestClient(baseUrl, token).getBinary(petImageUrl(state));
    } catch (err) {
      // 404 (no custom image set for this token/state) and any network
      // failure both land here — both are the normal case, not an error to
      // surface to the user. See class doc.
      hilog.info(DOMAIN, TAG, 'no custom pet image for state=%{public}s, falling back to bundled asset', state);
      return undefined;
    }
    hilog.info(DOMAIN, TAG, 'fetched custom pet image for state=%{public}s, caching', state);

    // Write-then-rename, not a direct write to `path`: `writeFile` opens with
    // `TRUNC`, so a process kill (low-memory reclaim, crash, force-stop —
    // all common on-device) between open/write/close used to leave a
    // truncated file sitting at the exact path `fileExists(path)` checks on
    // the *next* call. That truncated file "exists", so it was returned as
    // a cache hit with no content validation — a permanently corrupt image,
    // forever, since a file that exists never gets re-fetched. Writing to a
    // `.tmp` sibling and only moving it into place after a full successful
    // write means a mid-write crash leaves at worst an orphaned `.tmp` file
    // that `fileExists(path)` never sees — never a corrupt cache hit.
    const tmpPath: string = `${path}.tmp`;
    try {
      await this.ensureDir(dir);
      await this.writeFile(tmpPath, bytes);
      // Mode 0 (default): overwrite the destination if a stale cached image
      // already exists there from a previous fetch of this state.
      await fileIo.moveFile(tmpPath, path, 0);
    } catch (err) {
      const businessError: BusinessError = err as BusinessError;
      hilog.error(DOMAIN, TAG, 'failed to cache fetched pet image: code=%{public}d message=%{public}s',
        businessError.code, businessError.message);
      return undefined;
    }
    return `file://${path}`;
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      return await fileIo.access(path);
    } catch (err) {
      return false;
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    if (await this.fileExists(dir)) {
      return;
    }
    try {
      await fileIo.mkdir(dir, true);
    } catch (err) {
      const businessError: BusinessError = err as BusinessError;
      if (businessError.code !== FILE_EXISTS_ERROR_CODE) {
        // `throw businessError` directly trips ArkTS's arkts-limited-throw
        // rule (BusinessError is an `interface extends Error`, not a class
        // ArkTS recognizes as Error-derived) — wrap it in a real `Error`.
        throw new Error(`mkdir failed: code=${businessError.code} message=${businessError.message}`);
      }
    }
  }

  private async writeFile(path: string, bytes: ArrayBuffer): Promise<void> {
    const openMode: number = fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC;
    const file: fileIo.File = await fileIo.open(path, openMode);
    try {
      await fileIo.write(file.fd, bytes);
    } finally {
      await fileIo.close(file);
    }
  }
}
