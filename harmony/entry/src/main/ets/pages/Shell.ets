import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { fileIo, picker } from '@kit.CoreFileKit';
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
   * guid → the document-provider URI the user picked for that download.
   * `onBeforeDownload` and `onDownloadFinish` are handed different
   * `WebDownloadItem` objects for the same download, so the destination has to
   * be carried across by `getGuid()`, which is stable for the download's life.
   * Entries are removed in `publishDownload`; a cancelled pick never adds one.
   */
  private downloadTargets: Map<string, string> = new Map<string, string>();

  /**
   * §3 follow-up: the first version called `item.start()` on a sandbox path
   * synchronously inside `onBeforeDownload` and then toasted "已保存 <name>" —
   * true about the write finishing, false about the user being able to reach
   * it, because `filesDir` is owned by the app's uid and no file manager can
   * open it. So the shell asks the user where to put it, with the same
   * `DocumentViewPicker` already used for uploads in `pickFiles` — no new
   * permission is declared.
   *
   * MEASURED ON THE EMULATOR, and it is the reason this is two steps rather
   * than one: `item.start(<the picker's uri>)` does NOT work. Passing
   * `file://docs/storage/Users/currentUser/Download/x.txt` straight to
   * `start()` throws nothing and reports success —
   * `download finish ... totalBytes=380 receivedBytes=380` — but
   * `getFullPath()` comes back as
   * `/data/storage/el2/base/cache/web/Temp/x.txt` and the file the picker
   * created in Download stays **0 bytes**. `start()` wants a filesystem path,
   * not a document URI; given a URI it silently keeps the bytes in ArkWeb's
   * own temp dir. A shell that stopped there would toast 已保存 over an empty
   * file, which is worse than the sandbox it was meant to fix.
   *
   * So: pick the destination, `start()` into the sandbox (a path `start()`
   * does honour), and copy sandbox → picked URI in `publishDownload` once the
   * bytes are actually there. The copy is the load-bearing half — measured,
   * `start(<uri>)` followed by the same copy also lands the right bytes,
   * because the copy reads from `getFullPath()` either way. `start()` is given
   * the sandbox path anyway so the source is a path this file chose and can
   * delete, rather than ArkWeb's undocumented Temp directory.
   *
   * See `harmony/scripts/device-download-probe.sh`: it asserts on the
   * destination file's *size*, and was run against a build with the copy
   * removed to confirm it fails there.
   */
  private async chooseDownloadDestination(item: webview.WebDownloadItem): Promise<void> {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    const name: string = item.getSuggestedFileName();
    const options: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
    options.newFileNames = [name];
    try {
      const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
      const uris: Array<string> = await documentPicker.save(options);
      if (uris.length === 0) {
        // Observed on the emulator when the save sheet is dismissed without
        // an explicit cancel error — treat "nothing chosen" the same as a
        // cancellation rather than starting a download with no destination.
        hilog.info(DOMAIN, TAG, 'download destination: picker returned no uri, cancelling');
        item.cancel();
        return;
      }
      const target: string = uris[0];
      hilog.info(DOMAIN, TAG, 'download destination chosen: name=%{public}s uri=%{public}s', name, target);
      this.downloadTargets.set(item.getGuid(), target);
      item.start(`${context.filesDir}/downloads/${name}`);
    } catch (err) {
      // The user backing out of the save sheet lands here (BusinessError),
      // not in onDownloadFailed — the download never started, so there is
      // nothing for the delegate's other callbacks to report.
      const businessError: BusinessError = err as BusinessError;
      hilog.info(DOMAIN, TAG, 'download destination cancelled or failed: name=%{public}s code=%{public}d message=%{public}s',
        name, businessError.code, businessError.message);
      item.cancel();
    }
  }

  /**
   * The second half of the download: the bytes are in the sandbox, the user's
   * chosen destination is a document-provider URI, and `fileIo.openSync`
   * accepts that URI where `WebDownloadItem.start` does not. Only after the
   * copy lands does the shell say 已保存 — the toast has to describe a file
   * the user can actually open, which is the whole point of the picker.
   */
  private publishDownload(item: webview.WebDownloadItem): void {
    const name: string = item.getSuggestedFileName();
    const guid: string = item.getGuid();
    const sandboxPath: string = item.getFullPath();
    const target: string | undefined = this.downloadTargets.get(guid);
    this.downloadTargets.delete(guid);
    if (target === undefined) {
      // Nothing recorded means the download was never routed through the
      // picker, so there is nowhere reachable to put it. Do not claim 已保存.
      hilog.error(DOMAIN, TAG, 'download finished with no recorded destination: name=%{public}s', name);
      promptAction.showToast({ message: `下载失败：${name}` });
      return;
    }
    let file: fileIo.File | undefined = undefined;
    try {
      file = fileIo.openSync(target, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
      fileIo.copyFileSync(sandboxPath, file.fd);
      hilog.info(DOMAIN, TAG, 'download saved: name=%{public}s uri=%{public}s', name, target);
      promptAction.showToast({ message: `已保存 ${name}` });
    } catch (err) {
      const businessError: BusinessError = err as BusinessError;
      hilog.error(DOMAIN, TAG, 'download copy to picked destination failed: name=%{public}s code=%{public}d message=%{public}s',
        name, businessError.code, businessError.message);
      promptAction.showToast({ message: `下载失败：${name}` });
    } finally {
      if (file !== undefined) {
        try {
          fileIo.closeSync(file);
        } catch (closeErr) {
          hilog.warn(DOMAIN, TAG, 'closing the download destination threw: code=%{public}d',
            (closeErr as BusinessError).code);
        }
      }
      // The sandbox copy has served its purpose; leaving it behind would grow
      // the app's data directory by every file the user ever downloaded.
      try {
        fileIo.unlinkSync(sandboxPath);
      } catch (unlinkErr) {
        hilog.warn(DOMAIN, TAG, 'removing the sandbox copy threw: code=%{public}d',
          (unlinkErr as BusinessError).code);
      }
    }
  }

  /**
   * §3: a download started inside the WebView has nowhere to go unless the
   * shell names a destination. `onBeforeDownload`'s callback type is
   * synchronous (`Callback<WebDownloadItem>`), so `chooseDownloadDestination`
   * is fired without an `await` here — the same pattern `onShowFileSelector`
   * already uses for `pickFiles` below, which also has to run a picker beyond
   * the event's own synchronous return.
   *
   * Exercised end to end by `harmony/scripts/device-download-probe.sh`, which
   * drives the real path: the bridge fixture sends a file, `packages/server`
   * persists it, and `packages/web` renders
   * `<a href="blob:…" download target="_blank">`. ArkWeb turns that anchor into
   * a download and this delegate catches it. Same-origin hrefs and `data:` URLs
   * were measured too; all five shapes reach `onBeforeDownload`.
   */
  private installDownloadDelegate(): void {
    const delegate: webview.WebDownloadDelegate = new webview.WebDownloadDelegate();
    delegate.onBeforeDownload((item: webview.WebDownloadItem) => {
      // Logged, not silent: once start() targets a user-chosen document
      // provider URI instead of the sandbox, `hdc shell` still cannot list
      // it, so hilog remains the only outside view of what happened.
      hilog.info(DOMAIN, TAG, 'download start: name=%{public}s', item.getSuggestedFileName());
      this.chooseDownloadDestination(item);
    });
    delegate.onDownloadFinish((item: webview.WebDownloadItem) => {
      // getFullPath()/getReceivedBytes() logged alongside getTotalBytes(), and
      // they earned their place: it was exactly this triple that exposed
      // `start(<uri>)` reporting receivedBytes=380 while fullPath pointed at
      // ArkWeb's Temp dir and the user's file stayed empty. The
      // suggested-name + totalBytes pair alone could not tell those apart.
      hilog.info(DOMAIN, TAG,
        'download finish: name=%{public}s totalBytes=%{public}s receivedBytes=%{public}s fullPath=%{public}s',
        item.getSuggestedFileName(), `${item.getTotalBytes()}`, `${item.getReceivedBytes()}`, item.getFullPath());
      this.publishDownload(item);
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
