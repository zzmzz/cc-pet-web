import React, { useState, useEffect } from "react";
import { QuotaChart } from './QuotaChart';

interface QuotaData {
  id: number;
  timestamp: string;
  usage_data: {
    used: number;
    total: number;
    percentage: number;
    updateTime: string;
    rawTextPreview?: string;
    [key: string]: any;
  };
}

const AIVolumeDisplay: React.FC = () => {
  const [currentQuota, setCurrentQuota] = useState<QuotaData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCurrentQuota = async () => {
      try {
        setLoading(true);
        const response = await fetch('/api/quota/current');

        if (!response.ok) {
          if (response.status === 404) {
            // 如果没有找到数据，设置为null但不报错
            setCurrentQuota(null);
          } else {
            throw new Error(`API request failed with status ${response.status}`);
          }
        } else {
          const data = await response.json();
          setCurrentQuota(data);
        }
      } catch (err) {
        console.error('Error fetching quota data:', err);
        setError('获取用量数据失败');
      } finally {
        setLoading(false);
      }
    };

    // 立即获取数据
    fetchCurrentQuota();

    // 设置定时刷新（每分钟刷新一次）
    const interval = setInterval(fetchCurrentQuota, 60000);

    return () => clearInterval(interval);
  }, []);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('zh-CN');
  };

  if (error) {
    return (
      <div className="p-4 text-center">
        <p className="text-red-500 mb-2">错误：{error}</p>
        <p className="text-sm text-gray-500">请检查服务器配置和网络连接</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 text-center">
        <div className="inline-block animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-primary"></div>
        <p className="mt-2 text-sm text-text-secondary">正在加载用量数据...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Current Status Card */}
      <div className="bg-surface rounded-lg p-4 border border-border">
        <h3 className="text-md font-medium text-text-primary mb-3">当前用量</h3>

        {currentQuota ? (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center">
                <p className="text-2xl font-bold text-primary">{currentQuota.usage_data.percentage || 0}%</p>
                <p className="text-xs text-text-secondary">使用率</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-semibold text-text-primary">
                  {typeof currentQuota.usage_data.used === 'number' ? currentQuota.usage_data.used.toLocaleString() : 'N/A'} /
                  {' '}{typeof currentQuota.usage_data.total === 'number' ? currentQuota.usage_data.total.toLocaleString() : 'N/A'}
                </p>
                <p className="text-xs text-text-secondary">已用 / 总量</p>
              </div>
            </div>

            {/* Progress bar */}
            <div className="mt-4">
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div
                  className={`h-2.5 rounded-full ${
                    (currentQuota.usage_data.percentage || 0) > 80 ? 'bg-red-500' :
                    (currentQuota.usage_data.percentage || 0) > 60 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(currentQuota.usage_data.percentage || 0, 100)}%` }}
                ></div>
              </div>
              <div className="flex justify-between text-xs text-text-secondary mt-1">
                <span>0%</span>
                <span>{typeof currentQuota.usage_data.total === 'number' ? currentQuota.usage_data.total.toLocaleString() : 'N/A'}</span>
              </div>
            </div>

            {/* Last updated time */}
            <div className="mt-4 pt-4 border-t border-border">
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">最后更新</span>
                <span className="text-text-primary">{formatDate(currentQuota.timestamp)}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-4">
            <p className="text-text-secondary">暂无用量数据</p>
            <p className="text-xs text-gray-500 mt-1">系统正在等待首次抓取完成</p>
          </div>
        )}
      </div>

      {/* Historical Chart */}
      <div className="bg-surface rounded-lg p-4 border border-border">
        <QuotaChart />
      </div>

      {/* Info */}
      <div className="text-xs text-text-secondary">
        <p>• 用量数据每小时自动更新</p>
        <p>• 绿色&lt;60%, 黄色60-80%, 红色&gt;80%</p>
      </div>
    </div>
  );
};

export { AIVolumeDisplay };