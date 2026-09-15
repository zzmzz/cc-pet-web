import { SessionStore } from '../store/SessionStore';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';

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
