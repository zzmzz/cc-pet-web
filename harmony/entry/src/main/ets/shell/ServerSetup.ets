import { normalizeBaseUrl, BaseUrlResult } from './normalizeBaseUrl';
import { probeServer, ProbeResult } from './probeServer';

/**
 * The one native screen in the product, and the reason it has to be native is
 * the chicken-and-egg in §3: the page itself is loaded FROM this address.
 *
 * It asks for an address and nothing else. No token field — the web app owns
 * login, and §4 forbids the shell from holding a token.
 *
 * Unlike the WebView, this IS visible to `uitest` (native components are), so
 * it is the only part of the shell that can be asserted automatically. The
 * strings below are therefore load-bearing for `scripts/device-shell-probe.sh`.
 */
@ComponentV2
export struct ServerSetup {
  @Param initialUrl: string = '';
  @Param allowCancel: boolean = false;
  @Event onConfirmed: (url: string) => void = (_url: string) => {};
  @Event onCancelled: () => void = () => {};

  @Local input: string = '';
  @Local error: string = '';
  @Local busy: boolean = false;

  aboutToAppear(): void {
    this.input = this.initialUrl;
  }

  private async connect(): Promise<void> {
    this.busy = true;
    this.error = '';
    const normalized: BaseUrlResult = normalizeBaseUrl(this.input);
    if (normalized.error.length > 0) {
      this.error = normalized.error;
      this.busy = false;
      return;
    }
    const probe: ProbeResult = await probeServer(normalized.url);
    this.busy = false;
    if (!probe.ok) {
      this.error = probe.error;
      return;
    }
    this.onConfirmed(normalized.url);
  }

  build() {
    Column({ space: 16 }) {
      Text('cc-pet').fontSize(28).fontWeight(FontWeight.Bold)
      Text('输入 cc-pet 服务器地址').fontSize(14).fontColor('#5A5F66')
      TextInput({ placeholder: 'https://your-server', text: this.input })
        .onChange((value: string) => { this.input = value; })
        .enableAutoFill(false)
        .enterKeyType(EnterKeyType.Go)
        .onSubmit(() => { this.connect(); })
        .width('100%')
      if (this.error.length > 0) {
        Text(this.error).fontColor(Color.Red).fontSize(13).width('100%')
      }
      Button(this.busy ? '连接中…' : '连接')
        .enabled(!this.busy && this.input.length > 0)
        .onClick(() => { this.connect(); })
        .width('100%')
      if (this.allowCancel) {
        Button('取消')
          .backgroundColor(Color.Transparent)
          .fontColor('#5A5F66')
          .enabled(!this.busy)
          .onClick(() => { this.onCancelled(); })
          .width('100%')
      }
    }
    .padding(24)
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
