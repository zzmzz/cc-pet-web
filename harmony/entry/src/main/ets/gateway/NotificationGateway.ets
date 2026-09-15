import { common, wantAgent, WantAgent } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { notificationManager } from '@kit.NotificationKit';

const BUNDLE_NAME: string = 'com.ccpet.client';
const ENTRY_ABILITY_NAME: string = 'EntryAbility';

/**
 * Publishes local notifications for assistant replies. Whether a reply
 * *deserves* a notification is decided entirely by
 * `ConnectionGateway.afterAssistantReply` (the same `isAway` predicate that
 * drives unread counting, per spec 6.3) — this gateway's job starts after
 * that decision is made: publish what it's told, and stay out of the
 * "should I" question so there is exactly one place that answers it.
 *
 * Interface change from the Task 11 placeholder: `notifyReply` gained a
 * leading `chatKey` parameter. The Task 14 brief calls for the notification
 * `id` to be derived from `chatKey` so repeat replies in the same chat
 * replace the existing notification instead of stacking a new one —
 * `title`/`body` alone can't provide a stable per-chat id (two chats can
 * share a label, and a label isn't guaranteed distinct from its chatKey),
 * so `chatKey` had to be threaded through. Reported as a contract change in
 * docs/superpowers/plans/2026-09-15-harmony-client.md (Task 11 and Task 14
 * Interfaces blocks), the same way `outboxEntriesOf` was handled in Task 12.
 */
export class NotificationGateway {
  static readonly instance: NotificationGateway = new NotificationGateway();

  private permissionRequested: boolean = false;

  /**
   * Requests notification enablement once, meant to be called on first
   * entry into the chat screen (see `ChatWindow.aboutToAppear`).
   * Idempotent — a later remount of the chat screen (e.g. logout/login)
   * does not re-prompt.
   *
   * A decline is not treated as an error: it is not retried, and
   * `notifyReply` below checks `isNotificationEnabledSync()` before every
   * publish, so a user who says no simply never sees a notification — the
   * chat itself keeps working exactly the same either way.
   */
  async requestPermission(context: common.UIAbilityContext): Promise<void> {
    if (this.permissionRequested) {
      return;
    }
    this.permissionRequested = true;
    try {
      if (notificationManager.isNotificationEnabledSync()) {
        return;
      }
      await notificationManager.requestEnableNotification(context);
    } catch (err) {
      const error: BusinessError = err as BusinessError;
      console.warn(`[cc-pet] requestEnableNotification failed: code=${error.code ?? -1}`);
    }
  }

  /**
   * Publishes (or, for a repeat reply in the same chat, replaces — same
   * `id` updates rather than stacks) a basic-text local notification.
   *
   * Never rejects: `ConnectionGateway.afterAssistantReply` fires this
   * without awaiting it, so any failure here — permission declined,
   * publish() erroring for some other reason — is logged and swallowed
   * rather than surfacing as an unhandled rejection or, worse, a broken
   * chat screen.
   */
  async notifyReply(chatKey: string, title: string, body: string): Promise<void> {
    const notificationId: number = this.notificationIdOf(chatKey);
    try {
      if (!notificationManager.isNotificationEnabledSync()) {
        return;
      }
      const agent: WantAgent = await wantAgent.getWantAgent({
        wants: [{ bundleName: BUNDLE_NAME, abilityName: ENTRY_ABILITY_NAME }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: notificationId,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG],
      });
      const request: notificationManager.NotificationRequest = {
        id: notificationId,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: { title: title, text: body },
        },
        wantAgent: agent,
      };
      await notificationManager.publish(request);
    } catch (err) {
      const error: BusinessError = err as BusinessError;
      console.warn(`[cc-pet] notification publish failed: code=${error.code ?? -1}`);
    }
  }

  /**
   * Deterministic hash so the same chatKey always maps to the same
   * notification id — that's what makes `publish()` update an existing
   * notification instead of creating a new one for a second reply in the
   * same chat (spec 6.3 / Task 14 brief).
   */
  private notificationIdOf(chatKey: string): number {
    let hash: number = 0;
    for (let i = 0; i < chatKey.length; i += 1) {
      hash = (hash * 31 + chatKey.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }
}
