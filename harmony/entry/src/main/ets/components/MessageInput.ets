import { ConnectionGateway } from '../gateway/ConnectionGateway';

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

  private send(): void {
    const trimmed: string = this.text.trim();
    if (trimmed.length === 0) {
      return;
    }
    ConnectionGateway.instance.sendMessage(this.chatKey, trimmed);
    this.text = '';
  }

  build() {
    Row({ space: 8 }) {
      TextArea({ placeholder: '输入消息…', text: this.text })
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
}
