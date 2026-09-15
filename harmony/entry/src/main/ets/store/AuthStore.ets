import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { AppStorageV2 } from '@kit.ArkUI';

const STORE_NAME: string = 'cc_pet_auth';
const KEY_TOKEN: string = 'token';
const KEY_BASE_URL: string = 'baseUrl';
const APP_STORAGE_KEY: string = 'AuthStore';

@ObservedV2
export class AuthStore {
  /**
   * The shared instance MUST be obtained through `AppStorageV2.connect()`,
   * never via a bare `static readonly instance = new AuthStore()`. A plain
   * static singleton is constructed at module-evaluation time, before any
   * component holds it — @Local-holding a reference to it later does not
   * reliably register the holding component as a V2 observer of its @Trace
   * fields (confirmed empirically: `@Monitor('auth.authorized')` never
   * fired and the UI never re-rendered after `save()` flipped `authorized`
   * to `true`, even though the field write itself was correct and
   * persisted). `AppStorageV2.connect(AuthStore, key, factory)` lazily
   * creates (or returns the existing) shared instance from *inside* a
   * reactive context and is the pattern ArkUI V2 documents for exactly
   * this case — see docs/superpowers/plans/2026-09-15-harmony-client.md
   * Global Constraints for the full writeup and the reproduction evidence.
   */
  static connect(): AuthStore {
    const instance: AuthStore | undefined = AppStorageV2.connect(AuthStore, APP_STORAGE_KEY, (): AuthStore => new AuthStore());
    if (instance === undefined) {
      throw new Error('AuthStore.connect(): AppStorageV2.connect returned undefined');
    }
    return instance;
  }

  @Trace token: string = '';
  @Trace baseUrl: string = '';
  @Trace authorized: boolean = false;

  private store: preferences.Preferences | undefined = undefined;

  async init(context: common.UIAbilityContext): Promise<void> {
    this.store = await preferences.getPreferences(context, STORE_NAME);
    this.token = await this.store.get(KEY_TOKEN, '') as string;
    this.baseUrl = await this.store.get(KEY_BASE_URL, '') as string;
    this.authorized = this.token.length > 0 && this.baseUrl.length > 0;
  }

  async save(baseUrl: string, token: string): Promise<void> {
    this.baseUrl = baseUrl;
    this.token = token;
    this.authorized = true;
    if (this.store !== undefined) {
      await this.store.put(KEY_BASE_URL, baseUrl);
      await this.store.put(KEY_TOKEN, token);
      await this.store.flush();
    }
  }

  async clear(): Promise<void> {
    this.token = '';
    this.authorized = false;
    if (this.store !== undefined) {
      await this.store.delete(KEY_TOKEN);
      await this.store.flush();
    }
  }
}
