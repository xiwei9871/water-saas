import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  InputNumber,
  Segmented,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd';
import { DownloadOutlined, SearchOutlined } from '@ant-design/icons';
import { api, apiErrorText } from '../../api/client';
import TrendChart from '../../components/TrendChart';
import { USAGE_CATEGORY_OPTIONS } from '../common';
import { columnScale } from '../../utils/numfmt';

type GroupBy = 'ALL' | 'ORG' | 'CATEGORY';

interface AllRow {
  year: number; soldQty: number; waterFee: number; arAmount: number;
  collected: number; recoveryRate: number | null; compositePrice: number | null;
  arrearsTotal: number; accountCount: number;
  yoy: { soldQty: number | null; waterFee: number | null; arAmount: number | null; collected: number | null };
}
interface GroupRow {
  group: string; year: number; soldQty: number; arAmount: number;
  collected: number; compositePrice: number | null;
  yoy: { soldQty: number | null; arAmount: number | null; collected: number | null };
}

const fmt = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? '—' : v.toLocaleString('zh-CN', { maximumFractionDigits: d });
const fmtPct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

const CAT_LABELS = Object.fromEntries(USAGE_CATEGORY_OPTIONS.map((o) => [o.value, o.label]));

/**
 * 汇总趋势（修订稿 Q1）—— 突破明细"仅一年 12 列"的粒度：默认近 3 年
 * 年度汇总 + 同比，维度可选 全公司/片区/用水类别，表格 + 趋势图 + 导出。
 */
export default function SummaryPanel() {
  const { message } = AntdApp.useApp();
  const [groupBy, setGroupBy] = useState<GroupBy>('ALL');
  const [years, setYears] = useState(3);
  const [data, setData] = useState<{ rows: (AllRow | GroupRow)[]; years: number[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/reports/summary-trend', {
        params: { groupBy, years },
      });
      setData(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [groupBy, years, message]);

  useEffect(() => { void load(); }, [load]);

  // N6 整列统一单位：金额列按列内最大值选 元/万元/亿元，表头标注
  const moneyCol = (title: string, key: string) => {
    const sc = columnScale((data?.rows ?? []).map(
      (r) => (r as unknown as Record<string, number | null>)[key],
    ));
    return {
      title: sc.label === '元' ? title : title.replace('(元)', `(${sc.label})`),
      dataIndex: key, align: 'right' as const,
      render: (v: number | null) => sc.cell(v),
    };
  };
  const allCols = [
    { title: '年度', dataIndex: 'year', width: 70 },
    { title: '售水量(m³)', dataIndex: 'soldQty', align: 'right' as const, render: (v: number) => fmt(v, 0) },
    moneyCol('售水收入(元)', 'waterFee'),
    moneyCol('应收(元)', 'arAmount'),
    moneyCol('实收(元)', 'collected'),
    { title: '回收率', dataIndex: 'recoveryRate', align: 'right' as const, render: (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}%`) },
    { title: '综合单价', dataIndex: 'compositePrice', align: 'right' as const, render: (v: number | null) => fmt(v) },
    moneyCol('欠费余额(元)', 'arrearsTotal'),
    { title: '在册户数', dataIndex: 'accountCount', align: 'right' as const, render: (v: number) => fmt(v, 0) },
    { title: '售水量同比', dataIndex: ['yoy', 'soldQty'], align: 'right' as const, render: (v: number | null) => fmtPct(v) },
    { title: '实收同比', dataIndex: ['yoy', 'collected'], align: 'right' as const, render: (v: number | null) => fmtPct(v) },
  ];
  const groupCols = [
    { title: '分组', dataIndex: 'group', width: 120, render: (v: string) => CAT_LABELS[v] ?? v },
    { title: '年度', dataIndex: 'year', width: 70 },
    { title: '售水量(m³)', dataIndex: 'soldQty', align: 'right' as const, render: (v: number) => fmt(v, 0) },
    moneyCol('应收(元)', 'arAmount'),
    moneyCol('实收(元)', 'collected'),
    { title: '综合单价', dataIndex: 'compositePrice', align: 'right' as const, render: (v: number | null) => fmt(v) },
    { title: '售水量同比', dataIndex: ['yoy', 'soldQty'], align: 'right' as const, render: (v: number | null) => fmtPct(v) },
    { title: '实收同比', dataIndex: ['yoy', 'collected'], align: 'right' as const, render: (v: number | null) => fmtPct(v) },
  ];

  const chartSeries = useMemo(() => {
    if (!data) return [];
    if (groupBy === 'ALL') {
      const rows = data.rows as AllRow[];
      return [
        { name: '售水量(m³)', data: rows.map((r) => r.soldQty), type: 'bar' as const },
        { name: '售水收入(元)', data: rows.map((r) => r.waterFee) },
        { name: '实收(元)', data: rows.map((r) => r.collected) },
      ];
    }
    const rows = data.rows as GroupRow[];
    const groups = [...new Set(rows.map((r) => r.group))];
    return groups.slice(0, 8).map((g) => ({
      name: CAT_LABELS[g] ?? g,
      data: data.years.map(
        (y) => rows.find((r) => r.group === g && r.year === y)?.collected ?? null,
      ),
    }));
  }, [data, groupBy]);

  const exportXlsx = () =>
    window.open(`/api/reports/summary-trend/export?groupBy=${groupBy}&years=${years}`, '_blank');

  return (
    <Card size="small" title="汇总趋势">
      <Space style={{ marginBottom: 12 }} wrap>
        <Segmented
          value={groupBy}
          onChange={(v) => setGroupBy(v as GroupBy)}
          options={[
            { value: 'ALL', label: '全公司' },
            { value: 'ORG', label: '片区' },
            { value: 'CATEGORY', label: '用水类别' },
          ]}
        />
        <span>近</span>
        <InputNumber min={1} max={10} value={years} onChange={(v) => setYears(v ?? 3)} style={{ width: 70 }} />
        <span>年（含同比）</span>
        <Button type="primary" icon={<SearchOutlined />} onClick={() => void load()}>查询</Button>
        <Button icon={<DownloadOutlined />} onClick={exportXlsx}>导出 Excel</Button>
      </Space>
      <Spin spinning={loading}>
        {data && (
          <>
            <TrendChart
              x={groupBy === 'ALL' ? data.years.map(String) : data.years.map(String)}
              series={chartSeries}
              height={300}
            />
            <Table
              size="small" style={{ marginTop: 12 }} pagination={false}
              rowKey={(r) => `${(r as GroupRow).group ?? ''}-${(r as AllRow).year}`}
              columns={(groupBy === 'ALL' ? allCols : groupCols) as never}
              dataSource={data.rows}
              scroll={{ x: true }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              口径：售水量/应收/实收为窗口求和；比率按窗口内分子分母重算；
              收费类按收款单组织归属，其余按户的抄表册组织归属。
            </Typography.Text>
          </>
        )}
      </Spin>
    </Card>
  );
}
