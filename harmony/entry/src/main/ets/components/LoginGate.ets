import { AuthStore } from '../store/AuthStore';
import { RestClient, UnauthorizedError } from '../gateway/RestClient';

interface VerifyRequest {
  token: string;
}

@ComponentV2
export struct LoginGate {
  @Local serverUrl: string = '';
  @Local token: string = '';
  @Local error: string = '';
  @Local busy: boolean = false;
  // On-device testing showed that mutating the AuthStore singleton's
  // @Trace fields from here does not, by itself, cause the parent Index
  // page's conditional (`!AuthStore.instance.authorized`) to re-evaluate
  // live in the same session — the value IS correct (a cold restart reads
  // it fine), but the cross-component ObservedV2 dependency does not
  // propagate on this build. An explicit callback forces the parent to
  // re-render after a successful login.
  @Param onLoggedIn: () => void = () => {};

  async verify(): Promise<void> {
    this.busy = true;
    this.error = '';
    try {
      const client: RestClient = new RestClient(this.serverUrl.trim(), this.token.trim());
      // POST with the token in the BODY — not GET with a Bearer header.
      // This endpoint is registered before the auth guard, so it is the one
      // route that authenticates by payload rather than by header.
      const payload: VerifyRequest = { token: this.token.trim() };
      await client.postJson('/api/auth/verify', JSON.stringify(payload));
      await AuthStore.instance.save(this.serverUrl.trim(), this.token.trim());
      this.onLoggedIn();
    } catch (err) {
      this.error = err instanceof UnauthorizedError ? 'Token 无效' : '无法连接服务器';
    } finally {
      this.busy = false;
    }
  }

  build() {
    Column({ space: 16 }) {
      Text('cc-pet').fontSize(28).fontWeight(FontWeight.Bold)
      TextInput({ placeholder: 'https://your-server', text: this.serverUrl })
        .onChange((value: string) => { this.serverUrl = value; })
        .width('100%')
      TextInput({ placeholder: 'Token', text: this.token })
        .type(InputType.Password)
        .onChange((value: string) => { this.token = value; })
        .width('100%')
      if (this.error.length > 0) {
        Text(this.error).fontColor(Color.Red).fontSize(13)
      }
      Button(this.busy ? '验证中…' : '登录')
        .enabled(!this.busy && this.serverUrl.length > 0 && this.token.length > 0)
        .onClick(() => { this.verify(); })
        .width('100%')
    }
    .padding(24)
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
