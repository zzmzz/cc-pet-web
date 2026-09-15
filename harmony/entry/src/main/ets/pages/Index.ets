import { AuthStore } from '../store/AuthStore';
import { LoginGate } from '../components/LoginGate';
import { common } from '@kit.AbilityKit';

@Entry
@ComponentV2
struct Index {
  @Local ready: boolean = false;
  // Bumped by LoginGate's onLoggedIn callback. Mutating this @Local field is
  // what actually forces this build() to re-run and re-read the now-updated
  // AuthStore.instance.authorized — see the comment on LoginGate.onLoggedIn.
  @Local loginTick: number = 0;

  async aboutToAppear(): Promise<void> {
    await AuthStore.instance.init(getContext(this) as common.UIAbilityContext);
    this.ready = true;
  }

  build() {
    Column() {
      if (!this.ready) {
        Text('加载中…')
      } else if (!AuthStore.instance.authorized && this.loginTick >= 0) {
        LoginGate({ onLoggedIn: (): void => { this.loginTick += 1; } })
      } else {
        Text(`已登录：${AuthStore.instance.baseUrl}`).fontSize(16)
      }
    }
    .width('100%')
    .height('100%')
  }
}
