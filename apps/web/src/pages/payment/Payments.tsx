import {
  PrinterOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Input,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  PayChannel,
  Payment,
  PaymentAlloc,
  PaymentDetail,
  PaymentStatus,
  Receipt,
  Staff,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { fmtCent, fmtTime, newIdemKey } from '../common';
import { SettleAccountSelect, StaffSelect } from '../pickers';
import {
  PAY_CHANNEL_COLORS,
  PAY_CHANNEL_LABELS,
  PAYMENT_STATUS_COLORS,
  PAYMENT_STATUS_LABELS,
  PREPAY_ENTRY_COLORS,
  PREPAY_ENTRY_LABELS,
} from './common';

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const shortId = (id: string | null | undefined) =>
  id ? (
    <Tooltip title={id}>
      <span style={{ fontFamily: 'monospace' }}>{id.slice(0, 8)}…</span>
    </Tooltip>
  ) : (
    '—'
  );

/**
 * 收款记录（Payment）：列表 + 过滤 + 详情抽屉（分摊明细 + 收据）+
 * 红冲（append-only 负向 reversal）+ 收据打印。
 */
export default function Payments() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('payment:write');
  // E6：含预存腿的冲正可由 prepayment:reverse 触发（服务端按收款事实判定）。
  const canReverse = canWrite || hasPerm('prepayment:reverse');
  const canIamRead = hasPerm('iam:read');
  const canCustomerRead = hasPerm('customer:read');

  const [rows, setRows] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(false);
  const [settleAccountId, setSettleAccountId] = useState<string | undefined>(undefined);
  const [settleIdInput, setSettleIdInput] = useState('');
  const [cashierId, setCashierId] = useState<string | undefined>(undefined);
  const [cashierIdInput, setCashierIdInput] = useState('');
  const [status, setStatus] = useState<PaymentStatus | undefined>(undefined);
  const [channel, setChannel] = useState<PayChannel | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [staff, setStaff] = useState<Staff[]>([]);

  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  const effectiveSettleId = canCustomerRead
    ? settleAccountId
    : UUID_RE.test(settleIdInput.trim())
      ? settleIdInput.trim()
      : undefined;
  const effectiveCashierId = canIamRead
    ? cashierId
    : UUID_RE.test(cashierIdInput.trim())
      ? cashierIdInput.trim()
      : undefined;

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<Payment[]>('/payments', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(effectiveSettleId ? { settleAccountId: effectiveSettleId } : {}),
            ...(effectiveCashierId ? { cashierId: effectiveCashierId } : {}),
            ...(status ? { status } : {}),
            ...(channel ? { channel } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [channel, effectiveCashierId, effectiveSettleId, message, status],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  // 收款员姓名展示 —— 仅 iam:read 可拉取；否则退化为短 id。
  useEffect(() => {
    if (!canIamRead) return;
    api
      .get<Staff[]>('/iam/staff')
      .then((res) => setStaff(res.data))
      .catch(() => setStaff([]));
  }, [canIamRead]);

  const staffName = useCallback(
    (id: string) => {
      const s = staff.find((x) => x.id === id);
      return s ? `${s.name}（${s.login}）` : `${id.slice(0, 8)}…`;
    },
    [staff],
  );

  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const detailSeq = useRef(0);

  const openDetail = async (row: Payment) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api.get<PaymentDetail>(`/payments/${row.id}`);
      if (seq === detailSeq.current) setDetail(res.data);
    } catch (err) {
      if (seq === detailSeq.current) message.error(apiErrorText(err));
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  };

  /**
   * 红冲（append-only）：原单状态不变（RECEIVED/DAY_CLOSED 保留，
   * +/− 对儿在日结内互抵），追加一条负额 reversal 收款计入下次日结；
   * 原收据作废。reversalOfId 非空的红冲单自身不能再冲。
   */
  const reverse = async (p: Payment) => {
    setActing(p.id);
    try {
      const res = await api.post<PaymentDetail>(
        `/payments/${p.id}/reverse`,
        {},
        { headers: { 'Idempotency-Key': newIdemKey() } },
      );
      message.success(
        `已红冲：生成负向收款 ${res.data.paymentNo}（${fmtCent(res.data.amount)}），原收据作废`,
      );
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setActing(null);
      await load(page, pageSize);
      if (detail?.id === p.id) void openDetail(p);
    }
  };

  const print = async (receipt: Receipt) => {
    setPrinting(true);
    try {
      const res = await api.post<Receipt>(`/receipts/${receipt.id}/print`, {});
      message.success(`收据 ${res.data.receiptNo} 已打印`);
      if (detail) {
        setDetail({ ...detail, receipt: res.data });
      }
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setPrinting(false);
    }
  };

  const allocColumns: ColumnsType<PaymentAlloc> = [
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 80,
      render: (s: PaymentAlloc['source']) =>
        s === 'PREPAYMENT' ? <Tag color="blue">预存</Tag> : <Tag>现金</Tag>,
    },
    {
      title: '账单 ID',
      dataIndex: 'billId',
      key: 'billId',
      render: shortId,
    },
    {
      title: '分摊金额',
      dataIndex: 'amount',
      key: 'amount',
      width: 120,
      align: 'right',
      render: (v: string) => fmtCent(v),
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 165,
      render: fmtTime,
    },
  ];

  const columns: ColumnsType<Payment> = [
    { title: '收款单号', dataIndex: 'paymentNo', key: 'paymentNo', width: 170 },
    {
      title: '结算户',
      dataIndex: 'settleAccountId',
      key: 'settleAccountId',
      width: 110,
      render: shortId,
    },
    {
      title: '收费员',
      dataIndex: 'cashierId',
      key: 'cashierId',
      width: 140,
      render: staffName,
    },
    {
      title: '渠道',
      dataIndex: 'channel',
      key: 'channel',
      width: 100,
      render: (c: PayChannel) => (
        <Tag color={PAY_CHANNEL_COLORS[c]}>{PAY_CHANNEL_LABELS[c]}</Tag>
      ),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      width: 110,
      align: 'right',
      render: (v: string, r: Payment) => (
        <span style={r.reversalOfId ? { color: '#cf1322' } : undefined}>
          {fmtCent(v)}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (s: PaymentStatus, r: Payment) => (
        <Space size={4}>
          <Tag color={PAYMENT_STATUS_COLORS[s]}>{PAYMENT_STATUS_LABELS[s]}</Tag>
          {r.reversalOfId && <Tag color="red">红冲单</Tag>}
        </Space>
      ),
    },
    {
      title: '收款时间',
      dataIndex: 'receivedAt',
      key: 'receivedAt',
      width: 165,
      render: fmtTime,
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_: unknown, record: Payment) => (
        <Space size={4} wrap>
          <Button size="small" icon={<SearchOutlined />} onClick={() => void openDetail(record)}>
            详情
          </Button>
          {canReverse && record.reversalOfId === null && (
            <Popconfirm
              title={`红冲收款 ${fmtCent(record.amount)}？`}
              description="追加一条负额收款（原单状态不变、原收据作废），相关账单欠费恢复。"
              okText="红冲"
              okButtonProps={{ danger: true, loading: acting === record.id }}
              cancelText="取消"
              onConfirm={() => void reverse(record)}
            >
              <Button size="small" danger loading={acting === record.id}>
                红冲
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const receipt = detail?.receipt;

  return (
    <Card
      title="收款记录"
      extra={
        <Space wrap>
          {canCustomerRead ? (
            <span style={{ width: 200, display: 'inline-block' }}>
              <SettleAccountSelect
                value={settleAccountId}
                onChange={(v) => {
                  setSettleAccountId(v);
                  setPage(1);
                }}
                placeholder="按结算户过滤"
              />
            </span>
          ) : (
            <Input.Search
              allowClear
              placeholder="按结算户 ID 过滤"
              style={{ width: 220 }}
              value={settleIdInput}
              onChange={(e) => setSettleIdInput(e.target.value)}
              onSearch={() => setPage(1)}
            />
          )}
          {canIamRead ? (
            <span style={{ width: 190, display: 'inline-block' }}>
              <StaffSelect
                value={cashierId}
                onChange={(v) => {
                  setCashierId(v);
                  setPage(1);
                }}
                placeholder="按收费员过滤"
              />
            </span>
          ) : (
            <Input.Search
              allowClear
              placeholder="按收费员 ID 过滤"
              style={{ width: 220 }}
              value={cashierIdInput}
              onChange={(e) => setCashierIdInput(e.target.value)}
              onSearch={() => setPage(1)}
            />
          )}
          <Select
            allowClear
            placeholder="渠道"
            style={{ width: 120 }}
            options={(['CASH', 'POS', 'TRANSFER'] as const).map((c) => ({
              value: c,
              label: PAY_CHANNEL_LABELS[c],
            }))}
            value={channel}
            onChange={(v) => {
              setChannel(v);
              setPage(1);
            }}
          />
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 110 }}
            // REVERSED 是保留态（无迁移路径，红冲以负额新单表达），不提供过滤。
            options={(['RECEIVED', 'DAY_CLOSED'] as const).map((s) => ({
              value: s,
              label: PAYMENT_STATUS_LABELS[s],
            }))}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(page, pageSize)}>
            刷新
          </Button>
        </Space>
      }
    >
      <Table<Payment>
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          onChange: (p, size) => {
            setPage(p);
            setPageSize(size);
          },
        }}
      />

      {/* 收款详情抽屉 */}
      <Drawer
        open={detail !== null || detailLoading}
        width={640}
        title={detail ? `收款详情 — ${detail.paymentNo}` : '收款详情'}
        onClose={() => setDetail(null)}
      >
        {detailLoading || !detail ? (
          <Spin />
        ) : (
          <>
            <Descriptions
              bordered
              size="small"
              column={2}
              items={[
                { key: 'no', label: '收款单号', children: detail.paymentNo },
                {
                  key: 'status',
                  label: '状态',
                  children: (
                    <Tag color={PAYMENT_STATUS_COLORS[detail.status]}>
                      {PAYMENT_STATUS_LABELS[detail.status]}
                    </Tag>
                  ),
                },
                { key: 'sa', label: '结算户', children: shortId(detail.settleAccountId) },
                {
                  key: 'cashier',
                  label: '收费员',
                  children: staffName(detail.cashierId),
                },
                {
                  key: 'channel',
                  label: '渠道',
                  children: (
                    <Tag color={PAY_CHANNEL_COLORS[detail.channel]}>
                      {PAY_CHANNEL_LABELS[detail.channel]}
                    </Tag>
                  ),
                },
                {
                  key: 'amount',
                  label: '金额',
                  children: <b>{fmtCent(detail.amount)}</b>,
                },
                {
                  key: 'reversalOf',
                  label: '红冲对象',
                  children: detail.reversalOfId ? shortId(detail.reversalOfId) : '—',
                },
                {
                  key: 'dayClose',
                  label: '日结单',
                  children: shortId(detail.dayCloseId),
                },
                {
                  key: 'receivedAt',
                  label: '收款时间',
                  children: fmtTime(detail.receivedAt),
                },
                {
                  key: 'created',
                  label: '创建时间',
                  children: fmtTime(detail.createdAt),
                },
              ]}
            />
            <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>分摊明细</div>
            <Table<PaymentAlloc>
              rowKey="id"
              size="small"
              columns={allocColumns}
              dataSource={detail.allocs}
              pagination={false}
              locale={{ emptyText: '无分摊明细' }}
            />
            {(detail.prepaymentEntries?.length ?? 0) > 0 && (
              <>
                <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>
                  预存流水（本笔资金用途）
                </div>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={detail.prepaymentEntries}
                  pagination={false}
                  columns={[
                    {
                      title: '类型',
                      dataIndex: 'type',
                      width: 100,
                      render: (t: string) => (
                        <Tag color={PREPAY_ENTRY_COLORS[t as keyof typeof PREPAY_ENTRY_COLORS]}>
                          {PREPAY_ENTRY_LABELS[t as keyof typeof PREPAY_ENTRY_LABELS]}
                        </Tag>
                      ),
                    },
                    {
                      title: '金额',
                      dataIndex: 'amount',
                      width: 120,
                      align: 'right',
                      render: (v: string) => fmtCent(v),
                    },
                    {
                      title: '批次/关联',
                      key: 'ref',
                      render: (_: unknown, e: (typeof detail.prepaymentEntries)[number]) => (
                        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {e.originTopUpId ? `批次 ${e.originTopUpId.slice(0, 8)}… ` : ''}
                          {e.reason ?? ''}
                        </span>
                      ),
                    },
                  ]}
                />
              </>
            )}
            <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>收据</div>
            {receipt ? (
              <Descriptions
                bordered
                size="small"
                column={2}
                items={[
                  { key: 'no', label: '收据号', children: receipt.receiptNo },
                  {
                    key: 'flag',
                    label: '状态',
                    children: (
                      <Tag color={receipt.voidFlag ? 'default' : 'green'}>
                        {receipt.voidFlag ? '已作废' : '有效'}
                      </Tag>
                    ),
                  },
                  {
                    key: 'printedAt',
                    label: '打印时间',
                    children: receipt.printedAt ? fmtTime(receipt.printedAt) : '未打印',
                  },
                ]}
              />
            ) : (
              <Tag>无收据（红冲收款不开发票）</Tag>
            )}
            {canReverse && (
              <Space style={{ marginTop: 16 }}>
                {receipt && !receipt.voidFlag && canWrite && (
                  <Button
                    icon={<PrinterOutlined />}
                    loading={printing}
                    onClick={() => void print(receipt)}
                  >
                    打印票据
                  </Button>
                )}
                {/* 已被红冲过的原单：收据已作废，不再提供重复红冲入口。 */}
                {detail.reversalOfId === null && !(receipt && receipt.voidFlag) && (
                  <Popconfirm
                    title="红冲该收款？"
                    description="追加一条负额收款（原单状态不变、原收据作废），相关账单欠费恢复。"
                    okText="红冲"
                    okButtonProps={{ danger: true, loading: acting === detail.id }}
                    cancelText="取消"
                    onConfirm={() => void reverse(detail)}
                  >
                    <Button danger loading={acting === detail.id}>
                      红冲
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            )}
          </>
        )}
      </Drawer>
    </Card>
  );
}
