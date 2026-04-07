import React, { useState, useEffect, useMemo } from "react";
import { authenticatedFetch } from "../utils/api-client";

interface QuotaRecord {
  id: number;
  timestamp: string;
  usage_data: {
    used: number;
    total: number;
    percentage: number;
    cursorCost?: number;
    totalCost?: number;
    updateTime: string;
    [key: string]: any;
  };
}

interface ChartDataPoint {
  date: string;
  rawTimestamp: string;
  used: number;
  cursorCost: number;
}

// Compute nice Y-axis ticks: [0, step, 2*step, ..., ceil]
function computeYTicks(maxVal: number): number[] {
  if (maxVal <= 0) return [0, 25, 50, 75, 100];
  const rawStep = maxVal / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const niceSteps = [1, 2, 2.5, 5, 10];
  const step = niceSteps.find(s => s * magnitude >= rawStep)! * magnitude;
  const ticks: number[] = [];
  for (let v = 0; v <= maxVal + step * 0.1; v += step) {
    ticks.push(Math.round(v * 100) / 100);
  }
  if (ticks.length < 2) ticks.push(step);
  return ticks;
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
          url += `?start=${encodeURIComponent(startDate)}&limit=50`;
        } else {
          url += '?limit=50';
        }

        const response = await authenticatedFetch(url);

        if (!response.ok) {
          throw new Error(`API request failed with status ${response.status}`);
        }

        const responseData = await response.json();

        const transformedData: ChartDataPoint[] = responseData
          .map((item: QuotaRecord) => ({
            date: new Date(item.timestamp).toLocaleString('zh-CN'),
            rawTimestamp: item.timestamp,
            used: item.usage_data.used || 0,
            cursorCost: item.usage_data.cursorCost || 0,
          }))
          .reverse();

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

  const chartDimensions = useMemo(() => {
    if (data.length === 0) return null;

    const padding = { top: 20, right: 30, bottom: 40, left: 50 };
    const width = 500;
    const height = 300;
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const allValues = [...data.map(d => d.used), ...data.map(d => d.cursorCost)];
    const maxValue = Math.max(...allValues, 1);
    const yTicks = computeYTicks(maxValue);
    const yMax = yTicks[yTicks.length - 1];

    const xStep = Math.max(1, Math.floor(data.length / 6));

    return { width, height, padding, chartWidth, chartHeight, yMax, yTicks, xStep };
  }, [data]);

  const getX = (i: number) => {
    if (!chartDimensions) return 0;
    return data.length <= 1
      ? chartDimensions.chartWidth / 2
      : (i / (data.length - 1)) * chartDimensions.chartWidth;
  };

  const getY = (value: number) => {
    if (!chartDimensions) return 0;
    return chartDimensions.chartHeight - (value / chartDimensions.yMax) * chartDimensions.chartHeight;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    // 如果数据实际跨度不足1天，显示时:分而非月/日
    const spanMs = data.length >= 2
      ? new Date(data[data.length - 1].rawTimestamp).getTime() - new Date(data[0].rawTimestamp).getTime()
      : 0;
    const spanLessThanDay = spanMs < 24 * 60 * 60 * 1000;

    if (timeRange === '24h' || spanLessThanDay) {
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

  const dim = chartDimensions!;

  const claudePoints = data.map((p, i) => `${getX(i)},${getY(p.used)}`).join(' ');
  const cursorPoints = data.map((p, i) => `${getX(i)},${getY(p.cursorCost)}`).join(' ');

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-md font-medium text-text-primary">用量历史</h3>
        <div className="flex space-x-2">
          {(['24h', '7d', '30d'] as const).map(range => (
            <button
              key={range}
              className={`px-3 py-1.5 text-xs rounded-md ${
                timeRange === range
                  ? 'bg-primary text-white'
                  : 'bg-surface text-text-primary border border-border hover:bg-surface-secondary'
              }`}
              onClick={() => setTimeRange(range)}
            >
              {range === '24h' ? '24小时' : range === '7d' ? '7天' : '30天'}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-text-secondary">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-blue-500 rounded"></span> Claude
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-purple-500 rounded"></span> Cursor
        </span>
      </div>

      <div className="bg-surface rounded-lg p-4 border border-border overflow-x-auto">
        <svg
          width={dim.width}
          height={dim.height}
          viewBox={`0 0 ${dim.width} ${dim.height}`}
          className="min-w-full"
        >
          <g transform={`translate(${dim.padding.left},${dim.padding.top})`}>
            {/* Horizontal grid lines */}
            {dim.yTicks.map(tick => {
              const y = getY(tick);
              return (
                <g key={tick}>
                  <line x1={0} y1={y} x2={dim.chartWidth} y2={y} stroke="#e5e7eb" strokeWidth={0.5} />
                  <text x={-10} y={y + 4} textAnchor="end" fontSize="10" fill="#6b7280">
                    ${tick}
                  </text>
                </g>
              );
            })}

            {/* Vertical grid lines and labels */}
            {data
              .filter((_, i) => i % dim.xStep === 0)
              .map((_, idx) => {
                const origIdx = idx * dim.xStep;
                if (origIdx >= data.length) return null;
                const x = getX(origIdx);
                return (
                  <g key={origIdx}>
                    <line x1={x} y1={0} x2={x} y2={dim.chartHeight} stroke="#e5e7eb" strokeWidth={0.5} />
                    <text
                      x={x}
                      y={dim.chartHeight + 15}
                      textAnchor="middle"
                      fontSize="9"
                      fill="#6b7280"
                      transform={`rotate(-45 ${x},${dim.chartHeight + 15})`}
                    >
                      {formatDate(data[origIdx].rawTimestamp)}
                    </text>
                  </g>
                );
              })}

            {/* Claude line */}
            <polyline fill="none" stroke="#3b82f6" strokeWidth="2" points={claudePoints} />

            {/* Cursor line */}
            <polyline fill="none" stroke="#a855f7" strokeWidth="2" points={cursorPoints} />

            {/* Claude data points */}
            {data.map((point, i) => (
              <circle key={`c-${i}`} cx={getX(i)} cy={getY(point.used)} r="3" fill="#3b82f6" className="cursor-pointer">
                <title>Claude: ${point.used.toFixed(2)}</title>
              </circle>
            ))}

            {/* Cursor data points */}
            {data.map((point, i) => (
              <circle key={`u-${i}`} cx={getX(i)} cy={getY(point.cursorCost)} r="3" fill="#a855f7" className="cursor-pointer">
                <title>Cursor: ${point.cursorCost.toFixed(2)}</title>
              </circle>
            ))}

            {/* Axes */}
            <line x1={0} y1={0} x2={0} y2={dim.chartHeight} stroke="#374151" strokeWidth="1" />
            <line x1={0} y1={dim.chartHeight} x2={dim.chartWidth} y2={dim.chartHeight} stroke="#374151" strokeWidth="1" />
          </g>
        </svg>
      </div>

      {/* Stats summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface rounded-lg p-3 border border-border text-center">
          <p className="text-sm text-text-secondary">Claude 当前</p>
          <p className="text-lg font-semibold text-blue-500">
            ${data[data.length - 1]?.used.toFixed(2) ?? '0.00'}
          </p>
        </div>
        <div className="bg-surface rounded-lg p-3 border border-border text-center">
          <p className="text-sm text-text-secondary">Cursor 当前</p>
          <p className="text-lg font-semibold text-purple-500">
            ${data[data.length - 1]?.cursorCost.toFixed(2) ?? '0.00'}
          </p>
        </div>
        <div className="bg-surface rounded-lg p-3 border border-border text-center">
          <p className="text-sm text-text-secondary">合计当前</p>
          <p className="text-lg font-semibold text-green-500">
            ${((data[data.length - 1]?.used ?? 0) + (data[data.length - 1]?.cursorCost ?? 0)).toFixed(2)}
          </p>
        </div>
      </div>
    </div>
  );
};

export { QuotaChart };
