import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { promptAction } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { ShellStore } from '../shell/ShellStore';
import { ServerSetup } from '../shell/ServerSetup';
import { ShellErrorPage } from '../shell/ShellErrorPage';

const DOMAIN = 0x0000;
const TAG = 'Shell';

/**
 * Named `ShellScreen`, and the field below `screen`, because `overlay` is
 * already a method on `CustomComponent` — a `@Local overlay` compiles under
 * `hvigorw test` and then fails `assembleHap` with "Property 'overlay' in
 * type 'Shell' is not assignable to the same property in base type
 * 'CustomComponent'".
 */
enum ShellScreen {
  WEB,
  SETUP,
  ERROR,
}

/**
 * The entire HarmonyOS client, as of the WebView-shell decision
 * (docs/superpowers/specs/2026-09-16-harmony-webview-shell-design.md):
 * one `Web` component pointed at `packages/web`, which `packages/server`
 * already serves at `/`.
 *
 * The native ArkTS port still in `ets/components|store|gateway` is no longer
 * reachable from here — `pages/Index` stays in `main_pages.json` so it keeps
 * compiling and its 227 unit tests keep running, but nothing routes to it.
 *
 * Everything this file does is something the web app physically cannot do for
 * itself (§3 of the design). Do not add anything else: every capability the
 * shell duplicates is a place the two implementations can drift, and removing
 * drift is the only reason this approach was chosen over the native port.
 */
@Entry
@ComponentV2
struct Shell {
  private controller: webview.WebviewController = new webview.WebviewController();
  @Local shell: ShellStore = ShellStore.connect();
  @Local screen: ShellScreen = ShellScreen.WEB;
  @Local loadError: string = '';
  /**
   * `Web({ src })` is read once at construction; later address changes go
   * through `controller.loadUrl()` instead. Keeping the component mounted is
   * what lets "更换服务器" and "重试" avoid tearing down (and re-attaching)
   * the controller, and keeps the in-page state of a transient failure.
   */
  @Local bootUrl: string = '';
  private controllerAttached: boolean = false;

  async aboutToAppear(): Promise<void> {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    await this.shell.init(context);
    if (this.shell.baseUrl.length === 0) {
      this.screen = ShellScreen.SETUP;
    } else {
      this.bootUrl = this.shell.baseUrl;
    }
  }

  /**
   * §5: without this the system back key exits the app outright, because
   * hardware keys never reach the WebView. `accessBackward()` throws if the
   * controller has not been attached yet (cold start, error screen), hence
   * the `controllerAttached` guard AND the catch — a throw out of
   * `onBackPress` would take the app down instead of just exiting the page.
   */
  onBackPress(): boolean {
    if (this.screen === ShellScreen.SETUP && this.shell.baseUrl.length > 0) {
      this.screen = ShellScreen.WEB;
      return true;
    }
    if (this.screen !== ShellScreen.WEB || !this.controllerAttached) {
      return false;
    }
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch (err) {
      const businessError: BusinessError = err as BusinessError;
      hilog.error(DOMAIN, TAG, 'accessBackward/backward threw: code=%{public}d message=%{public}s',
        businessError.code, businessError.message);
    }
    return false;
  }

  private onConfirmed(url: string): void {
    this.loadError = '';
    this.screen = ShellScreen.WEB;
    this.shell.save(url);
    if (this.bootUrl.length === 0) {
      this.bootUrl = url;
      return;
    }
    this.loadUrlSafely(url);
  }

  private loadUrlSafely(url: string): void {
    if (!this.controllerAttached) {
      return;
    }
    try {
      this.controller.loadUrl(url);
    } catch (err) {
      const businessError: BusinessError = err as BusinessError;
      hilog.error(DOMAIN, TAG, 'loadUrl threw: code=%{public}d message=%{public}s',
        businessError.code, businessError.message);
    }
  }

  /**
   * §3: `<input type="file">` renders inside the WebView but ArkWeb will not
   * open a system picker on its own — without this handler the tap is simply
   * swallowed and the attachment button in `packages/web`'s MessageInput
   * looks broken. Returning `true` claims the event; `handleFileList` MUST be
   * called on every path including cancellation, or the web `<input>` stays
   * blocked forever.
   */
  private async pickFiles(param: FileSelectorParam, result: FileSelectorResult): Promise<void> {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    options.maxSelectNumber = param.getMode() === FileSelectorMode.FileOpenMultipleMode ? 9 : 1;
    try {
      const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
      const uris: Array<string> = await documentPicker.select(options);
      hilog.info(DOMAIN, TAG, 'file selector returned %{public}d uri(s)', uris.length);
      result.handleFileList(uris);
    } catch (err) {
      const businessError: BusinessError = err as BusinessError;
      hilog.info(DOMAIN, TAG, 'file selector cancelled or failed: code=%{public}d message=%{public}s',
        businessError.code, businessError.message);
      result.handleFileList([]);
    }
  }

  /**
   * §3: a download started inside the WebView has nowhere to go unless the
   * shell names a destination. Files land in the app's own sandbox so no
   * storage permission is needed — `module.json5` still declares exactly the
   * two permissions Task 10 added, and this must not change that.
   *
   * Exercised end to end by `harmony/scripts/device-download-probe.sh`, which
   * drives the real path: the bridge fixture sends a file, `packages/server`
   * persists it, and `packages/web` renders
   * `<a href="blob:…" download target="_blank">`. ArkWeb turns that anchor into
   * a download and this delegate catches it. Same-origin hrefs and `data:` URLs
   * were measured too; all five shapes reach `onBeforeDownload`.
   *
   * KNOWN LIMIT, deliberately not fixed here: `filesDir` is inside the app
   * sandbox, so "已保存 <name>" names a file the user cannot open from any file
   * manager. Making it useful means routing through
   * `picker.DocumentViewPicker.save()` (which needs no new permission, unlike
   * writing to the public Downloads directory) and deferring `item.start()`
   * until the user picks a location. That is a behaviour change, not a fix to
   * an unverified code path, so it is left as a named follow-up rather than
   * smuggled in here.
   */
  private installDownloadDelegate(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    const delegate: webview.WebDownloadDelegate = new webview.WebDownloadDelegate();
    delegate.onBeforeDownload((item: webview.WebDownloadItem) => {
      const name: string = item.getSuggestedFileName();
      const path: string = `${context.filesDir}/downloads/${name}`;
      // Logged, not silent: the sandbox directory this writes to is not
      // readable by `hdc shell` (the app's uid owns it), so hilog is the only
      // way anyone can see whether a download actually started. Without these
      // three lines this whole delegate is unobservable on a device, which is
      // exactly how it shipped unverified the first time.
      hilog.info(DOMAIN, TAG, 'download start: name=%{public}s path=%{public}s', name, path);
      item.start(path);
    });
    delegate.onDownloadFinish((item: webview.WebDownloadItem) => {
      hilog.info(DOMAIN, TAG, 'download finish: name=%{public}s size=%{public}s',
        item.getSuggestedFileName(), `${item.getTotalBytes()}`);
      promptAction.showToast({ message: `已保存 ${item.getSuggestedFileName()}` });
    });
    delegate.onDownloadFailed((item: webview.WebDownloadItem) => {
      hilog.error(DOMAIN, TAG, 'download failed: name=%{public}s code=%{public}s',
        item.getSuggestedFileName(), `${item.getLastErrorCode()}`);
      promptAction.showToast({ message: `下载失败：${item.getSuggestedFileName()}` });
    });
    try {
      this.controller.setDownloadDelegate(delegate);
    } catch (err) {
      const businessError: BusinessError = err as BusinessError;
      hilog.error(DOMAIN, TAG, 'setDownloadDelegate threw: code=%{public}d message=%{public}s',
        businessError.code, businessError.message);
    }
  }

  build() {
    Stack() {
      if (this.bootUrl.length > 0) {
        this.WebLayer()
      }
      if (!this.shell.ready) {
        Text('加载中…').fontSize(14).fontColor('#5A5F66')
      } else if (this.screen === ShellScreen.SETUP) {
        Column() {
          ServerSetup({
            initialUrl: this.shell.baseUrl,
            allowCancel: this.shell.baseUrl.length > 0,
            onConfirmed: (url: string): void => { this.onConfirmed(url); },
            onCancelled: (): void => { this.screen = ShellScreen.WEB; },
          })
        }
        .width('100%').height('100%').backgroundColor(Color.White)
      } else if (this.screen === ShellScreen.ERROR) {
        Column() {
          ShellErrorPage({
            message: this.loadError,
            baseUrl: this.shell.baseUrl,
            onRetry: (): void => {
              this.loadError = '';
              this.screen = ShellScreen.WEB;
              this.loadUrlSafely(this.shell.baseUrl);
            },
            onChangeServer: (): void => { this.screen = ShellScreen.SETUP; },
          })
        }
        .width('100%').height('100%').backgroundColor(Color.White)
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  WebLayer() {
    Web({ src: this.bootUrl, controller: this.controller })
      .width('100%')
      .height('100%')
      // §6 of the design. Each of these exists for a named reason:
      .domStorageAccess(true)     // the web app keeps its token in localStorage
      .databaseAccess(true)
      .fileAccess(true)
      .geolocationAccess(false)   // nothing in packages/web asks for location
      // NOT MixedMode.All. The spike used All to reach a plain-http fixture;
      // None still allows an http *page* (which is how the fixture stack is
      // reachable) and only blocks http subresources inside an https page.
      .mixedMode(MixedMode.None)
      .onControllerAttached(() => {
        this.controllerAttached = true;
        this.installDownloadDelegate();
      })
      .onErrorReceive((event: OnErrorReceiveEvent) => {
        const url: string = event.request.getRequestUrl();
        const mainFrame: boolean = event.request.isMainFrame();
        hilog.error(DOMAIN, TAG, 'web error: main=%{public}s code=%{public}d info=%{public}s url=%{public}s',
          `${mainFrame}`, event.error.getErrorCode(), event.error.getErrorInfo(), url);
        if (mainFrame) {
          this.loadError = `${event.error.getErrorInfo()}（${event.error.getErrorCode()}）`;
          this.screen = ShellScreen.ERROR;
        }
      })
      .onHttpErrorReceive((event: OnHttpErrorReceiveEvent) => {
        // Logged for every subresource, not just the main frame: §7 item 5 is
        // "what was that 404 the spike saw", and the only way to answer that
        // on a device whose WebView `uitest` cannot see is to have the URL in
        // hilog. Keep this — it is the shell's only window into the page.
        const code: number = event.response.getResponseCode();
        const url: string = event.request.getRequestUrl();
        const mainFrame: boolean = event.request.isMainFrame();
        hilog.warn(DOMAIN, TAG, 'web http error: main=%{public}s status=%{public}d url=%{public}s',
          `${mainFrame}`, code, url);
        if (mainFrame && code >= 400) {
          this.loadError = `服务器返回 HTTP ${code}`;
          this.screen = ShellScreen.ERROR;
        }
      })
      .onShowFileSelector((event: OnShowFileSelectorEvent): boolean => {
        this.pickFiles(event.fileSelector, event.result);
        return true;
      })
  }
}
