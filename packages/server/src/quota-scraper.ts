import Database from "better-sqlite3";
import axios from "axios";
import * as cheerio from "cheerio";

interface QuotaData {
  // 定义从页面抓取的数据结构
  // 根据实际页面结构可能会有所不同
  used: number;
  total: number;
  percentage: number;
  updateTime: string;
  [key: string]: any; // 支持额外字段
}

export class QuotaScraper {
  private db: Database.Database;
  private cookie: string;

  constructor(db: Database.Database, cookie: string) {
    this.db = db;
    this.cookie = cookie;
  }

  async scrape(): Promise<QuotaData | null> {
    try {
      // 使用提供的cookie访问页面
      const response = await axios.get('https://ai-quota.fintopia.tech/users/27', {
        headers: {
          'Cookie': `remember_token=${this.cookie};`,
          'User-Agent': 'Mozilla/5.0 (compatible; AI Quota Monitor)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
        },
        timeout: 10000 // 10秒超时
      });

      if (response.status !== 200) {
        console.error(`Failed to fetch quota page: ${response.status} ${response.statusText}`);
        return null;
      }

      // 使用cheerio解析HTML
      const $ = cheerio.load(response.data);

      // 解析页面数据 - 需要根据实际页面结构调整
      // 这里是通用的解析逻辑，可能需要根据实际页面元素进行调整
      const quotaData: QuotaData = this.parseQuotaPage($);

      // 存储抓取的原始内容（可选，用于调试）
      await this.storeRawContent(response.data, quotaData);

      return quotaData;
    } catch (error) {
      console.error('Error scraping quota data:', error);
      return null;
    }
  }

  private parseQuotaPage($: cheerio.CheerioAPI): QuotaData {
    // 这里的解析逻辑需要根据实际页面结构进行调整
    // 目前是通用的解析模式，需要根据真实页面元素进行适配

    let used = 0;
    let total = 0;
    let percentage = 0;

    // 尝试多种常见的配额显示模式
    // 方案1: 查找包含配额相关信息的元素
    const text = $('body').text();

    // 使用正则表达式提取配额信息 (需要根据实际页面格式调整)
    const usedMatch = text.match(/used[:\s]+([\d,]+\.?\d*)/i) ||
                     text.match(/已用[:\s]+([\d,]+\.?\d*)/);
    if (usedMatch && usedMatch[1]) {
      used = parseFloat(usedMatch[1].replace(/,/g, ''));
    }

    const totalMatch = text.match(/total[:\s]+([\d,]+\.?\d*)/i) ||
                      text.match(/总量[:\s]+([\d,]+\.?\d*)|总额[:\s]+([\d,]+\.?\d*)/);
    if (totalMatch && totalMatch[1]) {
      total = parseFloat(totalMatch[1].replace(/,/g, ''));
    }

    const percentageMatch = text.match(/(\d+)%\s*(?:used|已用)/i) ||
                           text.match(/(\d+)%/);
    if (percentageMatch && percentageMatch[1]) {
      percentage = parseFloat(percentageMatch[1]);
    }

    // 如果上面的方法都没有成功解析，则尝试查找数值模式
    if (used === 0 || total === 0) {
      const numbers = text.match(/\b\d+(?:[,.]\d+)?\b/g);
      if (numbers && numbers.length >= 2) {
        const numValues = numbers.map(n => parseFloat(n.replace(/,/g, '')));
        // 尝试找出最大的两个数作为total和used（取决于页面显示顺序）
        numValues.sort((a, b) => b - a);
        if (numValues.length >= 2) {
          total = numValues[0];
          used = numValues[1];
          if (total > 0) {
            percentage = Math.round((used / total) * 100);
          }
        }
      }
    }

    return {
      used,
      total,
      percentage,
      updateTime: new Date().toISOString(),
      rawTextPreview: text.substring(0, 200) // 预览原始文本的前200个字符
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