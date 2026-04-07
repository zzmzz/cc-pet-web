import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

async function checkDb() {
  try {
    // 尝试打开数据库文件
    const dbPath = './cc-pet-web/data/cc-pet.db';
    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    // 检查表是否存在和数据
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table';");
    console.log('Tables in database:', tables);

    // 检查ai_quota_history表的数据
    const count = await db.get("SELECT COUNT(*) as count FROM ai_quota_history;");
    console.log('Total quota records:', count.count);

    if (count.count > 0) {
      const sample = await db.all("SELECT * FROM ai_quota_history ORDER BY timestamp DESC LIMIT 5;");
      console.log('Sample quota records:', sample);
    }

    await db.close();
  } catch (error) {
    console.log('Database not found or error occurred:', error.message);

    // 检查目录是否存在
    try {
      const fs = await import('fs');
      const dirExists = fs.existsSync('./cc-pet-web/data');
      console.log('Data directory exists:', dirExists);

      if (dirExists) {
        const files = fs.readdirSync('./cc-pet-web/data');
        console.log('Files in data directory:', files);
      }
    } catch (fsError) {
      console.log('Could not check data directory:', fsError.message);
    }
  }
}

checkDb();