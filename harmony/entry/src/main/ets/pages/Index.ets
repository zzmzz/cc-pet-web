import { AuthStore } from '../store/AuthStore';
import { LoginGate } from '../components/LoginGate';
import { common } from '@kit.AbilityKit';

@Entry
@ComponentV2
struct Index {
  @Local ready: boolean = false;
  // `AuthStore.connect()` (AppStorageV2-backed) is required here, not a
  // bare static singleton — see AuthStore.ets for why. Holding the result
  // via @Local is what lets ArkUI V2 track this component as an observer
  // of AuthStore's @Trace fields.
  @Local auth: AuthStore = AuthStore.connect();

  async aboutToAppear(): Promise<void> {
    await this.auth.init(getContext(this) as common.UIAbilityContext);
    this.ready = true;
  }

  build() {
    Column() {
      if (!this.ready) {
        Text('加载中…')
      } else if (!this.auth.authorized) {
        LoginGate()
      } else {
        Text(`已登录：${this.auth.baseUrl}`).fontSize(16)
      }
    }
    .width('100%')
    .height('100%')
  }
}
