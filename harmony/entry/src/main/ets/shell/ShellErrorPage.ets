/**
 * §3: "加载失败的重试入口 — 白屏时用户在 WebView 里无处可点."
 *
 * When the main frame fails to load there is no web UI left to render a retry
 * button, so this one is native. It is also the only route to "换服务器"
 * (§4), kept off the normal screen on purpose so the shell adds no chrome to
 * the web app.
 */
@ComponentV2
export struct ShellErrorPage {
  @Param message: string = '';
  @Param baseUrl: string = '';
  @Event onRetry: () => void = () => {};
  @Event onChangeServer: () => void = () => {};

  build() {
    Column({ space: 16 }) {
      Text('无法打开 cc-pet').fontSize(20).fontWeight(FontWeight.Bold)
      Text(this.baseUrl).fontSize(13).fontColor('#5A5F66').width('100%').textAlign(TextAlign.Center)
      if (this.message.length > 0) {
        Text(this.message).fontSize(13).fontColor(Color.Red).width('100%').textAlign(TextAlign.Center)
      }
      Button('重试').onClick(() => { this.onRetry(); }).width('100%')
      Button('更换服务器')
        .backgroundColor(Color.Transparent)
        .fontColor('#0A59F7')
        .border({ width: 1, color: '#0A59F7' })
        .onClick(() => { this.onChangeServer(); })
        .width('100%')
    }
    .padding(24)
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
