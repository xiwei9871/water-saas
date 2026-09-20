import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Space,
  Statistic,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  ArMonthlyReport,
  CashierDailyRow,
  CollectedMonthlyReport,
  MeterDailyRow,
  PayChannel,
  RecoveryRateReport,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { fmtCent, fmtPeriod } from '../common';
import { OrgUnitTreeSelect, ReadingBookSelect } from '../pickers';
import { PAY_CHANNEL_LABELS } from '../payment/common';

export type ReportKind =
  | 'meter-daily'
  | 'cashier-daily'
  | 'ar-monthly'
  | 'collected-monthly'
  | 'recovery-rate';

const TITLES: Record<ReportKind, string> = {
  'meter-daily': '抄表日报',
  'cashier-daily': '收费日报',
  'ar-monthly': '应收月报',
  'collected-monthly': '实收月报',
  'recovery-rate': '回收率',
};

const CHANNELS = ['CASH', 'POS', 'TRANSFER'] as const;

interface ChannelRow {
  channel: PayChannel;
  count: number;
  amount: string;
}

/**
 * 报表（只读投影，report:read）：每张报表一个路由子页，共用本组件。
 * 查询参数为提交式（点“查询”或改日期/账期即查），不随输入逐键发请求。
 */
export default function Reports({ kind }: { kind: ReportKind }) {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canIamRead = hasPerm('iam:read');
  const canMeteringRead = hasPerm('metering:read');

  const [date, setDate] = useState<dayjs.Dayjs>(dayjs());
  const [period, setPeriod] = useState<dayjs.Dayjs>(dayjs());
  const [through, setThrough] = useState<dayjs.Dayjs | null>(null);
  const [bookId, setBookId] = useState<string | undefined>(undefined);
  const [orgUnitId, setOrgUnitId] = useState<string | undefined>(undefined);

  const [loading, setLoading] = useState(false);
  const [meterDaily, setMeterDaily] = useState<MeterDailyRow[] | null>(null);
  const [cashierDaily, setCashierDaily] = useState<CashierDailyRow[] | null>(null);
  const [arMonthly, setArMonthly] = useState<ArMonthlyReport | null>(null);
  const [collected, setCollected] = useState<CollectedMonthlyReport | null>(null);
  const [recovery, setRecovery] = useState<RecoveryRateReport | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      switch (kind) {
        case 'meter-daily': {
          const res = await api.get<MeterDailyRow[]>('/reports/meter-daily', {
            params: {
              date: date.format('YYYY-MM-DD'),
              ...(bookId ? { bookId } : {}),
              ...(orgUnitId ? { orgUnitId } : {}),
            },
          });
          setMeterDaily(res.data);
          break;
        }
        case 'cashier-daily': {
          const res = await api.get<CashierDailyRow[]>('/reports/cashier-daily', {
            params: { date: date.format('YYYY-MM-DD') },
          });
          setCashierDaily(res.data);
          break;
        }
        case 'ar-monthly': {
          const res = await api.get<ArMonthlyReport>('/reports/ar-monthly', {
            params: { period: period.format('YYYYMM') },
          });
          setArMonthly(res.data);
          break;
        }
        case 'collected-monthly': {
          const res = await api.get<CollectedMonthlyReport>(
            '/reports/collected-monthly',
            { params: { period: period.format('YYYYMM') } },
          );
          setCollected(res.data);
          break;
        }
        case 'recovery-rate': {
          if (through && through.isBefore(period, 'month')) {
            message.warning('截止月不能早于账期月');
            return;
          }
          const res = await api.get<RecoveryRateReport>('/reports/recovery-rate', {
            params: {
              period: period.format('YYYYMM'),
              ...(through ? { through: through.format('YYYYMM') } : {}),
            },
          });
          setRecovery(res.data);
          break;
        }
      }
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [bookId, date, kind, message, orgUnitId, period, through]);

  // 默认参数自动查一次；参数修改均由“查询”按钮提交重查。
  useEffect(() => {
    queueMicrotask(() => void run());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kind 由路由 key 强制重挂载，仅首查
  }, []);

  const meterColumns: ColumnsType<MeterDailyRow> = [
    { title: '册号', dataIndex: 'bookNo', key: 'bookNo', width: 140 },
    { title: '抄表册', dataIndex: 'name', key: 'name' },
    {
      title: '计划数',
      dataIndex: 'plans',
      key: 'plans',
      width: 80,
      align: 'right',
    },
    {
      title: '总户数',
      dataIndex: 'total',
      key: 'total',
      width: 90,
      align: 'right',
    },
    {
      title: '已抄',
      dataIndex: 'read',
      key: 'read',
      width: 80,
      align: 'right',
      render: (v: number) => <span style={{ color: '#3f8600' }}>{v}</span>,
    },
    {
      title: '未抄见',
      dataIndex: 'noRead',
      key: 'noRead',
      width: 90,
      align: 'right',
      render: (v: number) => (v > 0 ? <span style={{ color: '#d46b08' }}>{v}</span> : v),
    },
    {
      title: '待抄',
      dataIndex: 'pending',
      key: 'pending',
      width: 80,
      align: 'right',
    },
    {
      title: '已跳过',
      dataIndex: 'skipped',
      key: 'skipped',
      width: 90,
      align: 'right',
    },
    {
      title: '当日录入',
      dataIndex: 'readingsTaken',
      key: 'readingsTaken',
      width: 100,
      align: 'right',
      render: (v: number) => <b>{v}</b>,
    },
  ];

  const cashierColumns: ColumnsType<CashierDailyRow> = [
    {
      title: '收费员',
      key: 'cashier',
      width: 160,
      render: (_: unknown, r: CashierDailyRow) =>
        r.name ?? `${r.cashierId.slice(0, 8)}…`,
    },
    ...CHANNELS.map(
      (c): ColumnsType<CashierDailyRow>[number] => ({
        title: PAY_CHANNEL_LABELS[c],
        key: c,
        width: 150,
        align: 'right',
        render: (_: unknown, r: CashierDailyRow) => {
          const b = r.byChannel[c];
          return b && b.count > 0 ? `${b.count} 笔 ${fmtCent(b.amount)}` : '—';
        },
      }),
    ),
    {
      title: '合计',
      key: 'total',
      width: 150,
      align: 'right',
      render: (_: unknown, r: CashierDailyRow) => (
        <b>
          {r.total.count} 笔 {fmtCent(r.total.amount)}
        </b>
      ),
    },
    {
      title: '日结',
      dataIndex: 'closed',
      key: 'closed',
      width: 90,
      render: (v: boolean) =>
        v ? <Tag color="green">已日结</Tag> : <Tag>未日结</Tag>,
    },
  ];

  const channelColumns: ColumnsType<ChannelRow> = [
    {
      title: '渠道',
      dataIndex: 'channel',
      key: 'channel',
      width: 140,
      render: (c: PayChannel) => PAY_CHANNEL_LABELS[c],
    },
    { title: '笔数', dataIndex: 'count', key: 'count', width: 100, align: 'right' },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      width: 140,
      align: 'right',
      render: fmtCent,
    },
  ];

  const arRows = arMonthly
    ? Object.entries(arMonthly.byCategory)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, v]) => ({ category, ...v }))
    : [];

  const collectedRows: ChannelRow[] = collected
    ? CHANNELS.map((c) => ({
        channel: c,
        count: collected.byChannel[c]?.count ?? 0,
        amount: collected.byChannel[c]?.amount ?? '0',
      }))
    : [];

  const isDaily = kind === 'meter-daily' || kind === 'cashier-daily';

  return (
    <Card
      title={TITLES[kind]}
      extra={
        <Space wrap>
          {isDaily && (
            <DatePicker
              allowClear={false}
              value={date}
              onChange={(v) => {
                if (v) {
                  setDate(v);
                }
              }}
            />
          )}
          {(kind === 'ar-monthly' ||
            kind === 'collected-monthly' ||
            kind === 'recovery-rate') && (
            <DatePicker
              picker="month"
              allowClear={false}
              value={period}
              onChange={(v) => {
                if (v) setPeriod(v);
              }}
            />
          )}
          {kind === 'recovery-rate' && (
            <DatePicker
              picker="month"
              allowClear
              placeholder="截止月（累计口径，可空）"
              value={through}
              onChange={setThrough}
            />
          )}
          {kind === 'meter-daily' && canMeteringRead && (
            <span style={{ width: 200, display: 'inline-block' }}>
              <ReadingBookSelect
                value={bookId}
                onChange={setBookId}
                placeholder="按抄表册过滤（可空）"
              />
            </span>
          )}
          {kind === 'meter-daily' && canIamRead && (
            <span style={{ width: 190, display: 'inline-block' }}>
              <OrgUnitTreeSelect
                value={orgUnitId}
                onChange={setOrgUnitId}
                placeholder="按组织过滤（可空）"
              />
            </span>
          )}
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={loading}
            onClick={() => void run()}
          >
            查询
          </Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void run()}>
            刷新
          </Button>
        </Space>
      }
    >
      {kind === 'meter-daily' && (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="按册汇总：状态计数取所选日期所在账期的抄表计划明细快照；“当日录入”为 read_date = 所选日期的有效抄表条数（含补录往期）。"
          />
          <Table<MeterDailyRow>
            rowKey="bookId"
            size="middle"
            loading={loading}
            columns={meterColumns}
            dataSource={meterDaily ?? []}
            pagination={false}
            locale={{ emptyText: '当日无抄表工作记录' }}
          />
        </>
      )}

      {kind === 'cashier-daily' && (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="按收费员汇总当日收款（received_at 口径），红冲退款以负额计入对应渠道；“已日结”表示该收费员当日日结单已签发。"
          />
          <Table<CashierDailyRow>
            rowKey="cashierId"
            size="middle"
            loading={loading}
            columns={cashierColumns}
            dataSource={cashierDaily ?? []}
            pagination={false}
            locale={{ emptyText: '当日无收款记录' }}
          />
        </>
      )}

      {kind === 'ar-monthly' && (
        <>
          <Descriptions
            bordered
            size="small"
            column={2}
            style={{ marginBottom: 16 }}
            items={[
              { key: 'p', label: '账期', children: fmtPeriod(arMonthly?.period) },
              {
                key: 'b',
                label: '应收合计',
                children: <b>{fmtCent(arMonthly?.billed)}</b>,
              },
            ]}
          />
          <Table
            rowKey="category"
            size="middle"
            loading={loading}
            dataSource={arRows}
            pagination={false}
            columns={[
              { title: '用水类别', dataIndex: 'category', key: 'category' },
              { title: '账单数', dataIndex: 'count', key: 'count', width: 120, align: 'right' },
              {
                title: '应收金额',
                dataIndex: 'amount',
                key: 'amount',
                width: 160,
                align: 'right',
                render: fmtCent,
              },
            ]}
            locale={{ emptyText: '本期无应收账单' }}
          />
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message="口径：Σ bill.total_amount，period=账期、非红冲单、状态∈已出账/部分缴费/已缴清（草稿不算债权，红冲对儿互抵）。"
          />
        </>
      )}

      {kind === 'collected-monthly' && (
        <>
          <Descriptions
            bordered
            size="small"
            column={3}
            style={{ marginBottom: 16 }}
            items={[
              { key: 'p', label: '账期', children: fmtPeriod(collected?.period) },
              {
                key: 'c',
                label: '实收合计',
                children: <b>{fmtCent(collected?.collected)}</b>,
              },
              {
                key: 'a',
                label: '销账合计（对数）',
                children: <b>{fmtCent(collected?.allocated)}</b>,
              },
            ]}
          />
          <Table<ChannelRow>
            rowKey="channel"
            size="middle"
            loading={loading}
            dataSource={collectedRows}
            pagination={false}
            columns={channelColumns}
          />
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message="口径：Σ payment.amount，received_at 落入本月、状态∈已收款/已日结（红冲负额自然互抵）；销账侧为同月 payment_alloc 合计 —— 两侧恒等，可直接对数。"
          />
        </>
      )}

      {kind === 'recovery-rate' && (
        <>
          <Descriptions
            bordered
            size="small"
            column={2}
            style={{ marginBottom: 16 }}
            items={[
              { key: 'p', label: '账期', children: fmtPeriod(recovery?.period) },
              {
                key: 't',
                label: '口径',
                children: recovery?.through
                  ? `累计至 ${fmtPeriod(recovery.through)}`
                  : '单月',
              },
              {
                key: 'b',
                label: '应收',
                children: fmtCent(recovery?.billed),
              },
              {
                key: 'c',
                label: '实收',
                children: fmtCent(recovery?.collected),
              },
            ]}
          />
          <Card size="small" style={{ maxWidth: 360 }}>
            <Statistic
              title="回收率（实收 / 应收）"
              value={recovery?.rate === null || recovery === null || Number(recovery.billed) < 0 ? '—' : `${(Number(recovery.rate) * 100).toFixed(2)}%`}
              valueStyle={{ fontSize: 32 }}
            />
            {recovery !== null && Number(recovery.billed) < 0 && (
              <Alert type="warning" showIcon message="净应收为负，本期回收率不适用"
                description="本期调减金额大于正常应收。请结合应收、实收金额或截止月累计口径查看，不宜用负比例评价收缴表现。" />
            )}
            {recovery?.rate === null && recovery !== null && (
              <Tag color="orange">应收为 0，回收率无意义</Tag>
            )}
          </Card>
          <Alert type="info" showIcon style={{ marginTop: 12 }}
            message="统计口径：应收按账单账期统计，实收按收款日期统计（含红冲）。"
            description="本月收回历史欠费会计入本月实收，不代表本月账单的缴清比例。可选择截止月查看累计口径。" />
        </>
      )}
    </Card>
  );
}
