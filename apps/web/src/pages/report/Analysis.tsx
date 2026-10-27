import { SearchOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Alert,
  Card,
  DatePicker,
  Descriptions,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { enumLabel, fmtCent, fmtDate, fmtPeriod, USAGE_CATEGORY_LABELS } from '../common';
import { PAY_CHANNEL_LABELS } from '../payment/common';

export type AnalysisKind = 'ops-daily' | 'analysis-monthly' | 'analysis-yearly';

const TITLES: Record<AnalysisKind, string> = {
  'ops-daily': '运营日报',
  'analysis-monthly': '经营分析月报',
  'analysis-yearly': '年度经营报表',
};

type Row = Record<string, unknown>;

const yuan = (v: unknown) => fmtCent(v as string | number | null | undefined);
const pct = (v: unknown) =>
  v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`;
const qty = (v: unknown) =>
  v == null ? '—' : Number(v).toLocaleString();

interface MetricCell {
  value: unknown;
  reason?: string;
  /** 口径参数快照（如连续零用水 N 期），悬停提示 */
  param?: Record<string, number>;
}

const metricText = (m: MetricCell | unknown, fmt: (v: unknown) => string) => {
  const cell = m as MetricCell;
  if (cell && typeof cell === 'object' && 'reason' in cell) {
    return (
      <Tooltip title={cell.reason}>
        <Tag color="default">暂无数据</Tag>
      </Tooltip>
    );
  }
  if (cell && typeof cell === 'object' && 'value' in cell) {
    const p = cell.param;
    const text = fmt(cell.value);
    if (p) {
      const hint = Object.entries(p)
        .map(([k, v]) => `${k}=${v}`)
        .join('，');
      return <Tooltip title={`口径参数：${hint}`}>{text}</Tooltip>;
    }
    return text;
  }
  return fmt(m);
};

/**
 * B1–B3 分析报表（§五）—— 指标 code 与 C1 字典一一对应，响应里的
 * metricVersion 可对账。数据源未到位指标显示"暂无数据"而非 0。
 */
export default function Analysis({ kind }: { kind: AnalysisKind }) {
  const { message } = AntdApp.useApp();
  const [date, setDate] = useState(dayjs());
  const [data, setData] = useState<Row | null>(null);
  const [loading, setLoading] = useState(false);
  const [queried, setQueried] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params =
        kind === 'ops-daily'
          ? { date: date.format('YYYY-MM-DD') }
          : kind === 'analysis-monthly'
            ? { period: date.format('YYYYMM') }
            : { year: date.format('YYYY') };
      const res = await api.get<Row>(`/reports/${kind}`, { params });
      setData(res.data);
      setQueried(true);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [kind, date, message]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card title={TITLES[kind]}>
      <Space style={{ marginBottom: 16 }}>
        {kind === 'ops-daily' && (
          <DatePicker value={date} onChange={(d) => d && setDate(d)} allowClear={false} />
        )}
        {kind === 'analysis-monthly' && (
          <DatePicker
            picker="month"
            value={date}
            onChange={(d) => d && setDate(d)}
            allowClear={false}
          />
        )}
        {kind === 'analysis-yearly' && (
          <DatePicker
            picker="year"
            value={date}
            onChange={(d) => d && setDate(d)}
            allowClear={false}
          />
        )}
        <Button type="primary" icon={<SearchOutlined />} onClick={() => void load()} loading={loading}>
          查询
        </Button>
        {data?.metricVersion != null && (
          <span style={{ color: '#999', fontSize: 12 }}>
            指标口径版本 {String(data.metricVersion)}
          </span>
        )}
      </Space>

      {kind === 'ops-daily' && <OpsDaily data={data} queried={queried} />}
      {kind === 'analysis-monthly' && <Monthly data={data} queried={queried} />}
      {kind === 'analysis-yearly' && <Yearly data={data} queried={queried} />}
    </Card>
  );
}

function Stat({ title, children }: { title: string; children: React.ReactNode }) {
  return <Statistic title={title} valueRender={() => <span>{children}</span>} />;
}

function OpsDaily({ data, queried }: { data: Row | null; queried: boolean }) {
  if (!queried) return null;
  const t = (data?.totals ?? {}) as Row;
  const anomalies = (data?.anomalies ?? {}) as Row;
  const empty = !data;
  return (
    <>
      {empty && <Descriptions column={1}><Descriptions.Item>当日无业务数据</Descriptions.Item></Descriptions>}
      <Space size="large" wrap>
        <Stat title="当日应收(元)">{yuan(t.billedAmount)}</Stat>
        <Stat title="当日售水量(m³)">{qty(t.soldQty)}</Stat>
        <Stat title="当日实收(元)">{yuan(t.collected)}</Stat>
        <Stat title="其中当期实收">{yuan(t.currentCollected)}</Stat>
        <Stat title="其中陈欠回收">{yuan(t.arrearsCollected)}</Stat>
        <Stat title="抄表进度">{`${t.doneReads ?? 0}/${t.plannedReads ?? 0}`}</Stat>
        <Stat title="抄见率">{pct(t.readCoverage)}</Stat>
        <Stat title="欠费总额(元)">{yuan(t.arrearsTotal)}</Stat>
        <Stat title="在册户数">{qty(t.accountCount)}</Stat>
      </Space>
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '按收款点'}
        rowKey={(r) => String(r.org ?? 'null')}
        pagination={false}
        columns={[
          { key: 'org', dataIndex: 'org', title: '收款点', render: (v) => v ?? '未分配' },
          { key: 'amount', dataIndex: 'amount', title: '实收(元)', align: 'right', render: yuan },
          { key: 'cnt', dataIndex: 'cnt', title: '笔数', align: 'right' },
        ]}
        dataSource={(data?.byOrg ?? []) as Row[]}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '按渠道'}
        rowKey="channel"
        pagination={false}
        columns={[
          {
            key: 'channel',
            dataIndex: 'channel',
            title: '渠道',
            render: (v) => enumLabel(PAY_CHANNEL_LABELS, v as keyof typeof PAY_CHANNEL_LABELS),
          },
          { key: 'amount', dataIndex: 'amount', title: '实收(元)', align: 'right', render: yuan },
          { key: 'cnt', dataIndex: 'cnt', title: '笔数', align: 'right' },
        ]}
        dataSource={(data?.byChannel ?? []) as Row[]}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '按抄表员（当日录入读数质量）'}
        rowKey={(r) => String(r.reader ?? 'null')}
        pagination={false}
        columns={[
          { key: 'reader', dataIndex: 'reader', title: '抄表员', render: (v) => v ?? '未分配' },
          { key: 'total', dataIndex: 'total', title: '读数', align: 'right' },
          { key: 'passed', dataIndex: 'passed', title: '质检通过', align: 'right' },
          { key: 'flagged', dataIndex: 'flagged', title: '异常/驳回', align: 'right' },
        ]}
        dataSource={(data?.byReader ?? []) as Row[]}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '异常明细 · 大额退费/红冲'}
        rowKey={(_r, i) => String(i)}
        pagination={false}
        columns={[
          { key: 'settleNo', dataIndex: 'settleNo', title: '结算户号' },
          { key: 'name', dataIndex: 'name', title: '户名' },
          { key: 'amount', dataIndex: 'amount', title: '金额(元)', align: 'right', render: yuan },
          {
            key: 'channel',
            dataIndex: 'channel',
            title: '渠道',
            render: (v) => enumLabel(PAY_CHANNEL_LABELS, v as keyof typeof PAY_CHANNEL_LABELS),
          },
        ]}
        dataSource={(anomalies.bigReversals ?? []) as Row[]}
        locale={{ emptyText: '当日无红冲/退费' }}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '异常明细 · 欠费 TOP10'}
        rowKey="accountNo"
        pagination={false}
        columns={[
          { key: 'accountNo', dataIndex: 'accountNo', title: '户号' },
          { key: 'customerName', dataIndex: 'customerName', title: '户名' },
          { key: 'arrears', dataIndex: 'arrears', title: '欠费(元)', align: 'right', render: yuan },
        ]}
        dataSource={(anomalies.topArrears ?? []) as Row[]}
        locale={{ emptyText: '无欠费户' }}
      />
    </>
  );
}

const MONTHLY_METRICS: { key: string; title: string; fmt: (v: unknown) => string }[] = [
  { key: 'SOLD_QTY', title: '售水量(m³)', fmt: qty },
  { key: 'AR_AMOUNT', title: '应收水费(元)', fmt: yuan },
  { key: 'COLLECTED', title: '实收水费(元)', fmt: yuan },
  { key: 'CURRENT_COLLECTED', title: '当期实收(元)', fmt: yuan },
  { key: 'ARREARS_COLLECTED', title: '陈欠回收(元)', fmt: yuan },
  { key: 'RECOVERY_RATE', title: '水费回收率', fmt: pct },
  { key: 'ARREARS_RECOVERY_RATE', title: '欠费回收率', fmt: pct },
  { key: 'ARREARS_TOTAL', title: '欠费总额(元)', fmt: yuan },
  { key: 'ARREARS_RATE', title: '欠费率', fmt: pct },
  { key: 'COMPOSITE_PRICE', title: '综合单价(分/m³)', fmt: (v) => (v == null ? '—' : String(v)) },
  { key: 'REVENUE_GROWTH', title: '营收同比', fmt: pct },
  { key: 'REVENUE_GROWTH_MOM', title: '营收环比', fmt: pct },
  { key: 'READ_ACCURACY', title: '抄表准确率', fmt: pct },
  { key: 'READ_COVERAGE', title: '抄见率', fmt: pct },
  { key: 'ESTIMATE_RATE', title: '估抄率', fmt: pct },
  { key: 'READ_TIMELINESS', title: '抄表及时率', fmt: pct },
  { key: 'READ_ARRIVAL_RATE', title: '抄表到位率', fmt: pct },
  { key: 'SMART_METER_RATE', title: '智能水表覆盖率', fmt: pct },
  { key: 'ZERO_USAGE_STREAK_RATE', title: '连续零用水户占比', fmt: pct },
  { key: 'BILL_TIMELINESS', title: '开账及时率', fmt: pct },
  { key: 'BILL_ACCURACY', title: '计费准确率', fmt: pct },
  { key: 'DISCOUNT_RATE', title: '优惠减免率', fmt: pct },
  { key: 'PREPAY_RATE', title: '预存比率', fmt: pct },
  { key: 'PREPAY_BALANCE', title: '预存余额(元)', fmt: yuan },
  { key: 'AGED_ARREARS_RATE', title: '陈欠占比', fmt: pct },
  { key: 'CHURN_RATE', title: '客户流失率', fmt: pct },
  { key: 'ACCOUNT_COUNT', title: '在册户数', fmt: (v) => (v == null ? '—' : String(v)) },
  { key: 'AVG_SOLD_PER_ACCOUNT', title: '人均售水量(m³)', fmt: qty },
  { key: 'DUN_SUCCESS_RATE', title: '催缴成功率', fmt: pct },
];

function Monthly({ data, queried }: { data: Row | null; queried: boolean }) {
  if (!queried) return null;
  const t = (data?.totals ?? {}) as Row;
  const lists = (data?.lists ?? {}) as Row;
  const aging = (data?.byAging ?? {}) as Row;
  return (
    <>
      {t.RECOVERY_RATE_ANOMALY === true && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="数据异常：当期实收超过本期应收，水费回收率不展示"
          description="窗口内销账金额大于本期应收，属于不应发生的数据状态。请核查账单与收款分摊数据。"
        />
      )}
      <Space size="large" wrap>
        {MONTHLY_METRICS.map((m) => (
          <Stat key={m.key} title={m.title}>
            {metricText(t[m.key], m.fmt)}
          </Stat>
        ))}
      </Space>
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '按用水类别'}
        rowKey="category"
        pagination={false}
        columns={[
          {
            key: 'category',
            dataIndex: 'category',
            title: '用水类别',
            render: (v) => enumLabel(USAGE_CATEGORY_LABELS, v as string),
          },
          { key: 'billed', dataIndex: 'billed', title: '应收(元)', align: 'right', render: yuan },
          { key: 'qty', dataIndex: 'qty', title: '售水量(m³)', align: 'right', render: qty },
        ]}
        dataSource={(data?.byCategory ?? []) as Row[]}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '按组织片区'}
        rowKey={(r) => String(r.org ?? 'null')}
        pagination={false}
        columns={[
          { key: 'org', dataIndex: 'org', title: '片区', render: (v) => v ?? '未分配' },
          { key: 'billed', dataIndex: 'billed', title: '应收(元)', align: 'right', render: yuan },
          { key: 'collected', dataIndex: 'collected', title: '实收(元)', align: 'right', render: yuan },
        ]}
        dataSource={(data?.byOrg ?? []) as Row[]}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '欠费账龄分段'}
        rowKey="bucket"
        pagination={false}
        columns={[
          {
            key: 'bucket',
            dataIndex: 'bucket',
            title: '账龄',
            render: (v) =>
              ({ '0-3': '0-3个月', '3-6': '3-6个月', '6-12': '6-12个月', '12+': '12个月以上' })[
                v as string
              ] ?? v,
          },
          { key: 'amount', dataIndex: 'amount', title: '欠费(元)', align: 'right', render: yuan },
        ]}
        dataSource={Object.entries(aging).map(([bucket, amount]) => ({ bucket, amount }))}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '按缴费渠道'}
        rowKey="channel"
        pagination={false}
        columns={[
          {
            key: 'channel',
            dataIndex: 'channel',
            title: '渠道',
            render: (v) => enumLabel(PAY_CHANNEL_LABELS, v as keyof typeof PAY_CHANNEL_LABELS),
          },
          { key: 'amount', dataIndex: 'amount', title: '实收(元)', align: 'right', render: yuan },
          { key: 'cnt', dataIndex: 'cnt', title: '笔数', align: 'right' },
        ]}
        dataSource={(data?.byChannel ?? []) as Row[]}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '按抄表员'}
        rowKey={(r) => String(r.reader ?? 'null')}
        pagination={false}
        columns={[
          { key: 'reader', dataIndex: 'reader', title: '抄表员', render: (v) => v ?? '未分配' },
          { key: 'total', dataIndex: 'total', title: '读数', align: 'right' },
          { key: 'passed', dataIndex: 'passed', title: '质检通过', align: 'right' },
          { key: 'flagged', dataIndex: 'flagged', title: '异常/驳回', align: 'right' },
        ]}
        dataSource={(data?.byReader ?? []) as Row[]}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '欠费清单 TOP50'}
        rowKey="accountNo"
        columns={[
          { key: 'accountNo', dataIndex: 'accountNo', title: '户号' },
          { key: 'customerName', dataIndex: 'customerName', title: '户名' },
          { key: 'arrears', dataIndex: 'arrears', title: '欠费(元)', align: 'right', render: yuan },
          {
            key: 'oldestPeriod',
            dataIndex: 'oldestPeriod',
            title: '欠费起始',
            render: fmtPeriod,
          },
        ]}
        dataSource={(lists.arrearsList ?? []) as Row[]}
        locale={{ emptyText: '本期无欠费户' }}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '红冲/退费清单'}
        rowKey={(_r, i) => String(i)}
        pagination={false}
        columns={[
          { key: 'settleNo', dataIndex: 'settleNo', title: '结算户号' },
          { key: 'name', dataIndex: 'name', title: '户名' },
          { key: 'amount', dataIndex: 'amount', title: '金额(元)', align: 'right', render: yuan },
          { key: 'receivedAt', dataIndex: 'receivedAt', title: '日期', render: fmtDate },
          {
            key: 'channel',
            dataIndex: 'channel',
            title: '渠道',
            render: (v) => enumLabel(PAY_CHANNEL_LABELS, v as keyof typeof PAY_CHANNEL_LABELS),
          },
        ]}
        dataSource={(lists.reversalList ?? []) as Row[]}
        locale={{ emptyText: '本期无红冲/退费' }}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '调账明细'}
        rowKey={(_r, i) => String(i)}
        pagination={false}
        columns={[
          { key: 'accountNo', dataIndex: 'accountNo', title: '户号' },
          { key: 'customerName', dataIndex: 'customerName', title: '户名' },
          { key: 'period', dataIndex: 'period', title: '账期', render: fmtPeriod },
          { key: 'amount', dataIndex: 'amount', title: '调整额(元)', align: 'right', render: yuan },
          {
            key: 'kind',
            dataIndex: 'kind',
            title: '账单类型',
            render: (v) => ({ NORMAL: '正常', ADJUSTMENT: '调账', REVERSAL: '红冲' })[v as string] ?? v,
          },
        ]}
        dataSource={(lists.adjustList ?? []) as Row[]}
        locale={{ emptyText: '本期无调账' }}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '异常读数清单'}
        rowKey={(_r, i) => String(i)}
        pagination={false}
        columns={[
          { key: 'accountNo', dataIndex: 'accountNo', title: '户号' },
          { key: 'period', dataIndex: 'period', title: '账期', render: fmtPeriod },
          {
            key: 'qc',
            dataIndex: 'qc',
            title: '质检状态',
            render: (v) =>
              ({ MANUAL_REVIEW: '待复核', REJECTED: '已驳回' })[v as string] ?? v,
          },
          { key: 'readingValue', dataIndex: 'readingValue', title: '读数', align: 'right' },
        ]}
        dataSource={(lists.abnormalReadings ?? []) as Row[]}
        locale={{ emptyText: '本期无异常读数' }}
      />
    </>
  );
}

function Yearly({ data, queried }: { data: Row | null; queried: boolean }) {
  if (!queried) return null;
  const t = (data?.totals ?? {}) as Row;
  const lists = (data?.lists ?? {}) as Row;
  return (
    <>
      <Space size="large" wrap>
        <Stat title="年度应收(元)">{yuan(t.AR_AMOUNT)}</Stat>
        <Stat title="年度实收(元)">{yuan(t.COLLECTED)}</Stat>
        <Stat title="营收同比">{pct(t.REVENUE_GROWTH)}</Stat>
        <Stat title="在册户数">{qty(t.ACCOUNT_COUNT)}</Stat>
        <Stat title="新装户数">{qty(t.NEW_ACCOUNTS)}</Stat>
        <Stat title="销户户数">{qty(t.CLOSED_ACCOUNTS)}</Stat>
        <Stat title="净增客户">{qty(t.NET_NEW_ACCOUNTS)}</Stat>
        <Stat title="坏账核销(元)">{yuan(t.BAD_DEBT_WRITEOFF)}</Stat>
      </Space>
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '月度趋势'}
        rowKey="period"
        pagination={false}
        columns={[
          { key: 'period', dataIndex: 'period', title: '账期', render: fmtPeriod },
          { key: 'billed', dataIndex: 'billed', title: '应收(元)', align: 'right', render: yuan },
          { key: 'collected', dataIndex: 'collected', title: '实收(元)', align: 'right', render: yuan },
          { key: 'soldQty', dataIndex: 'soldQty', title: '售水量(m³)', align: 'right', render: qty },
        ]}
        dataSource={(data?.trend ?? []) as Row[]}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '大额欠费户 TOP20'}
        rowKey="accountNo"
        pagination={false}
        columns={[
          { key: 'accountNo', dataIndex: 'accountNo', title: '户号' },
          { key: 'customerName', dataIndex: 'customerName', title: '户名' },
          { key: 'arrears', dataIndex: 'arrears', title: '欠费(元)', align: 'right', render: yuan },
          { key: 'oldestPeriod', dataIndex: 'oldestPeriod', title: '欠费起始', render: fmtPeriod },
        ]}
        dataSource={(lists.topArrears ?? []) as Row[]}
        locale={{ emptyText: '无欠费户' }}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '坏账核销清单'}
        rowKey={(_r, i) => String(i)}
        pagination={false}
        columns={[
          { key: 'settleNo', dataIndex: 'settleNo', title: '结算户号' },
          { key: 'name', dataIndex: 'name', title: '户名' },
          { key: 'amount', dataIndex: 'amount', title: '核销额(元)', align: 'right', render: yuan },
          {
            key: 'reasonCode',
            dataIndex: 'reasonCode',
            title: '原因',
            render: (v, r) => (r.reasonName as string) ?? v,
          },
          { key: 'effectiveDate', dataIndex: 'effectiveDate', title: '生效日期', render: fmtDate },
          {
            key: 'status',
            dataIndex: 'status',
            title: '状态',
            render: (v) => (v === 'ACTIVE' ? '已核销' : '已撤销'),
          },
        ]}
        dataSource={(lists.writeoffs ?? []) as Row[]}
        locale={{ emptyText: '本年无核销记录' }}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '红冲/退费（按渠道）'}
        rowKey="channel"
        pagination={false}
        columns={[
          {
            key: 'channel',
            dataIndex: 'channel',
            title: '渠道',
            render: (v) => enumLabel(PAY_CHANNEL_LABELS, v as keyof typeof PAY_CHANNEL_LABELS),
          },
          { key: 'amount', dataIndex: 'amount', title: '净额(元)', align: 'right', render: yuan },
          { key: 'cnt', dataIndex: 'cnt', title: '笔数', align: 'right' },
        ]}
        dataSource={(lists.reversals ?? []) as Row[]}
        locale={{ emptyText: '本年无红冲/退费' }}
      />
      <Table<Row> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        style={{ marginTop: 16 }}
        size="small"
        title={() => '销户/流失清单'}
        rowKey="accountNo"
        pagination={false}
        columns={[
          { key: 'accountNo', dataIndex: 'accountNo', title: '户号' },
          { key: 'customerName', dataIndex: 'customerName', title: '户名' },
          { key: 'closedAt', dataIndex: 'closedAt', title: '销户日期', render: fmtDate },
        ]}
        dataSource={(lists.closedList ?? []) as Row[]}
        locale={{ emptyText: '本年无销户' }}
      />
    </>
  );
}
