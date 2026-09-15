import { promptAction } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ConnectionGateway } from '../gateway/ConnectionGateway';
import { RestClient, UnauthorizedError } from '../gateway/RestClient';
import { bridgeConnectUrl } from '../model/Endpoints';
import { SlashCommandSpec } from '../model/Protocol';
import { isSlashInput, matchCommands, mergeCommands } from '../logic/slashCommands';
import { splitChatKey } from '../logic/normalizeEvent';
import { AuthStore } from '../store/AuthStore';
import { ChatStore } from '../store/ChatStore';
import { SessionStore } from '../store/SessionStore';
import { SlashCommandMenu } from './SlashCommandMenu';

const DOMAIN = 0x0000;
const TAG = 'MessageInput';

/**
 * No attachment upload in this first release (spec §2). The send button
 * stays enabled even while the socket is disconnected — the message still
 * goes into the Outbox and is flushed automatically on reconnect
 * (`ConnectionGateway.flushOutbox`), so there is no reason to block the user
 * from composing/queuing while offline.
 */
@ComponentV2
export struct MessageInput {
  @Require @Param chatKey: string = '';
  @Local private text: string = '';
  @Local private session: SessionStore = SessionStore.connect();

  /**
   * `MessageInput` is a single, persistently-mounted instance
   * (`ChatWindow.ets` passes `chatKey: this.session.currentChatKey`, no
   * `.id()` keying, no recreation on chat switch) — so without this, typing
   * `/clear` in chat A, then switching to chat B *before* tapping, leaves
   * the palette open over B's transcript with `this.chatKey` already
   * updated to B. Tapping it then silently clears/reconnects the *wrong*
   * chat (fix round, Important-2) — `/clear` doing that is data loss, not a
   * cosmetic glitch. `@Monitor('chatKey')` is the side-effect tool for this
   * (not a `build()` dependency), fired once per real chat switch.
   *
   * Deliberate trade-off: this clears `text` unconditionally, so an unsent
   * draft does not survive a chat switch. That is the safe default — each
   * chat gets its own blank input rather than accidentally executing/
   * sending stale text against a different chat. Per-chat draft persistence
   * would be nicer but is out of scope for this fix.
   */
  @Monitor('chatKey')
  onChatKeyChanged(_monitor: IMonitor): void {
    this.text = '';
  }

  private send(): void {
    const trimmed: string = this.text.trim();
    if (trimmed.length === 0) {
      return;
    }
    ConnectionGateway.instance.sendMessage(this.chatKey, trimmed);
    this.text = '';
  }

  /**
   * Reads `session.skillCommands` (a public `@Trace` field) directly, which
   * is what makes this method's callers inside `build()` register as V2
   * render-dependency reads — same pattern as `SlashCommandMenu` itself, see
   * that file's class doc.
   *
   * This path's V2 reactivity has been confirmed on-device, so do not "fix"
   * it again: `$$this.text` DOES schedule a re-render. Evidence — a layout
   * dump before and after typing one character shows the 发送 `Button`'s
   * `enabled` attribute flip `false` -> `true`, and that attribute can only
   * come from `.enabled(this.text.trim().length > 0)` below being
   * re-evaluated. Four rounds of ArkUI V2 reactivity fixes have now been
   * spent on this codebase; the fifth candidate turned out to be a probing
   * artifact, not a framework problem. See the field note above
   * `isSlashInput` in `logic/slashCommands.ets` before suspecting reactivity
   * here at all.
   */
  private slashMatches(): SlashCommandSpec[] {
    if (!isSlashInput(this.text)) {
      return [];
    }
    return matchCommands(mergeCommands(this.session.skillCommands), this.text);
  }

  /**
   * `type: 'send'` commands are never auto-sent — they land in the input
   * with a trailing space so the user can keep typing arguments (e.g.
   * `/model switch sonnet`), then presses send themselves. `type: 'local'`
   * commands never touch the wire.
   */
  private pick(spec: SlashCommandSpec): void {
    if (spec.type === 'send') {
      this.text = `${spec.command} `;
      return;
    }
    this.runLocal(spec);
  }

  private runLocal(spec: SlashCommandSpec): void {
    this.text = '';
    if (spec.command === '/clear') {
      // Local view only, and the toast says so. This clears `ChatStore` for
      // this chat and nothing else: the server keeps every message, and
      // because clearing resets `ChatStore.maxSeqOf(chatKey)` to 0, the very
      // next `bridge:manifest` backfill takes the cold-start path and pulls
      // the whole transcript straight back. The command used to read as
      // destructive ("清空聊天记录") while doing none of that. A real delete
      // would need either a server change (out of scope — this branch's
      // defining guarantee is zero server changes) or new persisted local
      // state to remember the cut point across reconnects, so the honest
      // move is to describe what actually happens rather than to imply a
      // deletion that never occurs.
      ChatStore.connect().clear(this.chatKey);
      promptAction.showToast({ message: '已清空本地视图，重新连接后会重新拉取历史' });
    } else if (spec.command === '/settings') {
      // No settings screen exists yet in this codebase — degrading
      // honestly rather than faking a screen: tell the user plainly that
      // there is nothing to open yet, via the same `promptAction.showToast`
      // already used elsewhere (MarkdownView.copyCode), so this adds no new
      // API surface/permission.
      promptAction.showToast({ message: '设置面板尚未实现' });
    } else if (spec.command === '/connect') {
      this.toggleBridge(true);
    } else if (spec.command === '/disconnect') {
      this.toggleBridge(false);
    }
  }

  /**
   * `/connect` and `/disconnect` only ever *request* the bridge state
   * change — the real state (`ConnectionStore.bridgeConnected`) is still
   * driven solely by `bridge:connected`/`bridge:error` events via
   * `ConnectionGateway.dispatch` (see that file), never by this call's own
   * success. That only holds, though, if the request actually reaches the
   * server and the server attempts the dial — if the request never arrives
   * (network down), is rejected outright (401, expired token), or 500s, no
   * WS event ever follows, so the user would tap a command and see nothing,
   * forever, with no explanation (fix round, Important-1). So failure here
   * is surfaced with a toast, same `promptAction.showToast` pattern as
   * `/settings` above and `LoginGate.verify()`, and logged via `hilog`, same
   * posture as every other `RestClient` caller in this codebase
   * (`LoginGate.ets`, `PetImageCache.ets`) — none of them swallow silently.
   */
  private toggleBridge(connect: boolean): void {
    const bridgeId: string = splitChatKey(this.chatKey).connectionId;
    if (bridgeId.length === 0) {
      return;
    }
    const auth: AuthStore = AuthStore.connect();
    const client: RestClient = new RestClient(auth.baseUrl, auth.token);
    // `'{}'`, not `''`: confirmed on-device against the real server that a
    // genuinely empty body here 400s — `RestClient.request()` always sends
    // `Content-Type: application/json` (see RestClient.ets), and Fastify's
    // default JSON body parser rejects an empty body under that
    // content-type (`FST_ERR_CTP_EMPTY_JSON_BODY`). Neither route reads any
    // field off the body (`/api/bridges/:id/connect`/`disconnect` only use
    // `req.params.id`), so an empty JSON object satisfies the parser without
    // implying any payload the server actually consumes.
    client.postJson(bridgeConnectUrl(bridgeId, connect), '{}').catch((err: Error) => {
      const action: string = connect ? '连接' : '断开';
      if (err instanceof UnauthorizedError) {
        hilog.error(DOMAIN, TAG, 'toggleBridge(%{public}s) unauthorized: bridgeId=%{public}s', String(connect), bridgeId);
        promptAction.showToast({ message: `${action}请求失败：登录已过期` });
        // Fix round, Important-5: this 401 previously only toasted and left
        // the app sitting on a dead token — every other 401 path in this
        // codebase (ConnectionGateway.backfillHistory, LoginGate.verify)
        // clears the token and stops the gateway so the user actually lands
        // back on LoginGate instead of staying on a session that can never
        // succeed again. Same two calls, same order, for consistency.
        AuthStore.connect().clear();
        ConnectionGateway.instance.stop();
        return;
      }
      hilog.error(DOMAIN, TAG, 'toggleBridge(%{public}s) failed: bridgeId=%{public}s message=%{public}s',
        String(connect), bridgeId, err.message);
      promptAction.showToast({ message: `${action}请求失败，请检查网络` });
    });
  }

  build() {
    // Anchored ABOVE the input row, not below: on a phone the input sits
    // right against the keyboard, so a downward-opening list would be
    // covered the instant the keyboard is up. Placed as the FIRST child of
    // this Column, directly preceding the input `Row` — normal flow, no
    // absolute positioning: an out-of-flow `.position()`/`.markAnchor()`
    // overlay was tried first and did not render on-device (confirmed via
    // screenshot — nothing appeared even with a non-empty match list), so
    // this component instead accepts the simpler, verified-working
    // trade-off: when the palette is showing, it pushes `MessageList`
    // (this Column's sibling with `layoutWeight(1)` in `ChatWindow`) to
    // shrink rather than overlaying on top of it. Either way the palette
    // sits above the input box and therefore above the keyboard, which is
    // the actual requirement.
    //
    // Corollary, and a trap that already cost one false bug report: because
    // this Column is bottom-anchored (its sibling `MessageList` in
    // `ChatWindow` carries `layoutWeight(1)` and absorbs the change), the
    // palette grows UPWARD and the input row does not move. The 发送 button
    // sits at the SAME y with the palette open and closed — measured on the
    // emulator, `[990,1483][1214,1623]` in both states. "发送 didn't move, so
    // nothing was inserted above it" is therefore not a signal about anything;
    // assert on the palette's own nodes instead (see
    // `harmony/scripts/device-slash-palette-probe.sh`).
    Column() {
      if (this.slashMatches().length > 0) {
        SlashCommandMenu({ input: this.text, onPick: (spec: SlashCommandSpec) => { this.pick(spec); } })
          .width('100%')
      }
      Row({ space: 8 }) {
        TextArea({ placeholder: '输入消息…', text: $$this.text })
          .onChange((value: string) => { this.text = value; })
          .layoutWeight(1)
          .constraintSize({ minHeight: 40, maxHeight: 120 })
          .fontSize(15)
        Button('发送')
          .enabled(this.text.trim().length > 0)
          .onClick(() => { this.send(); })
          .height(40)
      }
      .padding(12)
      .width('100%')
      .alignItems(VerticalAlign.Bottom)
    }
    .width('100%')
  }
}
