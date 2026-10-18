import ReactECharts from 'echarts-for-react';
import { axisFormat, fmtFull } from '../utils/numfmt';

export interface TrendSeries {
  name: string;
  data: (number | null)[];
  yAxisIndex?: number;
  type?: 'line' | 'bar';
}

/**
 * 轻量折线/柱状趋势图封装 —— 报表与驾驶舱共用。
 * X 轴为账期/年份标签数组。Y 轴整轴自适应单位（万/亿，按轴内最大值
 * 统一，轴标题标注「万元/万m³」），tooltip 显示千分位完整值（N5/N6）。
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
  /** 基础单位（元/m³/%…），轴标题在自适应后显示为 万+baseUnit。 */
  yName?: string;
}) {
  const ax = axisFormat(
    series.flatMap((s) => s.data),
    yName ?? '',
  );
  return (
    <ReactECharts
      style={{ height, width: '100%' }}
      notMerge
      option={{
        tooltip: {
          trigger: 'axis',
          valueFormatter: (v: unknown) =>
            v === null || v === undefined
              ? '—'
              : `${fmtFull(Number(v))}${yName ? ` ${yName}` : ''}`,
        },
        legend: { data: series.map((s) => s.name), top: 0 },
        grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
        xAxis: { type: 'category', data: x, boundaryGap: series.some((s) => s.type === 'bar') },
        yAxis: {
          type: 'value',
          name: ax.unitLabel || yName,
          scale: true,
          axisLabel: { formatter: (v: number) => ax.tick(v) },
        },
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
