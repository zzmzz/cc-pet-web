import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SessionStore } from '../src/storage/sessions.js';
import { SessionsCleanup } from '../src/cleanup/sessions-cleanup.js';

describe('SessionsCleanup', () => {
  let db: Database.Database;
  let sessionStore: SessionStore;
  let sessionsCleanup: SessionsCleanup;

  beforeEach(() => {
    db = new Database(':memory:');

    // 初始化数据库模式
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        connection_id TEXT NOT NULL,
        key TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        PRIMARY KEY (connection_id, key)
      );
    `);

    sessionStore = new SessionStore(db);
    sessionsCleanup = new SessionsCleanup(sessionStore, db);
  });

  afterEach(() => {
    db.close();
  });

  it('should delete sessions older than the specified threshold', () => {
    const now = Date.now();
    const tenDaysAgo = now - (10 * 24 * 60 * 60 * 1000);
    const elevenDaysAgo = now - (11 * 24 * 60 * 60 * 1000);
    const nineDaysAgo = now - (9 * 24 * 60 * 60 * 1000);

    // 创建测试会话：一个超过10天，一个不到10天
    sessionStore.create({
      key: 'session-old',
      connectionId: 'conn1',
      label: 'Old Session',
      createdAt: elevenDaysAgo,
      lastActiveAt: elevenDaysAgo,
    });

    sessionStore.create({
      key: 'session-new',
      connectionId: 'conn1',
      label: 'New Session',
      createdAt: nineDaysAgo,
      lastActiveAt: nineDaysAgo,
    });

    // 清理超过10天的会话
    const deletedCount = sessionsCleanup.cleanupInactiveSessions(10);

    expect(deletedCount).toBe(1);

    // 验证旧会话已被删除，新会话仍然存在
    const remainingSessions = sessionStore.listByConnection('conn1');
    expect(remainingSessions).toHaveLength(1);
    expect(remainingSessions[0].key).toBe('session-new');
  });

  it('should not delete sessions newer than the threshold', () => {
    const now = Date.now();
    const fiveDaysAgo = now - (5 * 24 * 60 * 60 * 1000);

    sessionStore.create({
      key: 'session-new',
      connectionId: 'conn1',
      label: 'New Session',
      createdAt: fiveDaysAgo,
      lastActiveAt: fiveDaysAgo,
    });

    // 清理超过10天的会话（当前会话只有5天，不应该被删除）
    const deletedCount = sessionsCleanup.cleanupInactiveSessions(10);

    expect(deletedCount).toBe(0);

    // 验证会话仍然存在
    const remainingSessions = sessionStore.listByConnection('conn1');
    expect(remainingSessions).toHaveLength(1);
    expect(remainingSessions[0].key).toBe('session-new');
  });

  it('should handle multiple connections correctly', () => {
    const now = Date.now();
    const fifteenDaysAgo = now - (15 * 24 * 60 * 60 * 1000);
    const fiveDaysAgo = now - (5 * 24 * 60 * 60 * 1000);

    // 在两个不同的连接中创建会话
    sessionStore.create({
      key: 'session-conn1',
      connectionId: 'conn1',
      label: 'Session in Conn1',
      createdAt: fifteenDaysAgo,
      lastActiveAt: fifteenDaysAgo,
    });

    sessionStore.create({
      key: 'session-conn2',
      connectionId: 'conn2',
      label: 'Session in Conn2',
      createdAt: fiveDaysAgo,
      lastActiveAt: fiveDaysAgo,
    });

    // 清理超过10天的会话
    const deletedCount = sessionsCleanup.cleanupInactiveSessions(10);

    expect(deletedCount).toBe(1);

    // 验证conn1中的旧会话被删除，conn2中的新会话仍存在
    const conn1Sessions = sessionStore.listByConnection('conn1');
    const conn2Sessions = sessionStore.listByConnection('conn2');

    expect(conn1Sessions).toHaveLength(0);
    expect(conn2Sessions).toHaveLength(1);
  });
});