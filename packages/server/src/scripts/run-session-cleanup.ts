import { SessionsCleanup } from './cleanup/sessions-cleanup.js';
import { createDatabase } from './storage/db.js';
import { SessionStore } from './storage/sessions.js';

// 允许通过命令行参数指定数据目录
const DATA_DIR = process.argv[2] || './data';

async function runCleanup() {
  console.log(`Starting manual session cleanup...`);
  console.log(`Using data directory: ${DATA_DIR}`);

  try {
    const db = createDatabase(DATA_DIR);
    const sessionStore = new SessionStore(db);

    const sessionsCleanup = new SessionsCleanup(sessionStore, db);

    // 从环境变量或默认值获取天数阈值
    const daysThreshold = parseInt(process.env.CC_PET_CLEANUP_DAYS_THRESHOLD || '10');

    const deletedCount = sessionsCleanup.cleanupInactiveSessions(daysThreshold);
    console.log(`Manual session cleanup completed. Deleted ${deletedCount} inactive sessions (threshold: ${daysThreshold} days).`);

    db.close();
  } catch (error) {
    console.error('Manual session cleanup failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  runCleanup();
}