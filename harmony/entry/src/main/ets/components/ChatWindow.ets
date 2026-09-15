import { common } from '@kit.AbilityKit';
import { SessionStore } from '../store/SessionStore';
import { NotificationGateway } from '../gateway/NotificationGateway';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';

/**
 * The chat surface: message list over an input bar. Reads
 * `SessionStore.currentChatKey` itself (rather than taking it as a
 * `@Param`) so `Index` and the breakpoint layouts in `Index.ets` can drop
 * this in without each having to thread the active chat key through.
 *
 * No header here (past a certain point this used to render its own
 * PetMini + title row) — Task 16's three-band layout put a single shared
 * top bar (PetMini + session label + ConnectionBadge + settings) in
 * `Index.ets` instead, present above this component in every band, so the
 * pet mascot appears exactly once regardless of whether the session
 * switcher is a sidebar or a bottom sheet.
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
