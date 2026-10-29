import Select from '../../components/CopySelect';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {App as AntdApp, Button, Card, Checkbox, Col, Drawer, Row, Segmented, Space, Spin, Typography} from 'antd';
import {
  DownloadOutlined,
  SaveOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { api, apiErrorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ReportCheckBadge, type CheckResult } from '../../components/ReportCheck';
import TrendChart from '../../components/TrendChart';
import Table from '../../components/PageTable';


interface OrgRow { id: string; name: string }
interface Meta {
  companyName: string; orgLabel: string; periodLabel: string; unit: string;
  preparedBy: string; preparedAt: string;
}
interface YearRow extends Record<string, number | string | null> { month: string }

const COL_LABELS: Record<string, string> = {
  soldQty: '售水量 (m³)',
  waterFee: '售水收入 (元)',
  collected: '实收水费 (元)',
  recoveryRate: '水费回收率 (%)',
  compositePrice: '综合单价 (元/m³)',
  arrearsTotal: '欠费余额 (元)',
};
/** 金额列 —— 存档报表固定单位（元/万元）换算作用于这些列。 */
const MONEY_COLS = new Set(['waterFee', 'collected', 'arrearsTotal']);
const ALL_COLS = Object.keys(COL_LABELS);
const DEFAULT_COLS = ['soldQty', 'waterFee', 'collected', 'recoveryRate'];

const fmt = (v: number | string | null | undefined) =>
  v === null || v === undefined || typeof v === 'string'
    ? (v ?? '—')
    : v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

/**
 * 营销经营年度汇总表（分月，修订稿 R5）—— 12 行分月 + 全年合计行，
 * 列可按需勾选增删并保存为公司模板。
 */
export default function OpsYearly() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [orgUnitId, setOrgUnitId] = useState<string>();
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [data, setData] = useState<{ meta: Meta; rows: YearRow[]; checkResults?: CheckResult[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'chart' | 'table'>('table');
  const [cols, setCols] = useState<string[]>(DEFAULT_COLS);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    api.get<OrgRow[]>('/iam/orgs').then((r) => setOrgs(r.data)).catch(() => {});
    api.get<unknown>('/iam/tenant-params/report.metrics.yearly').then((r) => {
      const v = r.data;
      if (Array.isArray(v)) setCols(v.filter((x) => ALL_COLS.includes(x)));
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/reports/ops-yearly', {
        params: { year, orgUnitId, columns: ALL_COLS.join(',') },
      });
      setData(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [year, orgUnitId, message]);

  useEffect(() => { void load(); }, [load]);

  const monthRows = useMemo(
    () => (data?.rows ?? []).filter((r) => /^\d+ 月$/.test(r.month)),
    [data],
  );
  const totalRow = (data?.rows ?? []).find((r) => r.month === '全年合计 / 平均');

  const tableCols = useMemo(
    () => {
      // N6：金额列按 meta.unit（元/万元）统一换算 + 表头标注
      const scale = data?.meta.unit === '万元' ? 1e4 : 1;
      return [
        { title: '月份', dataIndex: 'month', width: 110, fixed: 'left' as const },
        ...cols.map((c) => ({
          title:
            MONEY_COLS.has(c) && scale > 1
              ? COL_LABELS[c].replace('(元)', '(万元)')
              : COL_LABELS[c],
          dataIndex: c,
          align: 'right' as const,
          render: (v: number | null) =>
            fmt(v !== null && MONEY_COLS.has(c) ? v / scale : v),
        })),
      ];
    },
    [cols, data],
  );

  const exportXlsx = () => {
    const qs = new URLSearchParams({ year: String(year) });
    if (orgUnitId) qs.set('orgUnitId', orgUnitId);
    if (cols.length !== ALL_COLS.length) qs.set('columns', cols.join(','));
    window.open(`/api/reports/ops-yearly/export?${qs}`, '_blank');
  };

  const saveTemplate = async () => {
    try {
      await api.put('/iam/tenant-params/report.metrics.yearly', { value: cols });
      message.success('已保存为本公司年报列模板');
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          style={{ width: 110 }} value={year}
          options={Array.from({ length: 6 }, (_, i) => {
            const y = thisYear - i;
            return { value: y, label: `${y} 年` };
          })}
          onChange={setYear}
        />
        <Select
          allowClear showSearch optionFilterProp="label" style={{ width: 200 }}
          placeholder="组织范围：全公司" value={orgUnitId}
          options={orgs.map((o) => ({ value: o.id, label: o.name }))}
          onChange={(v) => setOrgUnitId(v || undefined)}
        />
        <Segmented
          value={view}
          onChange={(v) => setView(v as 'chart' | 'table')}
          options={[{ value: 'table', label: '规范表格' }, { value: 'chart', label: '图表看板' }]}
        />
        <Button icon={<SettingOutlined />} onClick={() => setPickerOpen(true)}>列勾选</Button>
        <Button icon={<DownloadOutlined />} onClick={exportXlsx}>导出 Excel</Button>
        {hasPerm('iam:write') && (
          <Button icon={<SaveOutlined />} onClick={saveTemplate}>存为公司模板</Button>
        )}
      </Space>

      <Spin spinning={loading}>
        {data && (
          <>
            <Card size="small" style={{ marginBottom: 8, textAlign: 'center' }}>
              <Typography.Text type="secondary">{data.meta.companyName}</Typography.Text>
              <Typography.Title level={4} style={{ margin: '4px 0' }}>
                营销经营年度汇总表
                <ReportCheckBadge results={data?.checkResults} />
              </Typography.Title>
              <Typography.Text type="secondary">
                统计周期：{data.meta.periodLabel}　填报单位：{data.meta.companyName}
                {data.meta.orgLabel !== '全公司' ? ` · ${data.meta.orgLabel}` : ''}　金额单位：
                {data.meta.unit}　报表期：{year} 年 1—12 月
              </Typography.Text>
            </Card>

            {view === 'chart' && (
              <Row gutter={[8, 8]} style={{ marginBottom: 8 }}>
                <Col xs={24} lg={12}>
                  <Card size="small" title="分月售水量 / 收入 / 实收">
                    <TrendChart
                      x={monthRows.map((r) => r.month)}
                      series={[
                        { name: '售水量(m³)', data: monthRows.map((r) => r.soldQty as number | null), type: 'bar' },
                        { name: '售水收入(元)', data: monthRows.map((r) => r.waterFee as number | null) },
                        { name: '实收(元)', data: monthRows.map((r) => r.collected as number | null) },
                      ]}
                    />
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card size="small" title="分月回收率 / 欠费余额">
                    <TrendChart
                      x={monthRows.map((r) => r.month)}
                      series={[
                        { name: '回收率(%)', data: monthRows.map((r) => r.recoveryRate as number | null) },
                        { name: '欠费余额(元)', data: monthRows.map((r) => r.arrearsTotal as number | null), type: 'bar' },
                      ]}
                    />
                  </Card>
                </Col>
              </Row>
            )}

            <Card size="small">
              <Table
                size="small" rowKey="month" pagination={false}
                columns={tableCols}
                dataSource={[...monthRows, ...(totalRow ? [totalRow] : [])]}
                rowClassName={(r) => (r.month === '全年合计 / 平均' ? 'total-row' : '')}
              />
              <style>{`.total-row td { font-weight: 700; background: #fffbe6; }`}</style>
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

      <Drawer title="报表列勾选" open={pickerOpen} onClose={() => setPickerOpen(false)} width={320}>
        <Space direction="vertical">
          {ALL_COLS.map((c) => (
            <Checkbox
              key={c}
              checked={cols.includes(c)}
              onChange={(e) =>
                setCols(e.target.checked ? [...cols, c] : cols.filter((x) => x !== c))
              }
            >
              {COL_LABELS[c]}
            </Checkbox>
          ))}
        </Space>
      </Drawer>
    </div>
  );
}
