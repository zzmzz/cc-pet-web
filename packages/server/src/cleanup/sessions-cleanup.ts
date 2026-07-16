import type { SessionStore } from '../storage/sessions.js';
import type Database from 'better-sqlite3';
import { makeChatKey } from '@cc-pet/shared';

export class SessionsCleanup {
  private readonly CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly RESIDENT_MESSAGE_CAP = 500;

  constructor(private sessionStore: SessionStore, private db: Database.Database) {}

  /**
   * 删除指定天数之前没有活跃的会话
   * @param daysThreshold 超过多少天没有交互的会话将被删除，默认为10天
   */
  cleanupInactiveSessions(daysThreshold: number = 10): number {
    const thresholdTime = Date.now() - (daysThreshold * 24 * 60 * 60 * 1000);

    // 查找所有最后活跃时间早于阈值的会话
    const sessionsToDelete = this.db.prepare(`
      SELECT connection_id, key
      FROM sessions
      WHERE last_active_at < ?
        AND (is_resident IS NULL OR is_resident = 0)
    `).all(thresholdTime) as { connection_id: string; key: string }[];

    let deletedCount = 0;

    // 删除这些会话
    for (const session of sessionsToDelete) {
      try {
        this.sessionStore.delete(session.connection_id, session.key);
        deletedCount++;
      } catch (error) {
        console.error(`Failed to delete session ${session.connection_id}/${session.key}:`, error);
      }
    }

    return deletedCount;
  }

  /**
   * 将每个常驻会话的历史消息裁剪到最多 maxMessages 条，删除更早的消息。
   * 普通会话不受影响（它们由 cleanupInactiveSessions 按不活跃天数整删）。
   * @returns 删除的消息总条数
   */
  trimResidentMessages(maxMessages: number = this.RESIDENT_MESSAGE_CAP): number {
    const residents = this.db.prepare(`
      SELECT connection_id, key FROM sessions WHERE is_resident = 1
    `).all() as { connection_id: string; key: string }[];

    const trim = this.db.prepare(`
      DELETE FROM messages
      WHERE chat_key = ?
        AND id NOT IN (
          SELECT id FROM messages WHERE chat_key = ?
          ORDER BY timestamp DESC, id DESC
          LIMIT ?
        )
    `);

    let deletedCount = 0;
    for (const r of residents) {
      const chatKey = makeChatKey(r.connection_id, r.key);
      try {
        const info = trim.run(chatKey, chatKey, maxMessages);
        deletedCount += info.changes;
      } catch (error) {
        console.error(`Failed to trim resident messages for ${chatKey}:`, error);
      }
    }
    return deletedCount;
  }

  /**
   * 启动定时清理任务
   */
  startCleanupSchedule(daysThreshold: number = 10): NodeJS.Timeout {
    console.log(`Starting session cleanup task (will run daily, removing sessions inactive for ${daysThreshold} days)`);

    // 立即运行一次清理
    try {
      const deletedCount = this.cleanupInactiveSessions(daysThreshold);
      const trimmed = this.trimResidentMessages();
      console.log(`Initial session cleanup completed. Deleted ${deletedCount} inactive sessions, trimmed ${trimmed} resident messages.`);
    } catch (error) {
      console.error('Initial session cleanup failed:', error);
    }

    // 设置定时任务
    const intervalId = setInterval(() => {
      try {
        const deletedCount = this.cleanupInactiveSessions(daysThreshold);
        const trimmed = this.trimResidentMessages();
        console.log(`Daily session cleanup completed. Deleted ${deletedCount} inactive sessions, trimmed ${trimmed} resident messages.`);
      } catch (error) {
        console.error('Daily session cleanup failed:', error);
      }
    }, this.CLEANUP_INTERVAL_MS);

    return intervalId;
  }
}