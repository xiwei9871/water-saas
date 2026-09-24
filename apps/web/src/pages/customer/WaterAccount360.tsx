import {
  Alert,
  App as AntdApp,
  Button,
  Descriptions,
  Drawer,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  AccountEvent,
  AccountOutstanding,
  Bill,
  ConsumptionSettlement,
  MeterReading,
  PaymentActivityRow,
  PrepaymentBalance,
  PrepaymentEntriesPage,
  ReadingBook,
  ReadingPlan,
  WaterAccountDetail,
  WaterAccountSummary360,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  fmtCent,
  fmtDate,
  fmtPeriod,
  fmtTime,
  USAGE_CATEGORY_LABELS,
} from '../common';
import { BILL_KIND_LABELS, BILL_STATUS_LABELS } from '../billing/common';
import {
  PAY_CHANNEL_LABELS,
  PAYMENT_STATUS_LABELS,
  PREPAY_ENTRY_LABELS,
} from '../payment/common';
import {
  PLAN_STATUS_LABELS,
  QC_STATUS_LABELS,
  READ_SOURCE_LABELS,
  RESULT_TYPE_LABELS,
} from '../metering/common';
import { COMPONENT_SOURCE_LABELS } from '../settlement/common';
import { AccountStatusTag } from '../pickers';
import { MeterSection } from './MeterSection';

/** ReadingPlan row when listed with ?waterAccountId — the account's own
 * plan item is embedded as myItem (see API list semantics). */
type PlanWithMyItem = ReadingPlan & {
  myItem?: { id: string; seqNo: number; status: string } | null;
};

const EVENT_TYPE_LABELS: Record<AccountEvent['type'], string> = {
  TRANSFER: '过户',
  SUSPEND: '暂停',
  RESUME: '恢复',
  CLOSE: '销户',
};

const WARNING_LABELS: Record<string, string> = {
  NO_ACTIVE_METER: '无在册水表',
  MULTI_ACTIVE_METER: '多块在册水表',
};

const PAGE_SIZE = 10;

const SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿',
  FINAL: '已核定',
};

type TabKey =
  | 'overview'
  | 'meter'
  | 'readings'
  | 'settlements'
  | 'bills'
  | 'payments'
  | 'prepay'
  | 'events';

interface TabState {
  summary?: WaterAccountSummary360;
  detail?: WaterAccountDetail;
  books?: ReadingBook[];
  plans?: PlanWithMyItem[];
  readings?: MeterReading[];
  settlements?: ConsumptionSettlement[];
  bills?: Bill[];
  outstanding?: AccountOutstanding;
  activity?: PaymentActivityRow[];
  prepayBalance?: PrepaymentBalance;
  prepayEntries?: PrepaymentEntriesPage['items'];
  events?: AccountEvent[];
}

/**
 * E8 WaterAccount 360° drawer — one object center aggregating every domain
 * through ITS OWN permission-gated endpoint (D1/D6 frozen): the summary
 * endpoint returns customer-domain data only; each tab lazy-loads via the
 * domain's existing paginated API and is hidden entirely without the
 * domain :read permission.
 */
export function WaterAccount360({
  accountId,
  onClose,
  onOpenMeterOps,
}: {
  accountId: string | null;
  onClose: () => void;
  onOpenMeterOps: (accountId: string) => void;
}) {
  const { hasPerm } = useAuth();
  const { message } = AntdApp.useApp();
  const canMetering = hasPerm('metering:read');
  const canBilling = hasPerm('billing:read');
  const canPayment = hasPerm('payment:read');
  const [tab, setTab] = useState<TabKey>('overview');
  const [data, setData] = useState<TabState>({});
  const [pages, setPages] = useState<Partial<Record<TabKey, number>>>({});
  const [loading, setLoading] = useState<Partial<Record<TabKey, boolean>>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (key: TabKey, id: string, page = 1) => {
      const skip = (page - 1) * PAGE_SIZE;
      setPages((s) => ({ ...s, [key]: page }));
      setLoading((s) => ({ ...s, [key]: true }));
      setError(null);
      try {
        switch (key) {
          case 'overview': {
            const summary = (await api.get(`/water-accounts/${id}/360`))
              .data as WaterAccountSummary360;
            setData((s) => ({ ...s, summary }));
            break;
          }
          case 'meter': {
            const detail = (await api.get(`/water-accounts/${id}`))
              .data as WaterAccountDetail;
            setData((s) => ({ ...s, detail }));
            break;
          }
          case 'readings': {
            const [books, plans, readings] = await Promise.all([
              api.get('/reading-books', { params: { waterAccountId: id } }),
              api.get('/reading-plans', {
                params: { waterAccountId: id, take: PAGE_SIZE, skip },
              }),
              api.get('/meter-readings', {
                params: { waterAccountId: id, take: PAGE_SIZE, skip },
              }),
            ]);
            setData((s) => ({
              ...s,
              books: books.data as ReadingBook[],
              plans: plans.data as PlanWithMyItem[],
              readings: readings.data as MeterReading[],
            }));
            break;
          }
          case 'settlements': {
            const rows = (
              await api.get('/consumption-settlements', {
                params: { waterAccountId: id, take: PAGE_SIZE, skip },
              })
            ).data as ConsumptionSettlement[];
            setData((s) => ({ ...s, settlements: rows }));
            break;
          }
          case 'bills': {
            const rows = (
              await api.get('/bills', {
                params: { waterAccountId: id, take: PAGE_SIZE, skip },
              })
            ).data as Bill[];
            setData((s) => ({ ...s, bills: rows }));
            break;
          }
          case 'payments': {
            const [outstanding, activity] = await Promise.all([
              api.get(`/water-accounts/${id}/outstanding`),
              api.get(`/water-accounts/${id}/payment-activity`, {
                params: { take: PAGE_SIZE, skip },
              }),
            ]);
            setData((s) => ({
              ...s,
              outstanding: outstanding.data as AccountOutstanding,
              activity: activity.data as PaymentActivityRow[],
            }));
            break;
          }
          case 'prepay': {
            const settleId = data.summary?.account.settleAccount?.id;
            if (!settleId) {
              setLoading((s) => ({ ...s, [key]: false }));
              return;
            }
            const [balance, entries] = await Promise.all([
              api.get('/prepayments/balance', {
                params: { settleAccountId: settleId },
              }),
              api.get('/prepayments/entries', {
                params: { settleAccountId: settleId, take: PAGE_SIZE, skip },
              }),
            ]);
            setData((s) => ({
              ...s,
              prepayBalance: balance.data as PrepaymentBalance,
              prepayEntries: (entries.data as PrepaymentEntriesPage).items,
            }));
            break;
          }
          case 'events': {
            const rows = (
              await api.get(`/water-accounts/${id}/events`, {
                params: { take: PAGE_SIZE, skip },
              })
            ).data as AccountEvent[];
            setData((s) => ({ ...s, events: rows }));
            break;
          }
        }
      } catch (err) {
        const text = apiErrorText(err);
        setError(text);
        message.error(text);
      } finally {
        setLoading((s) => ({ ...s, [key]: false }));
      }
    },
    [data.summary, message],
  );

  // Prepay tab depends on the summary's settleAccountId — load overview
  // first whenever the drawer opens; other tabs lazy-load on activation.
  // State reset happens during render (React's adjust-state-on-prop-change
  // pattern) so opening a different account never flashes stale data.
  const [prevAccountId, setPrevAccountId] = useState<string | null>(null);
  if (accountId !== prevAccountId) {
    setPrevAccountId(accountId);
    setData({});
    setPages({});
    setTab('overview');
  }
  useEffect(() => {
    if (!accountId) return;
    const id = accountId;
    queueMicrotask(() => void load('overview', id));
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!accountId) return;
    if (tab === 'prepay' && !data.summary) return;
    const loaded =
      (tab === 'overview' && data.summary) ||
      (tab === 'meter' && data.detail) ||
      (tab === 'readings' && data.readings) ||
      (tab === 'settlements' && data.settlements) ||
      (tab === 'bills' && data.bills) ||
      (tab === 'payments' && data.activity) ||
      (tab === 'prepay' && data.prepayEntries) ||
      (tab === 'events' && data.events);
    if (!loaded) {
      const id = accountId;
      queueMicrotask(() => void load(tab, id));
    }
  }, [tab, accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = data.summary;
  const account = summary?.account;

  // No-total lists: enable "next" while the server returns a full page.
  const pager = (key: TabKey, rows: unknown[] | undefined) => ({
    current: pages[key] ?? 1,
    pageSize: PAGE_SIZE,
    total:
      ((pages[key] ?? 1) - 1) * PAGE_SIZE +
      (rows?.length ?? 0) +
      ((rows?.length ?? 0) === PAGE_SIZE ? PAGE_SIZE : 0),
    showSizeChanger: false,
    onChange: (p: number) => {
      if (accountId) void load(key, accountId, p);
    },
  });
  const closed = account?.status === 'CLOSED';

  const items = [
    {
      key: 'overview',
      label: '概览',
      children: summary && (
        <>
          {summary.warnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={summary.warnings
                .map((w) => WARNING_LABELS[w] ?? w)
                .join('；')}
            />
          )}
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="户号">
              {account?.accountNo}
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              <AccountStatusTag status={account?.status ?? 'NORMAL'} />
            </Descriptions.Item>
            <Descriptions.Item label="客户">
              {account?.customer
                ? `${account.customer.name}（${account.customer.customerNo}）`
                : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="结算户">
              {account?.settleAccount
                ? `${account.settleAccount.name}（${account.settleAccount.settleNo}）`
                : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="地址" span={2}>
              {account?.addr ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label="用水性质">
              {USAGE_CATEGORY_LABELS[account?.usageCategory ?? ''] ??
                account?.usageCategory}
            </Descriptions.Item>
            <Descriptions.Item label="当前人数">
              {account?.householdSize ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label="开户日期">
              {fmtDate(account?.openedAt)}
            </Descriptions.Item>
            <Descriptions.Item label="销户日期">
              {closed ? fmtDate(account?.closedAt) : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="计费">
              {account?.billable === false ? '不计费' : '计费'}
            </Descriptions.Item>
            <Descriptions.Item label="在册水表">
              {summary.activeInstallationCount} 块
            </Descriptions.Item>
          </Descriptions>
        </>
      ),
    },
    {
      key: 'meter',
      label: '水表',
      children: (
        <>
          {data.detail && (
            <>
              {!closed && (
                <Space style={{ marginBottom: 16 }}>
                  <Button
                    type="primary"
                    onClick={() => accountId && onOpenMeterOps(accountId)}
                  >
                    水表操作（装/换/拆）
                  </Button>
                </Space>
              )}
              <MeterSection
                detail={data.detail}
                canWrite={false}
                onInstall={() => undefined}
                onRemove={() => undefined}
                onReplace={() => undefined}
              />
            </>
          )}
        </>
      ),
    },
    ...(canMetering
      ? [
          {
            key: 'readings',
            label: '抄表',
            children: (
              <>
                <Descriptions
                  column={1}
                  size="small"
                  title="抄表册 / 计划"
                  style={{ marginBottom: 8 }}
                />
                <Table<ReadingBook>
                  rowKey="id"
                  size="small"
                  dataSource={data.books ?? []}
                  pagination={false}
                  locale={{ emptyText: '未加入抄表册' }}
                  columns={[
                    { title: '册号', dataIndex: 'bookNo' },
                    { title: '册名', dataIndex: 'name' },
                  ]}
                  style={{ marginBottom: 16 }}
                />
                <Table<PlanWithMyItem>
                  rowKey="id"
                  size="small"
                  dataSource={data.plans ?? []}
                  pagination={false}
                  locale={{ emptyText: '暂无计划' }}
                  columns={[
                    {
                      title: '账期',
                      dataIndex: 'period',
                      render: (p: string) => fmtPeriod(p),
                    },
                    {
                      title: '计划日期',
                      dataIndex: 'planDate',
                      render: (d: string) => fmtDate(d),
                    },
                    {
                      title: '计划状态',
                      dataIndex: 'status',
                      render: (s: ReadingPlan['status']) => PLAN_STATUS_LABELS[s],
                    },
                    {
                      title: '本户任务',
                      key: 'myItem',
                      render: (_: unknown, r) =>
                        r.myItem
                          ? `#${r.myItem.seqNo} ${r.myItem.status}`
                          : '—',
                    },
                  ]}
                  style={{ marginBottom: 16 }}
                />
                <Table<MeterReading>
                  rowKey="id"
                  size="small"
                  dataSource={data.readings ?? []}
                  pagination={pager('readings', data.readings)}
                  locale={{ emptyText: '暂无读数' }}
                  columns={[
                    {
                      title: '账期',
                      dataIndex: 'period',
                      render: (p: string) => fmtPeriod(p),
                    },
                    {
                      title: '读数日期',
                      dataIndex: 'readDate',
                      render: (d: string) => fmtDate(d),
                    },
                    { title: '表码', dataIndex: 'readingValue' },
                    {
                      title: '类型',
                      dataIndex: 'resultType',
                      render: (t: MeterReading['resultType']) => RESULT_TYPE_LABELS[t],
                    },
                    {
                      title: '来源',
                      dataIndex: 'source',
                      render: (s: MeterReading['source']) => READ_SOURCE_LABELS[s],
                    },
                    {
                      title: 'QC',
                      dataIndex: 'qcStatus',
                      render: (s: MeterReading['qcStatus']) => QC_STATUS_LABELS[s],
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'settlements',
            label: '结算',
            children: (
              <Table<ConsumptionSettlement>
                rowKey="id"
                size="small"
                dataSource={data.settlements ?? []}
                pagination={pager('settlements', data.settlements)}
                locale={{ emptyText: '暂无结算' }}
                expandable={{
                  rowExpandable: (r) => r.components.length > 0,
                  expandedRowRender: (r) => (
                    <Table
                      rowKey="id"
                      size="small"
                      dataSource={r.components}
                      pagination={false}
                      columns={[
                        { title: '始码', dataIndex: 'prevReadingValue' },
                        {
                          title: '止码',
                          dataIndex: 'endReadingValue',
                          render: (v: string | null) => v ?? '—',
                        },
                        { title: '用量', dataIndex: 'usageQty' },
                        {
                          title: '来源',
                          dataIndex: 'sourceType',
                          render: (t: string) => COMPONENT_SOURCE_LABELS[t as keyof typeof COMPONENT_SOURCE_LABELS] ?? t,
                        },
                      ]}
                    />
                  ),
                }}
                columns={[
                  {
                    title: '账期',
                    dataIndex: 'period',
                    render: (p: string) => fmtPeriod(p),
                  },
                  { title: '总用量', dataIndex: 'totalUsageQty' },
                  {
                    title: '计量',
                    dataIndex: 'isEstimated',
                    render: (e: boolean) =>
                      e ? <Tag color="orange">预估</Tag> : '实测',
                  },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    render: (s: string) => SETTLEMENT_STATUS_LABELS[s] ?? s,
                  },
                  {
                    title: '连续预估',
                    dataIndex: 'consecutiveEstimates',
                    render: (n: number) => (n > 0 ? n : '—'),
                  },
                ]}
              />
            ),
          },
        ]
      : []),
    ...(canBilling
      ? [
          {
            key: 'bills',
            label: '账单',
            children: (
              <Table<Bill>
                rowKey="id"
                size="small"
                dataSource={data.bills ?? []}
                pagination={pager('bills', data.bills)}
                locale={{ emptyText: '暂无账单' }}
                columns={[
                  {
                    title: '账期',
                    dataIndex: 'period',
                    render: (p: string) => fmtPeriod(p),
                  },
                  {
                    title: '类型',
                    dataIndex: 'billKind',
                    render: (k: Bill['billKind']) => BILL_KIND_LABELS[k],
                  },
                  {
                    title: '金额',
                    dataIndex: 'totalAmount',
                    align: 'right' as const,
                    render: (v: string) => fmtCent(v),
                  },
                  {
                    title: '计量',
                    dataIndex: 'isEstimated',
                    render: (e: boolean) =>
                      e ? <Tag color="orange">预估</Tag> : '—',
                  },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    render: (s: Bill['status']) => BILL_STATUS_LABELS[s],
                  },
                ]}
              />
            ),
          },
        ]
      : []),
    ...(canPayment
      ? [
          {
            key: 'payments',
            label: '缴费',
            children: (
              <>
                {data.outstanding && (
                  <Descriptions
                    column={3}
                    size="small"
                    bordered
                    style={{ marginBottom: 16 }}
                  >
                    <Descriptions.Item label="欠费合计">
                      {fmtCent(data.outstanding.totalOutstanding)}
                    </Descriptions.Item>
                    <Descriptions.Item label="红冲挂账">
                      {fmtCent(data.outstanding.reversedBillCredit)}
                    </Descriptions.Item>
                    <Descriptions.Item label="预存余额">
                      {fmtCent(data.outstanding.prepaymentBalance)}
                    </Descriptions.Item>
                  </Descriptions>
                )}
                <Table<PaymentActivityRow>
                  rowKey="id"
                  size="small"
                  dataSource={data.activity ?? []}
                  pagination={pager('payments', data.activity)}
                  locale={{ emptyText: '暂无偿付记录' }}
                  columns={[
                    {
                      title: '时间',
                      dataIndex: 'createdAt',
                      render: (t: string) => fmtTime(t),
                    },
                    {
                      title: '来源',
                      dataIndex: 'source',
                      render: (s: PaymentActivityRow['source']) =>
                        s === 'PAYMENT' ? (
                          <Tag color="blue">柜台支付</Tag>
                        ) : (
                          <Tag color="purple">预存抵扣</Tag>
                        ),
                    },
                    {
                      title: '单号',
                      key: 'docNo',
                      render: (_: unknown, r) =>
                        r.source === 'PAYMENT'
                          ? (r.payment?.paymentNo ?? '—')
                          : `预存 ${r.prepaymentEntry?.id.slice(0, 8) ?? '—'}`,
                    },
                    {
                      title: '核销金额',
                      dataIndex: 'allocatedAmount',
                      align: 'right' as const,
                      render: (v: string) => fmtCent(v),
                    },
                    {
                      title: '账单账期',
                      key: 'period',
                      render: (_: unknown, r) => fmtPeriod(r.bill.period),
                    },
                    {
                      title: '渠道/状态',
                      key: 'ch',
                      render: (_: unknown, r) =>
                        r.source === 'PAYMENT' && r.payment
                          ? `${PAY_CHANNEL_LABELS[r.payment.channel] ?? r.payment.channel} / ${PAYMENT_STATUS_LABELS[r.payment.status] ?? r.payment.status}`
                          : '—',
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'prepay',
            label: '预存',
            children: (
              <>
                {data.prepayBalance && (
                  <Descriptions
                    column={1}
                    size="small"
                    bordered
                    style={{ marginBottom: 16 }}
                  >
                    <Descriptions.Item label="预存余额">
                      {fmtCent(data.prepayBalance.balance)}
                    </Descriptions.Item>
                  </Descriptions>
                )}
                <Table<PrepaymentEntriesPage['items'][number]>
                  rowKey="id"
                  size="small"
                  dataSource={data.prepayEntries ?? []}
                  pagination={pager('prepay', data.prepayEntries)}
                  locale={{ emptyText: '暂无预存流水' }}
                  columns={[
                    {
                      title: '时间',
                      dataIndex: 'createdAt',
                      render: (t: string) => fmtTime(t),
                    },
                    {
                      title: '类型',
                      dataIndex: 'type',
                      render: (t: PrepaymentEntriesPage['items'][number]['type']) =>
                        PREPAY_ENTRY_LABELS[t] ?? t,
                    },
                    {
                      title: '金额',
                      dataIndex: 'amount',
                      align: 'right' as const,
                      render: (v: string) => fmtCent(v),
                    },
                    { title: '摘要', dataIndex: 'reason' },
                  ]}
                />
              </>
            ),
          },
        ]
      : []),
    {
      key: 'events',
      label: '事件',
      children: (
        <Table<AccountEvent>
          rowKey="id"
          size="small"
          dataSource={data.events ?? []}
          pagination={pager('events', data.events)}
          locale={{ emptyText: '暂无生命周期事件' }}
          columns={[
            {
              title: '生效日期',
              dataIndex: 'effectiveDate',
              render: (d: string) => fmtDate(d),
            },
            {
              title: '事件',
              dataIndex: 'type',
              render: (t: AccountEvent['type']) => EVENT_TYPE_LABELS[t] ?? t,
            },
            {
              title: '登记时间',
              dataIndex: 'createdAt',
              render: (t: string) => fmtTime(t),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <Drawer
      open={accountId !== null}
      title={
        account ? `360° — ${account.accountNo}` : '360° 用水户'
      }
      width={920}
      onClose={onClose}
    >
      {error && (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
      )}
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as TabKey)}
        items={items.map((it) => ({
          ...it,
          children: loading[it.key as TabKey] ? null : it.children,
        }))}
      />
    </Drawer>
  );
}
