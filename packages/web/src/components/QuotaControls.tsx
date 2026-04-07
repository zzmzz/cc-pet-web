import React, { useState } from "react";
import { authenticatedFetch } from "../utils/api-client";

interface QuotaControlsProps {
  onManualScrape?: (result: any) => void;
}

const QuotaControls: React.FC<QuotaControlsProps> = ({ onManualScrape }) => {
  const [scraping, setScraping] = useState<boolean>(false);
  const [scrapeMessage, setScrapeMessage] = useState<string>('');
  const [scrapeStatus, setScrapeStatus] = useState<'idle' | 'success' | 'error'>('idle');

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
            onClick={() => window.location.reload()}
          >
            刷新页面
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
    </div>
  );
};

export { QuotaControls };