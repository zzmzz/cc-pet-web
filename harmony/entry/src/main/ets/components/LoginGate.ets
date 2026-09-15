import { AuthStore } from '../store/AuthStore';
import { RestClient, UnauthorizedError, NetworkError } from '../gateway/RestClient';
import { Endpoints } from '../model/Endpoints';

interface VerifyRequest {
  token: string;
}

@ComponentV2
export struct LoginGate {
  @Local serverUrl: string = '';
  @Local token: string = '';
  @Local error: string = '';
  @Local busy: boolean = false;

  async verify(): Promise<void> {
    this.busy = true;
    this.error = '';
    try {
      const client: RestClient = new RestClient(this.serverUrl.trim(), this.token.trim());
      // POST with the token in the BODY — not GET with a Bearer header.
      // This endpoint is registered before the auth guard, so it is the one
      // route that authenticates by payload rather than by header.
      const payload: VerifyRequest = { token: this.token.trim() };
      await client.postJson(Endpoints.AUTH_VERIFY.path, JSON.stringify(payload));
      await AuthStore.connect().save(this.serverUrl.trim(), this.token.trim());
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        this.error = 'Token 无效';
      } else if (err instanceof NetworkError) {
        this.error = `无法连接服务器（错误码 ${err.code}）`;
      } else {
        this.error = '无法连接服务器';
      }
    } finally {
      this.busy = false;
    }
  }

  build() {
    Column({ space: 16 }) {
      Text('cc-pet').fontSize(28).fontWeight(FontWeight.Bold)
      TextInput({ placeholder: 'https://your-server', text: this.serverUrl })
        .onChange((value: string) => { this.serverUrl = value; })
        .enableAutoFill(false)
        .width('100%')
      TextInput({ placeholder: 'Token', text: this.token })
        .type(InputType.Password)
        .onChange((value: string) => { this.token = value; })
        .enableAutoFill(false)
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
