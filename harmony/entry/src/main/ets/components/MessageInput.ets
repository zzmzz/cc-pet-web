import { promptAction } from '@kit.ArkUI';
import { ConnectionGateway } from '../gateway/ConnectionGateway';
import { RestClient } from '../gateway/RestClient';
import { bridgeConnectUrl } from '../model/Endpoints';
import { SlashCommandSpec } from '../model/Protocol';
import { isSlashInput, matchCommands, mergeCommands } from '../logic/slashCommands';
import { AuthStore } from '../store/AuthStore';
import { ChatStore } from '../store/ChatStore';
import { SessionStore } from '../store/SessionStore';
import { SlashCommandMenu } from './SlashCommandMenu';

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
      ChatStore.connect().clear(this.chatKey);
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
   * `/connect` and `/disconnect` only ever request the bridge state change —
   * the real state (`ConnectionStore.bridgeConnected`) is driven solely by
   * `bridge:connected`/`bridge:error` events via `ConnectionGateway.dispatch`
   * (see that file), never by this call's own success/failure. So this is
   * fire-and-forget, same posture as `MarkdownView.openLink`/`copyCode`.
   */
  private toggleBridge(connect: boolean): void {
    const bridgeId: string = this.chatKey.split('::')[0] ?? '';
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
    client.postJson(bridgeConnectUrl(bridgeId, connect), '{}').catch(() => {
      // Best-effort; see doc above for why no UI feedback is wired to this
      // specific promise.
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
