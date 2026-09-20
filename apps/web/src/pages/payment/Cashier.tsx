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
  Form,
  Input,
  InputNumber,
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
  Receipt,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { fmtCent, fmtPeriod, newIdemKey } from '../common';
import { CustomerSelect, WaterAccountSelect } from '../pickers';
import { BILL_KIND_COLORS, BILL_KIND_LABELS } from '../billing/common';
import { PAY_CHANNEL_LABELS } from './common';

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
              title="结算户"
              value={outstanding.settleAccountId.slice(0, 8) + '…'}
              valueStyle={{ fontSize: 16, fontFamily: 'monospace' }}
            />
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
    </Card>
  );
}
