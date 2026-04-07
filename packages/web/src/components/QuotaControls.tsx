import React, { useState, useEffect } from "react";
import { authenticatedFetch } from "../utils/api-client";

interface ScrapeLog {
  id: number;
  timestamp: string;
  status: 'success' | 'failure';
  message: string;
  response_code?: number;
  response_size?: number;
}

interface QuotaControlsProps {
  onManualScrape?: (result: any) => void;
}

const QuotaControls: React.FC<QuotaControlsProps> = ({ onManualScrape }) => {
  const [scraping, setScraping] = useState<boolean>(false);
  const [scrapeMessage, setScrapeMessage] = useState<string>('');
  const [scrapeStatus, setScrapeStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [logs, setLogs] = useState<ScrapeLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState<boolean>(true);

  useEffect(() => {
    fetchLogs();
  }, []);

  const fetchLogs = async () => {
    try {
      setLoadingLogs(true);
      const response = await authenticatedFetch('/api/quota/logs?limit=10');

      if (!response.ok) {
        throw new Error(`Failed to fetch logs: ${response.status}`);
      }

      const data = await response.json();
      setLogs(data.logs || []);
    } catch (error) {
      console.error('Error fetching scrape logs:', error);
    } finally {
      setLoadingLogs(false);
    }
  };

  const handleManualScrape = async () => {
    setScraping(true);
    setScrapeStatus('idle');
    setScrapeMessage('');

    try {
      const response = await authenticatedFetch('/api/quota/manual-scrape', {
        method: 'POST',
      });

      const result = await response.json();

      if (result.success) {
        setScrapeStatus('success');
        setScrapeMessage(result.message || '手动爬取成功！');

        // Refresh logs after successful scrape
        setTimeout(() => {
          fetchLogs();
        }, 1000);
      } else {
        setScrapeStatus('error');
        setScrapeMessage(result.message || '手动爬取失败');
      }

      // Call parent callback if provided
      if (onManualScrape) {
        onManualScrape(result);
      }
    } catch (error) {
      setScrapeStatus('error');
      setScrapeMessage('网络错误：无法连接到服务器');
      console.error('Error during manual scrape:', error);
    } finally {
      setScraping(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('zh-CN');
  };

  return (
    <div className="space-y-4">
      {/* Manual Scrape Button */}
      <div className="bg-surface rounded-lg p-4 border border-border">
        <h3 className="text-md font-medium text-text-primary mb-3">手动爬取控制</h3>

        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            className={`flex-1 py-2 px-4 rounded-md font-medium text-white ${
              scraping
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-primary hover:bg-primary/90'
            }`}
            onClick={handleManualScrape}
            disabled={scraping}
          >
            {scraping ? (
              <span className="flex items-center justify-center">
                <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></span>
                爬取中...
              </span>
            ) : (
              '手动触发爬取'
            )}
          </button>

          <button
            type="button"
            className="py-2 px-4 rounded-md font-medium text-text-primary border border-border hover:bg-surface-secondary"
            onClick={fetchLogs}
          >
            刷新日志
          </button>
        </div>

        {/* Status Message */}
        {scrapeMessage && (
          <div className={`mt-3 p-3 rounded-md text-sm ${
            scrapeStatus === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : scrapeStatus === 'error'
                ? 'bg-red-50 text-red-700 border border-red-200'
                : 'bg-blue-50 text-blue-700 border border-blue-200'
          }`}>
            {scrapeMessage}
          </div>
        )}
      </div>

      {/* Scrape Logs */}
      <div className="bg-surface rounded-lg p-4 border border-border">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-md font-medium text-text-primary">爬取日志</h3>
          <span className="text-xs text-text-secondary">
            最近 10 条记录
          </span>
        </div>

        {loadingLogs ? (
          <div className="py-4 text-center">
            <div className="inline-block animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-primary mx-auto"></div>
            <p className="mt-2 text-sm text-text-secondary">加载日志中...</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="py-4 text-center">
            <p className="text-text-secondary">暂无爬取日志</p>
            <p className="text-xs text-gray-500 mt-1">点击手动爬取按钮开始记录</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {logs.map(log => (
              <div
                key={log.id}
                className={`p-3 rounded-md border text-sm ${
                  log.status === 'success'
                    ? 'bg-green-50 border-green-200 text-green-700'
                    : 'bg-red-50 border-red-200 text-red-700'
                }`}
              >
                <div className="flex justify-between items-start">
                  <span className={`font-medium ${
                    log.status === 'success' ? 'text-green-800' : 'text-red-800'
                  }`}>
                    {log.status === 'success' ? '✅ 成功' : '❌ 失败'}
                  </span>
                  <span className="text-xs text-text-secondary">
                    {formatDate(log.timestamp)}
                  </span>
                </div>
                <p className="mt-1 truncate">{log.message}</p>
                {log.response_code && (
                  <p className="text-xs mt-1 opacity-75">
                    HTTP状态码: {log.response_code}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export { QuotaControls };