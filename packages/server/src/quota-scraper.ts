import Database from "better-sqlite3";
import axios from "axios";
import * as cheerio from "cheerio";

interface QuotaData {
  used: number;        // Claude 费用
  total: number;       // Claude 额度
  percentage: number;  // Claude 使用率
  cursorCost: number;  // Cursor 费用
  totalCost: number;   // 合计费用
  updateTime: string;
  [key: string]: any;
}

interface ScrapeLog {
  id: number;
  timestamp: string;
  status: 'success' | 'failure';
  message: string;
  response_code?: number;
  response_size?: number;
}

export class QuotaScraper {
  private db: Database.Database;
  private cookie: string;

  constructor(db: Database.Database, cookie: string) {
    this.db = db;
    this.cookie = cookie;

    // 初始化爬取日志表
    this.initLogTable();
  }

  private initLogTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quota_scrape_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL,
        message TEXT,
        response_code INTEGER,
        response_size INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_quota_scrape_logs_timestamp ON quota_scrape_logs(timestamp);
    `);
  }

  private async logScrapeAttempt(status: 'success' | 'failure', message: string, response_code?: number, response_size?: number): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO quota_scrape_logs (status, message, response_code, response_size)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(status, message, response_code, response_size);
  }

  async scrape(): Promise<QuotaData | null> {
    try {
      // 使用提供的cookie访问页面
      const startTime = Date.now();
      const response = await axios.get('https://ai-quota.fintopia.tech/users/27', {
        headers: {
          'Cookie': `remember_token=${this.cookie};`,
          'User-Agent': 'Mozilla/5.0 (compatible; AI Quota Monitor)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
        },
        timeout: 15000 // 增加到15秒超时
      });

      const duration = Date.now() - startTime;

      if (response.status !== 200) {
        const errorMsg = `Failed to fetch quota page: ${response.status} ${response.statusText}`;
        await this.logScrapeAttempt('failure', errorMsg, response.status, response.data?.length);
        console.error(errorMsg);
        return null;
      }

      // 使用cheerio解析HTML
      const $ = cheerio.load(response.data);

      // 解析页面数据 - 需要根据实际页面结构调整
      const quotaData: QuotaData = this.parseQuotaPage($);

      if (!quotaData || Object.keys(quotaData).length === 0) {
        const errorMsg = 'Could not parse quota data from response';
        await this.logScrapeAttempt('failure', errorMsg, response.status, response.data?.length);
        console.error(errorMsg);
        return null;
      }

      // 存储抓取的原始内容（可选，用于调试）
      await this.storeRawContent(response.data, quotaData);

      // 记录成功日志
      await this.logScrapeAttempt('success', `Successfully scraped quota data in ${duration}ms`, response.status, response.data?.length);

      console.log(`Successfully scraped quota data: Claude=$${quotaData.used}/$${quotaData.total} (${quotaData.percentage}%), Cursor=$${quotaData.cursorCost}, Total=$${quotaData.totalCost}`);

      return quotaData;
    } catch (error: any) {
      const errorMsg = `Error scraping quota data: ${error.message || error}`;
      await this.logScrapeAttempt('failure', errorMsg);
      console.error(errorMsg);
      if (error.response) {
        console.error(`Response status: ${error.response.status}`);
        console.error(`Response data: ${error.response.data?.substring(0, 500)}`);
      }
      return null;
    }
  }

  async manualScrape(): Promise<{ success: boolean; message: string; data?: any }> {
    console.log('Manual scrape triggered');
    try {
      const result = await this.scrape();
      if (result) {
        return {
          success: true,
          message: `Manual scrape successful. Claude: $${result.used}/$${result.total} (${result.percentage}%), Cursor: $${result.cursorCost}, Total: $${result.totalCost}`,
          data: result
        };
      } else {
        return {
          success: false,
          message: 'Manual scrape failed - no data retrieved'
        };
      }
    } catch (error: any) {
      const errorMsg = `Manual scrape failed: ${error.message || error}`;
      console.error(errorMsg);
      return {
        success: false,
        message: errorMsg
      };
    }
  }

  async getScrapeLogs(limit: number = 20): Promise<ScrapeLog[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM quota_scrape_logs
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all([limit]) as ScrapeLog[];
  }

  private parseDollar(text: string): number {
    const match = text.match(/\$\s*([\d,]+\.?\d*)/);
    return match ? parseFloat(match[1].replace(/,/g, '')) : 0;
  }

  private parsePercent(text: string): number {
    const match = text.match(/([\d.]+)\s*%/);
    return match ? parseFloat(match[1]) : 0;
  }

  private parseQuotaPage($: cheerio.CheerioAPI): QuotaData {
    let used = 0;
    let total = 0;
    let percentage = 0;
    let cursorCost = 0;
    let totalCost = 0;

    // 结构化解析：遍历卡片，根据标签文字识别
    $('.card').each((_, el) => {
      const card = $(el);
      const labelText = card.find('[style*="font-weight:600"]').first().text().trim();
      const statValues = card.find('.stat-value');

      if (labelText.includes('ClaudeCode')) {
        // Claude 卡片有 3 个 stat-value: 费用、额度、使用率
        if (statValues.length >= 3) {
          used = this.parseDollar(statValues.eq(0).text());
          total = this.parseDollar(statValues.eq(1).text());
          percentage = this.parsePercent(statValues.eq(2).text());
        }
      } else if (labelText.includes('Cursor')) {
        // Cursor 卡片有 1 个 stat-value: 费用
        if (statValues.length >= 1) {
          cursorCost = this.parseDollar(statValues.eq(0).text());
        }
      }
    });

    // 合计卡片使用 card-glow class
    const glowCard = $('.card-glow');
    if (glowCard.length) {
      const glowValue = glowCard.find('.stat-value').first().text();
      totalCost = this.parseDollar(glowValue);
    }

    // 合理性校验：防止解析错误产生异常大的值
    if (used > 10000) {
      console.warn(`Suspicious used value: $${used}, resetting to 0`);
      used = 0;
    }
    if (cursorCost > 10000) {
      console.warn(`Suspicious cursorCost value: $${cursorCost}, resetting to 0`);
      cursorCost = 0;
    }

    // 如果结构化解析未获取到 totalCost，用 used + cursorCost 推算
    if (totalCost === 0 && (used > 0 || cursorCost > 0)) {
      totalCost = used + cursorCost;
    }

    return {
      used,
      total,
      percentage,
      cursorCost,
      totalCost,
      updateTime: new Date().toISOString(),
    };
  }

  private async storeRawContent(content: string, quotaData: QuotaData): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO ai_quota_history (usage_data, raw_content)
      VALUES (?, ?)
    `);

    stmt.run(
      JSON.stringify(quotaData),
      content.substring(0, 10000) // 只存储前10000个字符以防数据库过大
    );
  }

  async scheduleScraping(intervalMs: number = 60 * 60 * 1000): Promise<void> { // 默认每小时执行
    console.log('Starting AI quota scraping service...');

    // 立即执行一次
    await this.scrape();

    // 设置定时任务
    setInterval(async () => {
      console.log(`Scraping AI quota at ${new Date().toISOString()}`);
      await this.scrape();
    }, intervalMs);
  }
}