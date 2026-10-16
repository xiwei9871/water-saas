import ReactECharts from 'echarts-for-react';

export interface TrendSeries {
  name: string;
  data: (number | null)[];
  yAxisIndex?: number;
  type?: 'line' | 'bar';
}

/**
 * 轻量折线/柱状趋势图封装 —— 报表与驾驶舱共用。
 * X 轴为账期/年份标签数组，Y 自适应。
 */
export default function TrendChart({
  x,
  series,
  height = 280,
  yName,
}: {
  x: string[];
  series: TrendSeries[];
  height?: number;
  yName?: string;
}) {
  return (
    <ReactECharts
      style={{ height, width: '100%' }}
      notMerge
      option={{
        tooltip: { trigger: 'axis' },
        legend: { data: series.map((s) => s.name), top: 0 },
        grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
        xAxis: { type: 'category', data: x, boundaryGap: series.some((s) => s.type === 'bar') },
        yAxis: { type: 'value', name: yName, scale: true },
        series: series.map((s) => ({
          name: s.name,
          type: s.type ?? 'line',
          yAxisIndex: s.yAxisIndex ?? 0,
          data: s.data,
          smooth: true,
          connectNulls: true,
        })),
      }}
    />
  );
}
