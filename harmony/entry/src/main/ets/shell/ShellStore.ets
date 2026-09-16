import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { AppStorageV2 } from '@kit.ArkUI';

/**
 * Deliberately a DIFFERENT preferences file from `AuthStore`'s `cc_pet_auth`.
 * That store holds a `token`, written by the native port that this shell
 * replaces as the entry point. Reading it here would quietly re-introduce the
 * one thing §4 of the design forbids — a token living in the shell — for any
 * device that still has the native build's data. Separate file, one key.
 */
const STORE_NAME: string = 'cc_pet_shell';
const KEY_BASE_URL: string = 'baseUrl';
const APP_STORAGE_KEY: string = 'ShellStore';

@ObservedV2
export class ShellStore {
  /**
   * Must be obtained through `AppStorageV2.connect()`, never `new` or a bare
   * `static readonly instance` — see the long note in `store/AuthStore.ets`
   * and the reactivity-fix report it cites. A bare singleton compiles, runs,
   * and silently never re-renders the UI.
   */
  static connect(): ShellStore {
    const instance: ShellStore | undefined =
      AppStorageV2.connect(ShellStore, APP_STORAGE_KEY, (): ShellStore => new ShellStore());
    if (instance === undefined) {
      throw new Error('ShellStore.connect(): AppStorageV2.connect returned undefined');
    }
    return instance;
  }

  /** Normalized (see `normalizeBaseUrl`). Empty means "not configured yet". */
  @Trace baseUrl: string = '';
  /** False until `init()` has read preferences — the UI must not decide
   * between the setup screen and the WebView before then, or a configured
   * device flashes the setup screen on every cold start. */
  @Trace ready: boolean = false;

  private store: preferences.Preferences | undefined = undefined;

  async init(context: common.UIAbilityContext): Promise<void> {
    this.store = await preferences.getPreferences(context, STORE_NAME);
    this.baseUrl = await this.store.get(KEY_BASE_URL, '') as string;
    this.ready = true;
  }

  async save(baseUrl: string): Promise<void> {
    this.baseUrl = baseUrl;
    if (this.store !== undefined) {
      await this.store.put(KEY_BASE_URL, baseUrl);
      await this.store.flush();
    }
  }

  /**
   * Forgets the address only. The web app's `localStorage` (token included)
   * is ArkWeb's to own and is intentionally NOT cleared here: "change server"
   * is an address correction, not a logout, and the design says the shell
   * does not touch the token.
   */
  async clear(): Promise<void> {
    this.baseUrl = '';
    if (this.store !== undefined) {
      await this.store.delete(KEY_BASE_URL);
      await this.store.flush();
    }
  }
}
