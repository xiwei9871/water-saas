import {
  ClearOutlined,
  PayCircleOutlined,
  PrinterOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  AccountOutstanding,
  OutstandingItem,
  PayChannel,
  PaymentDetail,
  PrepaymentEntriesPage,
  PrepaymentEntry,
  Receipt,
  RefundResult,
  TopUpResult,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { fmtCent, fmtPeriod, newIdemKey } from '../common';
import { CustomerSelect, WaterAccountSelect } from '../pickers';
import { BILL_KIND_COLORS, BILL_KIND_LABELS } from '../billing/common';
import { PAY_CHANNEL_LABELS, PREPAY_ENTRY_COLORS, PREPAY_ENTRY_LABELS } from './common';

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 元（最多 2 位小数）→ 整数分；非法输入返回 null。 */
const yuanToCent = (v: number | null | undefined): number | null =>
  v === null || v === undefined || Number.isNaN(v) || v < 0
    ? null
    : Math.round(v * 100);

const centToYuan = (cent: string): number => Number(cent) / 100;

/**
 * 收费台：选水表户 → 查欠费（outstanding 探针）→ 按账单分摊 →
 * 提交收款（幂等键随表单打开生成）→ 打印收据。
 * amount = 整数分 = Σ 分摊（服务端同样强校验 PAYMENT_ALLOC_MISMATCH）。
 */
export default function Cashier() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('payment:write');
  const canPrepayReverse = hasPerm('prepayment:reverse');
  const canCustomerRead = hasPerm('customer:read');

  const [customerId, setCustomerId] = useState<string | undefined>(undefined);
  const [waterAccountId, setWaterAccountId] = useState<string | undefined>(undefined);
  const [accountIdInput, setAccountIdInput] = useState('');

  const [outstanding, setOutstanding] = useState<AccountOutstanding | null>(null);
  const [loading, setLoading] = useState(false);

  /** billId → 分摊金额（元，InputNumber 数值）。 */
  const [allocs, setAllocs] = useState<Record<string, number | null>>({});
  const [channel, setChannel] = useState<PayChannel>('CASH');
  const [receivedTotal, setReceivedTotal] = useState<number | null>(null);

  const [idemKey, setIdemKey] = useState('');
  const [paying, setPaying] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [lastPayment, setLastPayment] = useState<PaymentDetail | null>(null);

  // E6 预存：充值 / 退款 / 流水。
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState<number | null>(null);
  const [topUpChannel, setTopUpChannel] = useState<PayChannel>('CASH');
  const [topUpKey, setTopUpKey] = useState('');
  const [topUpBusy, setTopUpBusy] = useState(false);

  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState<number | null>(null);
  const [refundChannel, setRefundChannel] = useState<PayChannel>('CASH');
  const [refundReason, setRefundReason] = useState('');
  const [refundKey, setRefundKey] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);

  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ledger, setLedger] = useState<PrepaymentEntry[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  const fetchSeq = useRef(0);

  const effectiveAccountId = canCustomerRead
    ? waterAccountId
    : UUID_RE.test(accountIdInput.trim())
      ? accountIdInput.trim()
      : undefined;

  const loadOutstanding = useCallback(
    async (accountId: string) => {
      const seq = ++fetchSeq.current;
      setLoading(true);
      try {
        const res = await api.get<AccountOutstanding>(
          `/water-accounts/${accountId}/outstanding`,
        );
        if (seq !== fetchSeq.current) return;
        setOutstanding(res.data);
        // 默认每张可缴账单全额分摊 —— 柜台最常见动作；可逐行改。
        const fill: Record<string, number> = {};
        for (const it of res.data.items) {
          fill[it.billId] = centToYuan(it.outstanding);
        }
        setAllocs(fill);
        setReceivedTotal(
          res.data.items.reduce((s, i) => s + centToYuan(i.outstanding), 0),
        );
        setLastPayment(null);
        setIdemKey(newIdemKey()); // 每次查欠费 = 新一轮收款表单
      } catch (err) {
        if (seq !== fetchSeq.current) return;
        setOutstanding(null);
        setAllocs({});
        message.error(apiErrorText(err));
      } finally {
        if (seq === fetchSeq.current) setLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    if (effectiveAccountId) {
      queueMicrotask(() => void loadOutstanding(effectiveAccountId));
    } else {
      queueMicrotask(() => {
        fetchSeq.current += 1; // 作废旧请求
        setOutstanding(null);
        setAllocs({});
        setLastPayment(null);
      });
    }
  }, [effectiveAccountId, loadOutstanding]);

  const items = useMemo(() => outstanding?.items ?? [], [outstanding]);

  /** 分摊合计（分）。 */
  const allocSumCent = useMemo(
    () =>
      items.reduce((s, it) => {
        const c = yuanToCent(allocs[it.billId]);
        return s + (c ?? 0);
      }, 0),
    [allocs, items],
  );

  const allocValidation = useMemo(() => {
    for (const it of items) {
      const c = yuanToCent(allocs[it.billId]);
      if (c !== null && c > 0 && c > Number(it.outstanding)) {
        return `账单 ${fmtPeriod(it.period)} 分摊金额超出欠费余额 ${fmtCent(it.outstanding)}`;
      }
    }
    return null;
  }, [allocs, items]);

  const payableAllocs = useMemo(
    () =>
      items
        .map((it) => ({ billId: it.billId, cent: yuanToCent(allocs[it.billId]) }))
        .filter((a): a is { billId: string; cent: number } => a.cent !== null && a.cent > 0),
    [allocs, items],
  );

  /** 自动分摊：按账期从老到新，把收款总额依次填满欠费。 */
  const autoAllocate = () => {
    const total = yuanToCent(receivedTotal);
    if (total === null || total <= 0) {
      message.warning('请先输入收款总额');
      return;
    }
    let rest = total;
    const next: Record<string, number | null> = {};
    for (const it of items) {
      const out = Number(it.outstanding);
      const take = Math.min(rest, out);
      next[it.billId] = take > 0 ? take / 100 : null;
      rest -= take;
    }
    setAllocs(next);
  };

  const clearAllocs = () => {
    setAllocs({});
  };

  const submit = async () => {
    if (!outstanding) return;
    if (payableAllocs.length === 0) {
      message.warning('请至少为一张账单填写分摊金额');
      return;
    }
    if (allocValidation) {
      message.error(allocValidation);
      return;
    }
    if (allocSumCent <= 0) {
      message.warning('收款金额需大于 0');
      return;
    }
    setPaying(true);
    try {
      const res = await api.post<PaymentDetail>(
        '/payments',
        {
          settleAccountId: outstanding.settleAccountId,
          channel,
          // 整数分 —— assertCents 接受 number 或数字字符串，统一发字符串。
          amount: String(allocSumCent),
          allocs: payableAllocs.map((a) => ({
            billId: a.billId,
            amount: String(a.cent),
          })),
        },
        { headers: { 'Idempotency-Key': idemKey } },
      );
      message.success(
        `收款成功 ${fmtCent(res.data.amount)}（${res.data.paymentNo}）`,
      );
      // 先刷新欠费（会把分摊重置为剩余欠费并换发幂等键），再展示本次票据。
      await loadOutstanding(outstanding.waterAccountId);
      setLastPayment(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setPaying(false);
    }
  };

  const openTopUp = () => {
    setTopUpAmount(null);
    setTopUpChannel('CASH');
    setTopUpKey(newIdemKey());
    setTopUpOpen(true);
  };

  const submitTopUp = async () => {
    if (!outstanding) return;
    const cent = yuanToCent(topUpAmount);
    if (cent === null || cent <= 0) {
      message.warning('请输入充值金额');
      return;
    }
    setTopUpBusy(true);
    try {
      const res = await api.post<TopUpResult>(
        '/prepayments/top-ups',
        {
          settleAccountId: outstanding.settleAccountId,
          channel: topUpChannel,
          amount: String(cent),
        },
        { headers: { 'Idempotency-Key': topUpKey } },
      );
      const cleared = res.data.billAllocs.reduce((s, a) => s + Number(a.amount), 0);
      message.success(
        `收款成功 ${fmtCent(res.data.payment.amount)}：清欠 ${fmtCent(cleared)}，预存 ${fmtCent(res.data.topUp)}`,
      );
      setTopUpOpen(false);
      await loadOutstanding(outstanding.waterAccountId);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setTopUpBusy(false);
    }
  };

  const openRefund = () => {
    setRefundAmount(null);
    setRefundChannel('CASH');
    setRefundReason('');
    setRefundKey(newIdemKey());
    setRefundOpen(true);
  };

  const submitRefund = async () => {
    if (!outstanding) return;
    const cent = yuanToCent(refundAmount);
    if (cent === null || cent <= 0) {
      message.warning('请输入退款金额');
      return;
    }
    if (!refundReason.trim()) {
      message.warning('请填写退款原因');
      return;
    }
    setRefundBusy(true);
    try {
      const res = await api.post<RefundResult>(
        '/prepayments/refunds',
        {
          settleAccountId: outstanding.settleAccountId,
          channel: refundChannel,
          amount: String(cent),
          reason: refundReason.trim(),
        },
        { headers: { 'Idempotency-Key': refundKey } },
      );
      message.success(`退款完成 ${fmtCent(res.data.payment.amount)}，余额 ${fmtCent(res.data.balance)}`);
      setRefundOpen(false);
      await loadOutstanding(outstanding.waterAccountId);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setRefundBusy(false);
    }
  };

  const loadLedger = useCallback(
    async (settleAccountId: string, page = 1) => {
      setLedgerLoading(true);
      try {
        const res = await api.get<PrepaymentEntriesPage>(
          `/prepayments/entries?settleAccountId=${settleAccountId}&take=50&skip=${(page - 1) * 50}`,
        );
        setLedger(res.data.items);
        setLedgerTotal(res.data.total);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLedgerLoading(false);
      }
    },
    [message],
  );

  const print = async (receipt: Receipt | null | undefined) => {
    if (!receipt) return;
    setPrinting(true);
    try {
      const res = await api.post<Receipt>(`/receipts/${receipt.id}/print`, {});
      message.success(`收据 ${res.data.receiptNo} 已打印`);
      if (lastPayment) {
        setLastPayment({ ...lastPayment, receipt: res.data });
      }
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setPrinting(false);
    }
  };

  const columns: ColumnsType<OutstandingItem> = [
    { title: '账期', dataIndex: 'period', key: 'period', width: 90, render: fmtPeriod },
    {
      title: '类型',
      dataIndex: 'billKind',
      key: 'billKind',
      width: 95,
      render: (k: OutstandingItem['billKind']) => (
        <Tag color={BILL_KIND_COLORS[k]}>{BILL_KIND_LABELS[k]}</Tag>
      ),
    },
    {
      title: '账单金额',
      dataIndex: 'totalAmount',
      key: 'totalAmount',
      width: 110,
      align: 'right',
      render: fmtCent,
    },
    {
      title: '已缴',
      dataIndex: 'paidAmount',
      key: 'paidAmount',
      width: 110,
      align: 'right',
      render: fmtCent,
    },
    {
      title: '欠费',
      dataIndex: 'outstanding',
      key: 'outstanding',
      width: 110,
      align: 'right',
      render: (v: string) => <b>{fmtCent(v)}</b>,
    },
    {
      title: '本次分摊（元）',
      key: 'alloc',
      width: 150,
      render: (_: unknown, it: OutstandingItem) => (
        <InputNumber
          size="small"
          min={0}
          precision={2}
          style={{ width: 130 }}
          placeholder={`≤ ${centToYuan(it.outstanding).toFixed(2)}`}
          value={allocs[it.billId]}
          onChange={(v) =>
            setAllocs((prev) => ({ ...prev, [it.billId]: v }))
          }
          disabled={!canWrite}
        />
      ),
    },
  ];

  const receipt = lastPayment?.receipt;

  return (
    <Card title="收费台">
      <Space wrap style={{ marginBottom: 16 }}>
        {canCustomerRead ? (
          <>
            <span className="cashier-picker" style={{ width: 220, display: 'inline-block' }}>
              <CustomerSelect
                value={customerId}
                onChange={(v) => {
                  setCustomerId(v);
                  setWaterAccountId(undefined);
                }}
                placeholder="先选客户"
              />
            </span>
            <span className="cashier-picker" style={{ width: 280, display: 'inline-block' }}>
              <WaterAccountSelect
                customerId={customerId}
                value={waterAccountId}
                onChange={(v) => setWaterAccountId(v)}
                placeholder="再选水表户"
              />
            </span>
          </>
        ) : (
          <Input.Search
            allowClear
            placeholder="水表户 ID（uuid）"
            style={{ width: 320 }}
            value={accountIdInput}
            onChange={(e) => setAccountIdInput(e.target.value)}
            onSearch={() => void 0}
          />
        )}
        {outstanding && (
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void loadOutstanding(outstanding.waterAccountId)}
          >
            刷新欠费
          </Button>
        )}
      </Space>

      {loading && <Alert type="info" showIcon message="正在查询欠费…" />}

      {!loading && outstanding && (
        <>
          <Space size="large" wrap style={{ marginBottom: 12 }}>
            <Statistic
              title="合计欠费（净额）"
              value={Number(outstanding.totalOutstanding) / 100}
              precision={2}
              prefix="¥"
              valueStyle={{
                color:
                  Number(outstanding.totalOutstanding) > 0 ? '#cf1322' : '#3f8600',
              }}
            />
            <Statistic
              title="预存余额"
              value={Number(outstanding.prepaymentBalance ?? 0) / 100}
              precision={2}
              prefix="¥"
              valueStyle={{
                color: Number(outstanding.prepaymentBalance ?? 0) > 0 ? '#1677ff' : undefined,
              }}
            />
            <Statistic
              title="结算户"
              value={outstanding.settleAccountId.slice(0, 8) + '…'}
              valueStyle={{ fontSize: 16, fontFamily: 'monospace' }}
            />
            <Space>
              {canWrite && (
                <Button onClick={openTopUp}>预存充值</Button>
              )}
              {canPrepayReverse && Number(outstanding.prepaymentBalance ?? 0) > 0 && (
                <Button danger onClick={openRefund}>
                  预存退款
                </Button>
              )}
              <Button
                onClick={() => {
                  setLedgerOpen(true);
                  void loadLedger(outstanding.settleAccountId);
                }}
              >
                预存流水
              </Button>
            </Space>
          </Space>
          {Number(outstanding.reversedBillCredit) > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={`该结算户有 ${fmtCent(outstanding.reversedBillCredit)} 已缴后被红冲的余额（多收退款）—— 应通过收款红冲退回，不要再收。`}
            />
          )}
          {items.length === 0 ? (
            <Alert type="success" showIcon message="该户无欠费账单" />
          ) : (
            <Table<OutstandingItem>
              rowKey="billId"
              size="small"
              columns={columns}
              dataSource={items}
              pagination={false}
            />
          )}

          {items.length > 0 && (
            <Card size="small" style={{ marginTop: 16 }} title="收款分摊">
              <Form layout="inline" style={{ rowGap: 8 }}>
                <Form.Item label="自动分摊总额（元）">
                  <InputNumber
                    min={0}
                    precision={2}
                    style={{ width: 140 }}
                    value={receivedTotal}
                    onChange={(v) => setReceivedTotal(v)}
                    disabled={!canWrite}
                  />
                </Form.Item>
                <Form.Item>
                  <Tooltip title="按账期从老到新依次填满欠费">
                    <Button onClick={autoAllocate} disabled={!canWrite}>
                      自动分摊
                    </Button>
                  </Tooltip>
                </Form.Item>
                <Form.Item>
                  <Button icon={<ClearOutlined />} onClick={clearAllocs} disabled={!canWrite}>
                    清空分摊
                  </Button>
                </Form.Item>
                <Form.Item label="收款渠道">
                  <Select
                    style={{ width: 120 }}
                    value={channel}
                    onChange={setChannel}
                    disabled={!canWrite}
                    options={(['CASH', 'POS', 'TRANSFER'] as const).map((c) => ({
                      value: c,
                      label: PAY_CHANNEL_LABELS[c],
                    }))}
                  />
                </Form.Item>
                <Form.Item label="分摊合计">
                  <b style={{ color: allocValidation ? '#cf1322' : undefined }}>
                    {fmtCent(allocSumCent)}
                  </b>
                </Form.Item>
                <Form.Item>
                  {canWrite && (
                    <Button
                      type="primary"
                      icon={<PayCircleOutlined />}
                      loading={paying}
                      disabled={payableAllocs.length === 0 || !!allocValidation}
                      onClick={() => void submit()}
                    >
                      收款 {fmtCent(allocSumCent)}
                    </Button>
                  )}
                </Form.Item>
              </Form>
              {allocValidation && (
                <Alert type="error" showIcon style={{ marginTop: 8 }} message={allocValidation} />
              )}
            </Card>
          )}
        </>
      )}

      {lastPayment && (
        <Alert
          type="success"
          showIcon
          style={{ marginTop: 16 }}
          message={`收款完成：${lastPayment.paymentNo} · ${fmtCent(lastPayment.amount)} · ${PAY_CHANNEL_LABELS[lastPayment.channel]}`}
          description={
            <Space direction="vertical" size={4}>
              <Descriptions
                size="small"
                column={1}
                items={[
                  {
                    key: 'r',
                    label: '收据号',
                    children: receipt ? (
                      <Space>
                        <span>{receipt.receiptNo}</span>
                        <Tag color={receipt.voidFlag ? 'default' : 'green'}>
                          {receipt.voidFlag ? '已作废' : receipt.printedAt ? '已打印' : '未打印'}
                        </Tag>
                      </Space>
                    ) : (
                      '—'
                    ),
                  },
                ]}
              />
              {canWrite && receipt && !receipt.voidFlag && (
                <Button
                  size="small"
                  icon={<PrinterOutlined />}
                  loading={printing}
                  onClick={() => void print(receipt)}
                >
                  打印票据
                </Button>
              )}
            </Space>
          }
        />
      )}

      <Modal
        title="预存充值"
        open={topUpOpen}
        onCancel={() => setTopUpOpen(false)}
        onOk={() => void submitTopUp()}
        confirmLoading={topUpBusy}
        okText="确认收款"
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="收款先清欠费（按到期先后），余额自动存入预存。一次收款 = 一笔资金 + 一张收据。"
        />
        <Form layout="vertical">
          <Form.Item label="收款金额（元）" required>
            <InputNumber
              min={0}
              precision={2}
              style={{ width: 200 }}
              value={topUpAmount}
              onChange={(v) => setTopUpAmount(v)}
              autoFocus
            />
          </Form.Item>
          <Form.Item label="收款渠道" required>
            <Select
              style={{ width: 200 }}
              value={topUpChannel}
              onChange={setTopUpChannel}
              options={(['CASH', 'POS', 'TRANSFER'] as const).map((c) => ({
                value: c,
                label: PAY_CHANNEL_LABELS[c],
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="预存退款"
        open={refundOpen}
        onCancel={() => setRefundOpen(false)}
        onOk={() => void submitRefund()}
        confirmLoading={refundBusy}
        okText="确认退款"
        okButtonProps={{ danger: true }}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`当前预存余额 ${outstanding ? fmtCent(outstanding.prepaymentBalance ?? '0') : '—'}。退款按充值批次 FIFO 拆行，产生一笔负收款进入当日日结。`}
        />
        <Form layout="vertical">
          <Form.Item label="退款金额（元）" required>
            <InputNumber
              min={0}
              precision={2}
              style={{ width: 200 }}
              value={refundAmount}
              onChange={(v) => setRefundAmount(v)}
              autoFocus
            />
          </Form.Item>
          <Form.Item label="退款渠道" required>
            <Select
              style={{ width: 200 }}
              value={refundChannel}
              onChange={setRefundChannel}
              options={(['CASH', 'POS', 'TRANSFER'] as const).map((c) => ({
                value: c,
                label: PAY_CHANNEL_LABELS[c],
              }))}
            />
          </Form.Item>
          <Form.Item label="退款原因" required>
            <Input
              style={{ width: 320 }}
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              maxLength={200}
              placeholder="必填 —— 写入流水 reason"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title="预存流水（append-only）"
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        width={720}
      >
        <Table<PrepaymentEntry>
          rowKey="id"
          size="small"
          loading={ledgerLoading}
          dataSource={ledger}
          pagination={{
            total: ledgerTotal,
            pageSize: 50,
            showSizeChanger: false,
            onChange: (p) =>
              outstanding && void loadLedger(outstanding.settleAccountId, p),
          }}
          columns={[
            {
              title: '时间',
              dataIndex: 'createdAt',
              width: 170,
              render: (v: string) => new Date(v).toLocaleString(),
            },
            {
              title: '类型',
              dataIndex: 'type',
              width: 100,
              render: (t: PrepaymentEntry['type']) => (
                <Tag color={PREPAY_ENTRY_COLORS[t]}>{PREPAY_ENTRY_LABELS[t]}</Tag>
              ),
            },
            {
              title: '金额',
              dataIndex: 'amount',
              width: 120,
              align: 'right',
              render: fmtCent,
            },
            {
              title: '批次/关联',
              key: 'ref',
              render: (_: unknown, e: PrepaymentEntry) => (
                <Space size={4} direction="vertical">
                  {e.originTopUpId && (
                    <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      批次 {e.originTopUpId.slice(0, 8)}…
                    </span>
                  )}
                  {e.reversalOfEntryId && (
                    <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      冲正 {e.reversalOfEntryId.slice(0, 8)}…
                    </span>
                  )}
                  {e.reason && <span style={{ fontSize: 12 }}>{e.reason}</span>}
                </Space>
              ),
            },
          ]}
        />
      </Drawer>
    </Card>
  );
}
