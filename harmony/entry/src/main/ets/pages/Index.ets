import { AuthStore } from '../store/AuthStore';
import { LoginGate } from '../components/LoginGate';
import { common } from '@kit.AbilityKit';

@Entry
@ComponentV2
struct Index {
  @Local ready: boolean = false;
  // Holding the singleton via @Local is what lets ArkUI V2 track this
  // component as an observer of AuthStore's @Trace fields — reading
  // AuthStore.instance.* directly in build() does not register a
  // dependency, so mutations elsewhere (e.g. LoginGate.verify()) would
  // never re-render this page live. See docs/superpowers/plans/
  // 2026-09-15-harmony-client.md for the full writeup.
  @Local auth: AuthStore = AuthStore.instance;

  async aboutToAppear(): Promise<void> {
    await AuthStore.instance.init(getContext(this) as common.UIAbilityContext);
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
