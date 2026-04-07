import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Database from "better-sqlite3";
import { QuotaScraper } from "../quota-scraper.js";

interface QuotaRecord {
  id: number;
  timestamp: string;
  usage_data: string; // Stored as JSON string
  raw_content?: string;
}

interface QuotaAPIOptions {
  db: Database.Database;
  scraper?: QuotaScraper | null; // Add scraper instance to API options (optional)
}

export function registerQuotaRoutes(fastify: FastifyInstance, options: QuotaAPIOptions): void {
  const { db, scraper } = options;

  // 获取最新用量数据
  fastify.get('/api/quota/current', async (req, reply) => {
    try {
      const stmt = db.prepare(`
        SELECT * FROM ai_quota_history
        ORDER BY timestamp DESC
        LIMIT 1
      `);
      const result = stmt.get() as QuotaRecord | undefined;

      if (!result) {
        return reply.status(404).send({ error: 'No quota data found' });
      }

      return {
        ...result,
        usage_data: JSON.parse(result.usage_data),
        timestamp: result.timestamp
      };
    } catch (error) {
      req.log.error(error, 'Error fetching current quota');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // 获取用量历史数据
  fastify.get<{ Querystring: { limit?: number; start?: string; end?: string } }>(
    '/api/quota/history',
    async (req, reply) => {
      try {
        let query = `
          SELECT id, timestamp, usage_data
          FROM ai_quota_history
        `;
        const params: any[] = [];

        // 添加日期过滤
        if (req.query.start || req.query.end) {
          query += ' WHERE';

          if (req.query.start) {
            query += ' timestamp >= ?';
            params.push(req.query.start);
          }

          if (req.query.start && req.query.end) {
            query += ' AND';
          }

          if (req.query.end) {
            if (!req.query.start) {
              query += ' timestamp <= ?';
            } else {
              query += ' timestamp <= ?';
            }
            params.push(req.query.end);
          }
        }

        query += ' ORDER BY timestamp DESC';

        // 添加限制
        if (req.query.limit) {
          query += ' LIMIT ?';
          params.push(req.query.limit);
        }

        const stmt = db.prepare(query);
        const results = stmt.all(...params) as QuotaRecord[];

        return results.map(row => ({
          ...row,
          usage_data: JSON.parse(row.usage_data),
          timestamp: row.timestamp
        }));
      } catch (error) {
        req.log.error(error, 'Error fetching quota history');
        return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // 获取用量统计摘要
  fastify.get('/api/quota/stats', async (req, reply) => {
    try {
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM ai_quota_history');
      const latestStmt = db.prepare(`
        SELECT * FROM ai_quota_history
        ORDER BY timestamp DESC
        LIMIT 1
      `);
      const avgStmt = db.prepare(`
        SELECT AVG(json_extract(usage_data, '$.percentage')) as avg_percentage,
               MIN(json_extract(usage_data, '$.percentage')) as min_percentage,
               MAX(json_extract(usage_data, '$.percentage')) as max_percentage
        FROM ai_quota_history
      `);

      const countResult = countStmt.get() as { count: number };
      const latestResult = latestStmt.get() as QuotaRecord | undefined;
      const avgResult = avgStmt.get() as {
        avg_percentage: number;
        min_percentage: number;
        max_percentage: number
      } | undefined;

      return {
        totalRecords: countResult.count,
        latest: latestResult ? {
          ...latestResult,
          usage_data: JSON.parse(latestResult.usage_data)
        } : null,
        stats: avgResult
      };
    } catch (error) {
      req.log.error(error, 'Error fetching quota stats');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // 手动触发爬取
  fastify.post('/api/quota/manual-scrape', async (req, reply) => {
    try {
      if (!scraper) {
        return { success: false, message: 'Quota scraper not configured - please set AI_QUOTA_COOKIE environment variable' };
      }

      const result = await scraper.manualScrape();

      if (result.success) {
        req.log.info('Manual scrape completed successfully');
      } else {
        req.log.warn(`Manual scrape failed: ${result.message}`);
      }

      return result;
    } catch (error) {
      req.log.error(error, 'Error during manual scrape');
      return { success: false, message: 'Manual scrape failed due to internal error' };
    }
  });

  // 获取爬取日志
  fastify.get<{ Querystring: { limit?: number } }>('/api/quota/logs', async (req, reply) => {
    try {
      if (!scraper) {
        return { logs: [], message: 'Quota scraper not configured - please set AI_QUOTA_COOKIE environment variable' };
      }

      const limit = req.query.limit ? Math.min(parseInt(req.query.limit.toString()), 100) : 20;
      const logs = await scraper.getScrapeLogs(limit);

      return { logs };
    } catch (error) {
      req.log.error(error, 'Error fetching scrape logs');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}