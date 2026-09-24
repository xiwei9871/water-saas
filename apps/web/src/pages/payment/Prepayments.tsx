import {
  Alert,
  App as AntdApp,
  Card,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  PrepaymentBalance,
  PrepaymentEntriesPage,
  PrepaymentEntry,
  WaterAccount,
} from '../../api/types';
import { fmtCent, fmtTime } from '../common';
import { PREPAY_ENTRY_COLORS, PREPAY_ENTRY_LABELS } from './common';
import {
  CustomerSelect,
  SettleAccountSelect,
  WaterAccountSearchSelect,
} from '../pickers';

const ENTRY_TYPE_OPTIONS = [
  { value: 'TOP_UP', label: '预存充值' },
  { value: 'APPLY', label: '预存抵扣' },
  { value: 'REFUND', label: '预存退款' },
  { value: 'REVERSAL', label: '预存冲正' },
];

/**
 * 预存管理（RC1-6/F7）：按客户 / 用水户号 / 结算户定位预存账户，
 * 查余额 + 流水（充值 / 抵扣 / 退款）。充值动作仍在收费台完成。
 */
export default function Prepayments() {
  const { message } = AntdApp.useApp();
  const [customerId, setCustomerId] = useState<string>();
  const [settleAccountId, setSettleAccountId] = useState<string>();
  const [settleOpts, setSettleOpts] = useState<
    { value: string; label: string }[]
  >([]);
  const [balance, setBalance] = useState<PrepaymentBalance | null>(null);
  const [type, setType] = useState<string>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [entries, setEntries] = useState<PrepaymentEntriesPage>({
    total: 0,
    items: [],
  });
  const [loading, setLoading] = useState(false);

  // 选客户 → 取该客户全部用水户的结算户集合；唯一则自动选中。
  const onCustomer = useCallback(
    async (cid: string | undefined) => {
      setCustomerId(cid);
      setSettleOpts([]);
      if (!cid) return;
      try {
        const res = await api.get<WaterAccount[]>('/water-accounts', {
          params: { customerId: cid, take: 100 },
        });
        const uniq = new Map<string, string>();
        for (const a of res.data) {
          if (!uniq.has(a.settleAccountId)) {
            uniq.set(a.settleAccountId, a.settleAccount?.settleNo ?? a.settleAccountId);
          }
        }
        const opts = [...uniq.entries()].map(([value, settleNo]) => ({
          value,
          label: `结算户 ${settleNo}`,
        }));
        setSettleOpts(opts);
        if (opts.length === 1) setSettleAccountId(opts[0].value);
        else setSettleAccountId(undefined);
      } catch (err) {
        message.error(apiErrorText(err));
      }
    },
    [message],
  );

  // 余额：仅在已定位到具体结算户时查询。
  useEffect(() => {
    if (!settleAccountId) {
      queueMicrotask(() => setBalance(null));
      return;
    }
    let cancelled = false;
    api
      .get<PrepaymentBalance>('/prepayments/balance', {
        params: { settleAccountId },
      })
      .then((res) => {
        if (!cancelled) setBalance(res.data);
      })
      .catch((err) => message.error(apiErrorText(err)));
    return () => {
      cancelled = true;
    };
  }, [settleAccountId, message]);

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<PrepaymentEntriesPage>('/prepayments/entries', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(settleAccountId ? { settleAccountId } : {}),
            ...(type ? { type } : {}),
          },
        });
        setEntries(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [settleAccountId, type, message],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  const columns: ColumnsType<PrepaymentEntry> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string) => fmtTime(v),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 110,
      render: (t: PrepaymentEntry['type']) => (
        <Tag color={PREPAY_ENTRY_COLORS[t]}>{PREPAY_ENTRY_LABELS[t]}</Tag>
      ),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: string) => fmtCent(v),
    },
    { title: '原因', dataIndex: 'reason', render: (v: string | null) => v ?? '—' },
    {
      title: '结算户',
      dataIndex: 'settleAccountId',
      width: 180,
      render: (v: string) =>
        balance && v === balance.settleAccount.id
          ? `${balance.settleAccount.name}（${balance.settleAccount.settleNo}）`
          : v,
    },
  ];

  return (
    <Card
      title="预存管理"
      extra={
        <Space wrap>
          <CustomerSelect
            value={customerId}
            onChange={(v) => void onCustomer(v)}
            placeholder="按客户查"
          />
          <WaterAccountSearchSelect
            onSelect={(a) => {
              if (a) setSettleAccountId(a.settleAccountId);
            }}
            placeholder="按户号/地址/表号查"
          />
          {settleOpts.length > 1 ? (
            <Select
              style={{ width: 220 }}
              placeholder="选择结算户"
              value={settleAccountId}
              onChange={(v) => setSettleAccountId(v)}
              options={settleOpts}
              allowClear
            />
          ) : (
            <SettleAccountSelect
              value={settleAccountId}
              onChange={(v) => setSettleAccountId(v)}
              placeholder="按结算户查"
            />
          )}
          <Select
            style={{ width: 140 }}
            placeholder="流水类型"
            allowClear
            value={type}
            onChange={(v) => {
              setType(v);
              setPage(1);
            }}
            options={ENTRY_TYPE_OPTIONS}
          />
        </Space>
      }
    >
      {settleAccountId && balance ? (
        <Space size="large" style={{ marginBottom: 16 }}>
          <Statistic
            title={`预存余额（${balance.settleAccount.name} ${balance.settleAccount.settleNo}）`}
            value={fmtCent(balance.balance)}
          />
          <Statistic title="在账充值笔数" value={balance.lots.length} />
        </Space>
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="选择客户、用水户号或结算户后可查看预存余额；流水默认展示本租户全部预存记录。"
        />
      )}
      <Table<PrepaymentEntry>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={entries.items}
        columns={columns}
        pagination={{
          current: page,
          pageSize,
          total: entries.total,
          showSizeChanger: true,
          onChange: (p, size) => {
            setPage(p);
            setPageSize(size);
          },
        }}
      />
      <Typography.Text type="secondary">
        预存充值 / 退款在收费台办理；抵扣由开账后自动执行。
      </Typography.Text>
    </Card>
  );
}
