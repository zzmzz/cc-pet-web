import { common } from '@kit.AbilityKit';
import { SessionStore } from '../store/SessionStore';
import { NotificationGateway } from '../gateway/NotificationGateway';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { PetMini } from './PetMini';

/**
 * The chat surface: message list over an input bar. Reads
 * `SessionStore.currentChatKey` itself (rather than taking it as a
 * `@Param`) so `Index` and Task 16's breakpoint layouts can drop this in
 * without each having to thread the active chat key through.
 */
@ComponentV2
export struct ChatWindow {
  @Local private session: SessionStore = SessionStore.connect();

  /**
   * First entry into the chat screen (Task 14 brief) — ask once whether
   * notifications may be shown. `NotificationGateway.requestPermission` is
   * itself idempotent and swallows a decline, so this fire-and-forget call
   * never blocks rendering and never throws into the component tree.
   */
  aboutToAppear(): void {
    NotificationGateway.instance.requestPermission(getContext(this) as common.UIAbilityContext);
  }

  build() {
    Column() {
      Row() {
        PetMini()
        Text('cc-pet').fontSize(16).fontWeight(FontWeight.Medium).margin({ left: 8 })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      MessageList({ chatKey: this.session.currentChatKey })
        .layoutWeight(1)
        .width('100%')
      MessageInput({ chatKey: this.session.currentChatKey })
        .width('100%')
    }
    .width('100%')
    .height('100%')
  }
}
