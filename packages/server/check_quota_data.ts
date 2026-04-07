import Database from 'better-sqlite3';
import path from 'path';

// 数据库文件位于上两级目录的pet-compose目录
const dbPath = path.resolve(process.cwd(), '../../../pet-compose/cc-pet.db');
console.log('Database path:', dbPath);

const db = new Database(dbPath);

try {
  // 检查数据总量
  console.log('=== Data Count ===');
  const count = db.prepare("SELECT COUNT(*) as count FROM ai_quota_history").get();
  console.log('Total quota records:', count.count);

  if (count.count > 0) {
    // 显示最近的几条记录
    console.log('\n=== Recent Records ===');
    const recentRecords = db.prepare(`
      SELECT id, timestamp, usage_data
      FROM ai_quota_history
      ORDER BY timestamp DESC
      LIMIT 10
    `).all();

    recentRecords.forEach((record, index) => {
      console.log(`${index + 1}. ID: ${record.id}, Timestamp: ${record.timestamp}`);
      try {
        const usageData = JSON.parse(record.usage_data);
        console.log(`   Claude used: $${usageData.used}, Total: $${usageData.total}`);
        console.log(`   Cursor cost: $${usageData.cursorCost}, Total Cost: $${usageData.totalCost}`);
        console.log(`   Percentage: ${usageData.percentage}%`);
      } catch (e) {
        console.log('   Error parsing usage_data:', e.message);
      }
      console.log('');
    });

    // 进一步分析Claude和Cursor数据
    console.log('=== Data Analysis ===');
    const allRecords = db.prepare(`
      SELECT usage_data
      FROM ai_quota_history
      ORDER BY timestamp ASC
    `).all();

    let claudePresent = false;
    let cursorPresent = false;
    let totalRecords = allRecords.length;
    let claudeZeroCount = 0;
    let cursorZeroCount = 0;
    let hasNonZeroClaude = false;
    let hasNonZeroCursor = false;

    allRecords.forEach(record => {
      try {
        const usageData = JSON.parse(record.usage_data);
        if (usageData.used !== undefined) {
          claudePresent = true;
          if (usageData.used > 0) {
            hasNonZeroClaude = true;
          } else if (usageData.used === 0) {
            claudeZeroCount++;
          }
        }

        if (usageData.cursorCost !== undefined) {
          cursorPresent = true;
          if (usageData.cursorCost > 0) {
            hasNonZeroCursor = true;
          } else if (usageData.cursorCost === 0) {
            cursorZeroCount++;
          }
        }
      } catch (e) {
        console.log('Error parsing record:', e.message);
      }
    });

    console.log(`Total records analyzed: ${totalRecords}`);
    console.log(`Claude data present: ${claudePresent ? 'Yes' : 'No'}`);
    console.log(`Cursor data present: ${cursorPresent ? 'Yes' : 'No'}`);
    console.log(`Has non-zero Claude values: ${hasNonZeroClaude ? 'Yes' : 'No'}`);
    console.log(`Has non-zero Cursor values: ${hasNonZeroCursor ? 'Yes' : 'No'}`);
    console.log(`Records with Claude = 0: ${claudeZeroCount}`);
    console.log(`Records with Cursor = 0: ${cursorZeroCount}`);
  } else {
    console.log('No quota records found in the database.');
  }

  db.close();
} catch (error) {
  console.error('Error accessing database:', error.message);
}