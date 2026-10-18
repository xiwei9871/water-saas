import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  Drawer,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Tooltip,
  Table,
  Typography,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DownloadOutlined,
  SaveOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api, apiErrorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import TrendChart from '../../components/TrendChart';
import { abbrevParts } from '../../utils/numfmt';

interface OrgRow { id: string; name: string }

interface Meta {
  companyName: string;
  orgLabel: string;
  periodLabel: string;
  unit: string;
  preparedBy: string;
  preparedAt: string;
  metricVersion: string;
}

interface MetricRow {
  seq: number;
  key: string;
  name: string;
  unit: string;
  current: number | null;
  prevYear: number | null;
  yoyPct: number | null;
  cum: number | null;
  prevCum: number | null;
  cumYoyPct: number | null;
}

interface Section { name: string; rows: MetricRow[] }

interface YearRow {
  month: string;
  soldQty: number | null;
  waterFee: number | null;
  collected: number | null;
  recoveryRate: number | null;
  compositePrice: number | null;
  arrearsTotal: number | null;
}

const fmt = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined
    ? '—'
    : v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const ALL_METRIC_KEYS = [
  'SOLD_QTY', 'WATER_FEE', 'COMPOSITE_PRICE', 'COLLECTED', 'CURRENT_COLLECTED',
  'ARREARS_COLLECTED', 'RECOVERY_RATE', 'PREPAY_BALANCE', 'PREPAY_RATE',
  'ARREARS_TOTAL', 'ARREARS_RATE', 'ARREARS_RECOVERY_RATE', 'READ_ACCURACY',
  'READ_COVERAGE', 'ESTIMATE_RATE', 'READ_TIMELINESS', 'ACCOUNT_COUNT',
  'NEW_ACCOUNTS', 'CLOSED_ACCOUNTS', 'NET_NEW_ACCOUNTS', 'REVENUE_GROWTH',
];

/** 默认收起细项行（「其中」与质量率细节），勾选展开。 */
const DEFAULT_DETAIL: Record<string, boolean> = {
  CURRENT_COLLECTED: false, ARREARS_COLLECTED: false, PREPAY_RATE: false,
  ARREARS_RATE: false, ARREARS_RECOVERY_RATE: false,
};

/**
 * 营销经营月报表（修订稿 R1-R7）—— 图表看板与规范数字表同源同口径。
 * 顶部 KPI 卡 → 中部趋势 → 底部可折叠规范表（四要素：标题/表头/表体/签章）。
 */
export default function OpsMonthly() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const now = new Date();
  const [period, setPeriod] = useState(
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`,
  );
  const [orgUnitId, setOrgUnitId] = useState<string>();
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [data, setData] = useState<{ meta: Meta; sections: Section[] } | null>(null);
  const [yearTrend, setYearTrend] = useState<YearRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'chart' | 'table'>('table');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [metricKeys, setMetricKeys] = useState<string[]>(ALL_METRIC_KEYS);
  const [collapsedDetail, setCollapsedDetail] = useState(false);

  useEffect(() => {
    api.get<OrgRow[]>('/iam/orgs').then((r) => setOrgs(r.data)).catch(() => {});
    // R3：本公司保存过的指标模板
    api.get<unknown>('/iam/tenant-params/report.metrics.monthly').then((r) => {
      const v = r.data;
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        setMetricKeys(v.filter((k) => ALL_METRIC_KEYS.includes(k)));
      }
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { period, orgUnitId };
      const [res, yr] = await Promise.all([
        api.get('/reports/ops-monthly', { params }),
        api.get('/reports/ops-yearly', {
          params: { year: period.slice(0, 4), orgUnitId },
        }),
      ]);
      setData(res.data);
      setYearTrend(yr.data.rows.filter((r: YearRow) => /^\d+ 月$/.test(r.month)));
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [period, orgUnitId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const sections = useMemo(() => {
    if (!data) return [];
    const rows = data.sections.map((s) => ({
      ...s,
      rows: s.rows.filter(
        (r) => metricKeys.includes(r.key) && (!collapsedDetail || DEFAULT_DETAIL[r.key] !== false),
      ),
    }));
    return rows.filter((s) => s.rows.length > 0);
  }, [data, metricKeys, collapsedDetail]);

  const flatRows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  const find = (key: string) => flatRows.find((r) => r.key === key);
  const topCards = ['SOLD_QTY', 'WATER_FEE', 'RECOVERY_RATE', 'COMPOSITE_PRICE', 'READ_ACCURACY']
    .map(find)
    .filter((r): r is MetricRow => !!r);

  const saveTemplate = async () => {
    try {
      await api.put('/iam/tenant-params/report.metrics.monthly', { value: metricKeys });
      message.success('已保存为本公司月报指标模板');
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const exportXlsx = () => {
    const qs = new URLSearchParams({ period });
    if (orgUnitId) qs.set('orgUnitId', orgUnitId);
    window.open(`/api/reports/ops-monthly/export?${qs}`, '_blank');
  };

  type TableRow = Partial<MetricRow> & { key: string; section?: boolean };
  // N6 存档报表固定单位：meta.unit（元/万元），行内「元」单位按系数换算
  const mScale = data?.meta.unit === '万元' ? 1e4 : 1;
  const cellNum = (v: number | null | undefined, r: TableRow) =>
    fmt(
      v !== null && v !== undefined && r.unit === '元' ? v / mScale : v,
      r.unit === '%' || r.unit === '元/m³' || mScale > 1 ? 2 : 0,
    );
  const tableCols: ColumnsType<TableRow> = [
    { title: '序号', dataIndex: 'seq', width: 56 },
    { title: '指标名称', dataIndex: 'name', width: 170 },
    { title: '单位', dataIndex: 'unit', width: 70,
      render: (u: string) => (u === '元' && mScale > 1 ? '万元' : u) },
    { title: '本月数', dataIndex: 'current', align: 'right' as const, render: cellNum },
    { title: '上年同月', dataIndex: 'prevYear', align: 'right' as const, render: cellNum },
    { title: '同比增减(%)', dataIndex: 'yoyPct', align: 'right' as const, render: (v: number | null) => fmt(v) },
    { title: '本年累计', dataIndex: 'cum', align: 'right' as const, render: cellNum },
    { title: '上年同期累计', dataIndex: 'prevCum', align: 'right' as const, render: cellNum },
    { title: '累计增减(%)', dataIndex: 'cumYoyPct', align: 'right' as const, render: (v: number | null) => fmt(v) },
  ];

  const monthOpts = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (let i = 0; i < 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const p = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
      opts.push({ value: p, label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月` });
    }
    return opts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select size="middle" style={{ width: 150 }} value={period} options={monthOpts}
          onChange={setPeriod} />
        <Select
          allowClear showSearch optionFilterProp="label" style={{ width: 200 }}
          placeholder="组织范围：全公司" value={orgUnitId}
          options={[{ value: '', label: '全公司' }].concat(orgs.map((o) => ({ value: o.id, label: o.name })))}
          onChange={(v) => setOrgUnitId(v || undefined)}
        />
        <Segmented
          value={view}
          onChange={(v) => setView(v as 'chart' | 'table')}
          options={[{ value: 'table', label: '规范表格' }, { value: 'chart', label: '图表看板' }]}
        />
        <Button icon={<SettingOutlined />} onClick={() => setPickerOpen(true)}>指标勾选</Button>
        <Button icon={<DownloadOutlined />} onClick={exportXlsx}>导出 Excel</Button>
        {hasPerm('iam:write') && (
          <Button icon={<SaveOutlined />} onClick={saveTemplate}>存为公司模板</Button>
        )}
      </Space>

      <Spin spinning={loading}>
        {data && (
          <>
            {/* 规范表版式 · 标题区 */}
            <Card size="small" style={{ marginBottom: 8, textAlign: 'center' }}>
              <Typography.Text type="secondary">{data.meta.companyName}</Typography.Text>
              <Typography.Title level={4} style={{ margin: '4px 0' }}>
                营销经营月报表
              </Typography.Title>
              <Typography.Text type="secondary">
                统计周期：{data.meta.periodLabel}　填报单位：{data.meta.companyName}
                {data.meta.orgLabel !== '全公司' ? ` · ${data.meta.orgLabel}` : ''}　金额单位：
                {data.meta.unit}　报表期：{data.meta.periodLabel}　指标口径版本{' '}
                {data.meta.metricVersion}
              </Typography.Text>
            </Card>

            {/* 顶层 KPI 卡（本期 vs 上年同期） */}
            <Row gutter={[8, 8]} style={{ marginBottom: 8 }}>
              {topCards.map((r) => {
                // N5 卡片逐值自适应：万/亿缩写，悬停见千分位完整值
                const ab = abbrevParts(r.current);
                return (
                <Col key={r.key} flex="1 1 160px">
                  <Card size="small">
                    <Tooltip title={`${ab.full} ${r.unit}`}>
                      <Statistic
                        title={r.name}
                        value={ab.text === '—' ? undefined : ab.text}
                        suffix={`${ab.unit}${r.unit === '元' ? ' 元' : r.unit}`}
                        valueStyle={{ fontSize: 20 }}
                      />
                    </Tooltip>
                    <Typography.Text type={r.yoyPct !== null && r.yoyPct < 0 ? 'danger' : 'success'} style={{ fontSize: 12 }}>
                      同比 {r.yoyPct === null ? '—' : `${r.yoyPct >= 0 ? '+' : ''}${fmt(r.yoyPct)}%`}
                      {r.yoyPct !== null && (r.yoyPct >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />)}
                    </Typography.Text>
                  </Card>
                </Col>
                );
              })}
            </Row>

            {view === 'chart' && (
              <Row gutter={[8, 8]}>
                <Col xs={24} lg={12}>
                  <Card size="small" title={`${period.slice(0, 4)} 年售水量 / 售水收入趋势`}>
                    <TrendChart
                      x={yearTrend.map((r) => r.month)}
                      series={[
                        { name: '售水量(m³)', data: yearTrend.map((r) => r.soldQty), type: 'bar' },
                        { name: '售水收入(元)', data: yearTrend.map((r) => r.waterFee) },
                      ]}
                    />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card size="small" title="回收率 / 欠费余额趋势">
                    <TrendChart
                      x={yearTrend.map((r) => r.month)}
                      series={[
                        { name: '回收率(%)', data: yearTrend.map((r) => r.recoveryRate) },
                        { name: '欠费余额(元)', data: yearTrend.map((r) => r.arrearsTotal), type: 'bar' },
                      ]}
                    />
                  </Card>
                </Col>
              </Row>
            )}

            {/* 规范表体 */}
            <Card size="small" style={{ marginTop: 8 }}>
              <Table
                size="small"
                rowKey="key"
                pagination={false}
                columns={tableCols}
                dataSource={sections.flatMap<TableRow>((s) => [
                  { key: `sec-${s.name}`, name: s.name, section: true },
                  ...s.rows,
                ])}
                rowClassName={(r) => (r.section ? 'section-row' : '')}
                components={{
                  body: {
                    row: (props: { children?: React.ReactNode; className?: string }) => (
                      <tr {...props} className={props.className} />
                    ),
                  },
                }}
              />
              <style>{`.section-row td { font-weight: 600; background: #fafafa; }`}</style>
              {/* 表尾签章 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 8px 0', color: '#666' }}>
                <span>编制人：{data.meta.preparedBy}</span>
                <span>复核人：</span>
                <span>负责人：</span>
                <span>编制日期：{data.meta.preparedAt}</span>
              </div>
            </Card>
          </>
        )}
      </Spin>

      <Drawer
        title="指标勾选（实时重排报表）"
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        width={360}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Checkbox
            checked={collapsedDetail}
            onChange={(e) => setCollapsedDetail(e.target.checked)}
          >
            收起「其中」与质量率细项
          </Checkbox>
          {ALL_METRIC_KEYS.map((k) => {
            const row = flatRows.find((r) => r.key === k);
            return (
              <Checkbox
                key={k}
                checked={metricKeys.includes(k)}
                onChange={(e) =>
                  setMetricKeys(
                    e.target.checked
                      ? [...metricKeys, k]
                      : metricKeys.filter((x) => x !== k),
                  )
                }
              >
                {row?.name ?? k} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{k}</Typography.Text>
              </Checkbox>
            );
          })}
        </Space>
      </Drawer>
    </div>
  );
}
