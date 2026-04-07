import React, { useState, useEffect, useMemo } from "react";

interface QuotaRecord {
  id: number;
  timestamp: string;
  usage_data: {
    used: number;
    total: number;
    percentage: number;
    updateTime: string;
    [key: string]: any;
  };
}

interface ChartDataPoint {
  date: string;
  percentage: number;
  used: number;
  total: number;
}

const QuotaChart: React.FC = () => {
  const [data, setData] = useState<ChartDataPoint[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<'24h' | '7d' | '30d'>('7d');

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        // Calculate date range based on selected time range
        let startDate: string | null = null;
        const endDate = new Date();

        switch (timeRange) {
          case '24h':
            startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
            break;
          case '7d':
            startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
            break;
          case '30d':
            startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
            break;
        }

        let url = '/api/quota/history';
        if (startDate) {
          url += `?start=${encodeURIComponent(startDate)}&limit=50`; // Limit to 50 records for performance
        } else {
          url += '?limit=50';
        }

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`API request failed with status ${response.status}`);
        }

        const responseData = await response.json();

        // Transform the data for charting
        const transformedData = responseData
          .map((item: QuotaRecord) => ({
            date: new Date(item.timestamp).toLocaleString('zh-CN'),
            percentage: item.usage_data.percentage || 0,
            used: item.usage_data.used || 0,
            total: item.usage_data.total || 0
          }))
          .reverse(); // Reverse to show oldest first

        setData(transformedData);
      } catch (err) {
        console.error('Error fetching quota history:', err);
        setError('获取历史数据失败');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [timeRange]);

  // Prepare chart dimensions
  const chartDimensions = useMemo(() => {
    if (data.length === 0) return { width: 0, height: 0, data: [] };

    const padding = { top: 20, right: 30, bottom: 40, left: 50 };
    const width = 500;
    const height = 300;

    // Calculate value ranges
    const percentages = data.map(d => d.percentage);
    const maxPercentage = Math.max(...percentages, 100);
    const minPercentage = Math.min(...percentages, 0);

    // Calculate step sizes for grid lines
    const xStep = Math.max(1, Math.floor(data.length / 6)); // Show max 6 labels on x-axis

    return {
      width,
      height,
      padding,
      chartWidth: width - padding.left - padding.right,
      chartHeight: height - padding.top - padding.bottom,
      maxValue: maxPercentage,
      minValue: minPercentage,
      data,
      xStep
    };
  }, [data]);

  const formatDate = (dateString: string) => {
    // Extract just the time for 24h view, or date for longer periods
    const date = new Date(dateString);
    if (timeRange === '24h') {
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    }
  };

  if (error) {
    return (
      <div className="p-4 text-center bg-red-50 border border-red-200 rounded-lg">
        <p className="text-red-600 font-medium">图表加载失败</p>
        <p className="text-sm text-red-500">{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8 text-center">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary mx-auto"></div>
        <p className="mt-3 text-sm text-text-secondary">正在加载历史数据...</p>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="p-4 text-center bg-surface border border-border rounded-lg">
        <p className="text-text-secondary">暂无历史数据</p>
        <p className="text-xs text-gray-500 mt-1">系统刚开始收集数据，请稍后再查看</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-md font-medium text-text-primary">用量历史</h3>
        <div className="flex space-x-2">
          <button
            className={`px-3 py-1.5 text-xs rounded-md ${
              timeRange === '24h'
                ? 'bg-primary text-white'
                : 'bg-surface text-text-primary border border-border hover:bg-surface-secondary'
            }`}
            onClick={() => setTimeRange('24h')}
          >
            24小时
          </button>
          <button
            className={`px-3 py-1.5 text-xs rounded-md ${
              timeRange === '7d'
                ? 'bg-primary text-white'
                : 'bg-surface text-text-primary border border-border hover:bg-surface-secondary'
            }`}
            onClick={() => setTimeRange('7d')}
          >
            7天
          </button>
          <button
            className={`px-3 py-1.5 text-xs rounded-md ${
              timeRange === '30d'
                ? 'bg-primary text-white'
                : 'bg-surface text-text-primary border border-border hover:bg-surface-secondary'
            }`}
            onClick={() => setTimeRange('30d')}
          >
            30天
          </button>
        </div>
      </div>

      <div className="bg-surface rounded-lg p-4 border border-border overflow-x-auto">
        <svg
          width={chartDimensions.width}
          height={chartDimensions.height}
          viewBox={`0 0 ${chartDimensions.width} ${chartDimensions.height}`}
          className="min-w-full"
        >
          {/* Grid lines and labels */}
          <g transform={`translate(${chartDimensions.padding.left},${chartDimensions.padding.top})`}>
            {/* Horizontal grid lines */}
            {[0, 25, 50, 75, 100].map(percent => {
              const y = chartDimensions.chartHeight - (percent / 100) * chartDimensions.chartHeight;
              return (
                <g key={percent}>
                  <line
                    x1={0}
                    y1={y}
                    x2={chartDimensions.chartWidth}
                    y2={y}
                    stroke="#e5e7eb"
                    strokeWidth={0.5}
                  />
                  <text
                    x={-10}
                    y={y + 4}
                    textAnchor="end"
                    fontSize="10"
                    fill="#6b7280"
                  >
                    {percent}%
                  </text>
                </g>
              );
            })}

            {/* Vertical grid lines and labels */}
            {chartDimensions.data
              .filter((_, i) => i % chartDimensions.xStep === 0)
              .map((point, idx) => {
                const filteredIdx = Math.floor(idx * chartDimensions.xStep);
                if (filteredIdx >= chartDimensions.data.length) return null;

                const x = (filteredIdx / (chartDimensions.data.length - 1)) * chartDimensions.chartWidth;
                return (
                  <g key={filteredIdx}>
                    <line
                      x1={x}
                      y1={0}
                      x2={x}
                      y2={chartDimensions.chartHeight}
                      stroke="#e5e7eb"
                      strokeWidth={0.5}
                    />
                    <text
                      x={x}
                      y={chartDimensions.chartHeight + 15}
                      textAnchor="middle"
                      fontSize="9"
                      fill="#6b7280"
                      transform={`rotate(-45 ${x},${chartDimensions.chartHeight + 15})`}
                    >
                      {formatDate(chartDimensions.data[filteredIdx].date)}
                    </text>
                  </g>
                );
              })
            }

            {/* Data line */}
            <polyline
              fill="none"
              stroke="#3b82f6"
              strokeWidth="2"
              points={
                chartDimensions.data
                  .map((point, i) => {
                    const x = (i / (chartDimensions.data.length - 1)) * chartDimensions.chartWidth;
                    const y = chartDimensions.chartHeight - (point.percentage / 100) * chartDimensions.chartHeight;
                    return `${x},${y}`;
                  })
                  .join(' ')
              }
            />

            {/* Data points */}
            {chartDimensions.data.map((point, i) => {
              const x = (i / (chartDimensions.data.length - 1)) * chartDimensions.chartWidth;
              const y = chartDimensions.chartHeight - (point.percentage / 100) * chartDimensions.chartHeight;
              return (
                <circle
                  key={i}
                  cx={x}
                  cy={y}
                  r="3"
                  fill="#3b82f6"
                  className="hover:r-4 transition-all cursor-pointer"
                />
              );
            })}

            {/* Axes */}
            <line
              x1={0}
              y1={0}
              x2={0}
              y2={chartDimensions.chartHeight}
              stroke="#374151"
              strokeWidth="1"
            />
            <line
              x1={0}
              y1={chartDimensions.chartHeight}
              x2={chartDimensions.chartWidth}
              y2={chartDimensions.chartHeight}
              stroke="#374151"
              strokeWidth="1"
            />
          </g>
        </svg>
      </div>

      {/* Stats summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface rounded-lg p-3 border border-border text-center">
          <p className="text-sm text-text-secondary">最高用量</p>
          <p className="text-lg font-semibold text-red-500">
            {Math.max(...data.map(d => d.percentage)).toFixed(1)}%
          </p>
        </div>
        <div className="bg-surface rounded-lg p-3 border border-border text-center">
          <p className="text-sm text-text-secondary">平均用量</p>
          <p className="text-lg font-semibold text-blue-500">
            {(data.reduce((sum, d) => sum + d.percentage, 0) / data.length).toFixed(1)}%
          </p>
        </div>
        <div className="bg-surface rounded-lg p-3 border border-border text-center">
          <p className="text-sm text-text-secondary">最低用量</p>
          <p className="text-lg font-semibold text-green-500">
            {Math.min(...data.map(d => d.percentage)).toFixed(1)}%
          </p>
        </div>
      </div>
    </div>
  );
};

export { QuotaChart };