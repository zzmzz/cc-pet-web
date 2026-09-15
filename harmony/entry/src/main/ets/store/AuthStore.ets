import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

const STORE_NAME: string = 'cc_pet_auth';
const KEY_TOKEN: string = 'token';
const KEY_BASE_URL: string = 'baseUrl';

@ObservedV2
export class AuthStore {
  static readonly instance: AuthStore = new AuthStore();

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
