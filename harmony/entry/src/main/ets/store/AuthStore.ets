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
   * Must be obtained through `AppStorageV2.connect()` — see Global
   * Constraints in docs/superpowers/plans/2026-09-15-harmony-client.md for
   * why, and .superpowers/sdd/2026-09-15-harmony-client/reactivity-fix-report.md
   * for the reproduction evidence. NOTE: a `private constructor()` was
   * tried to make `new AuthStore()` a compile error outside this file, but
   * ArkTS rejects it — `AppStorageV2.connect()`'s `type` parameter requires
   * a public-constructor-shaped type, so passing `AuthStore` with a private
   * constructor fails to compile (see the reactivity-fix report for the
   * exact compiler error). This rule is therefore enforced by convention
   * and code review only, not by the compiler.
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
