import { SessionStore } from '../store/SessionStore';
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
