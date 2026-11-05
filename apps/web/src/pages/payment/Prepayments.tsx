import Select from '../../components/CopySelect';
import {Alert, App as AntdApp, Button, Card, Form, Input, InputNumber, Modal, Space, Statistic, Tag, Typography} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { useSearchParams } from 'react-router-dom';
import type {
  PrepaymentAccountRow,
  PrepaymentBalance,
  PrepaymentEntriesPage,
  PrepaymentEntry,
  WaterAccount,
} from '../../api/types';
import {
  enumLabel,
  fmtCent,
  fmtTime,
} from '../common';
import { PAY_CHANNEL_LABELS, PREPAY_ENTRY_COLORS, PREPAY_ENTRY_LABELS } from './common';
import {
  CustomerSelect,
  SettleAccountSelect,
  WaterAccountSearchSelect,
} from '../pickers';
import Table from '../../components/PageTable';


const ENTRY_TYPE_OPTIONS = [
  { value: 'TOP_UP', label: '预存充值' },
  { value: 'APPLY', label: '预存抵扣' },
  { value: 'REFUND', label: '预存退款' },
  { value: 'REVERSAL', label: '预存冲正' },
];

/**
 * 预存业务中心（v3-X10）：本页办理充值 / 退款 / 冲正（收款记录页）、
 * 查流水 / 查余额；X9 预存不足提醒：结算户总览警示列 + 低于阈值筛选 +
 * 户级阈值覆盖（租户默认规则见系统设置租户参数 prepay.warn.*）。
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
  const [searchParams] = useSearchParams();
  const [accounts, setAccounts] = useState<PrepaymentAccountRow[]>([]);
  const [lowOnly, setLowOnly] = useState(false);
  const [acctLoading, setAcctLoading] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [warnRow, setWarnRow] = useState<PrepaymentAccountRow | null>(null);
  const [topUpForm] = Form.useForm();
  const [refundForm] = Form.useForm();
  const [warnForm] = Form.useForm();

  // 收费台「预存业务」跳转直达：?settleAccountId= 预选结算户。
  useEffect(() => {
    const sid = searchParams.get('settleAccountId');
    if (sid) setSettleAccountId(sid);
  }, [searchParams]);

  // X9：结算户预存总览（余额/阈值/是否不足/关联档案号），支持仅看不足。
  const loadAccounts = useCallback(
    async (low: boolean) => {
      setAcctLoading(true);
      try {
        const res = await api.get<PrepaymentAccountRow[]>('/prepayments/accounts', {
          params: low ? { lowOnly: '1' } : {},
        });
        setAccounts(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setAcctLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    queueMicrotask(() => void loadAccounts(lowOnly));
  }, [loadAccounts, lowOnly]);

  const submitMoney = async (
    kind: 'top-ups' | 'refunds',
    values: { channel: string; amountYuan: number; reason?: string },
  ) => {
    try {
      await api.post(`/prepayments/${kind}`, {
        settleAccountId,
        channel: values.channel,
        amount: Math.round(values.amountYuan * 100),
        ...(values.reason ? { reason: values.reason } : {}),
      });
      message.success(kind === 'top-ups' ? '预存充值成功' : '预存退款成功');
      setTopUpOpen(false);
      setRefundOpen(false);
      void loadAccounts(lowOnly);
      if (settleAccountId) {
        const res = await api.get<PrepaymentBalance>('/prepayments/balance', {
          params: { settleAccountId },
        });
        setBalance(res.data);
      }
      void load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const submitWarn = async (values: { amountYuan?: number | null }) => {
    if (!warnRow) return;
    try {
      await api.patch(`/prepayments/accounts/${warnRow.settleAccount.id}/warn`, {
        amountCent:
          values.amountYuan === null || values.amountYuan === undefined
            ? null
            : Math.round(values.amountYuan * 100),
      });
      message.success('阈值已更新');
      setWarnRow(null);
      void loadAccounts(lowOnly);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

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
        <Tag color={PREPAY_ENTRY_COLORS[t]}>{enumLabel(PREPAY_ENTRY_LABELS, t)}</Tag>
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
      dataIndex: 'settleNo',
      width: 180,
      render: (_: string, r: PrepaymentEntry) =>
        r.settleNo
          ? `${r.settleName ?? ''}（${r.settleNo}）`
          : balance && r.settleAccountId === balance.settleAccount.id
            ? `${balance.settleAccount.name}（${balance.settleAccount.settleNo}）`
            : r.settleAccountId,
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
            placeholder="按用户档案号/地址/表号查"
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
                    showSearch
                    optionFilterProp="label"
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
          <Button
            type="primary"
            disabled={!settleAccountId}
            onClick={() => setTopUpOpen(true)}
          >
            预存充值
          </Button>
          <Button
            danger
            disabled={!settleAccountId || Number(balance?.balance ?? 0) <= 0}
            onClick={() => setRefundOpen(true)}
          >
            预存退款
          </Button>
        </Space>
      }
    >
      {/* X9：结算户预存总览 + 低余额警示/筛选 */}
      <Table<PrepaymentAccountRow>
        rowKey={(r) => r.settleAccount.id}
        size="small"
        loading={acctLoading}
        dataSource={accounts}
        style={{ marginBottom: 16 }}
        title={() => (
          <Space>
            <Typography.Text strong>结算户预存总览</Typography.Text>
            <Button
              size="small"
              type={lowOnly ? 'primary' : 'default'}
              onClick={() => setLowOnly(!lowOnly)}
            >
              {lowOnly ? '查看全部' : '仅看预存不足'}
            </Button>
          </Space>
        )}
        columns={[
          { title: '结算户', width: 200, render: (_: unknown, r: PrepaymentAccountRow) => `${r.settleAccount.name}（${r.settleAccount.settleNo}）` },
          { title: '关联档案号', render: (_: unknown, r: PrepaymentAccountRow) => r.accountNos.length ? r.accountNos.join('、') : '—' },
          { title: '预存余额', width: 120, align: 'right', render: (_: unknown, r: PrepaymentAccountRow) => fmtCent(r.balance) },
          { title: '上月水费', width: 110, align: 'right', render: (_: unknown, r: PrepaymentAccountRow) => r.warn.lastBillCent ? fmtCent(r.warn.lastBillCent) : '—' },
          { title: '提醒阈值', width: 110, align: 'right', render: (_: unknown, r: PrepaymentAccountRow) => fmtCent(r.warn.thresholdCent) },
          { title: '状态', width: 110, render: (_: unknown, r: PrepaymentAccountRow) => r.warn.lowBalance ? <Tag color="red">预存不足</Tag> : <Tag color="green">正常</Tag> },
          { title: '操作', width: 100, render: (_: unknown, r: PrepaymentAccountRow) => (
            <Button size="small" type="link" onClick={() => { setWarnRow(r); warnForm.setFieldsValue({ amountYuan: undefined }); }}>
              设阈值
            </Button>
          ) },
        ]}
        pagination={false}
        scroll={{ x: 'max-content' }}
      />
      {settleAccountId && balance ? (
        <Space size="large" style={{ marginBottom: 16 }}>
          <Statistic
            title={`预存余额（${balance.settleAccount.name} ${balance.settleAccount.settleNo}）`}
            value={fmtCent(balance.balance)}
          />
          <Statistic title="在账充值笔数" value={balance.lots.length} />
          {balance.warn ? (
            balance.warn.lowBalance ? (
              <Tag color="red" style={{ fontSize: 14, padding: '4px 10px' }}>
                预存不足（阈值 {fmtCent(balance.warn.thresholdCent)}）
              </Tag>
            ) : (
              <Tag color="green" style={{ fontSize: 14, padding: '4px 10px' }}>预存正常</Tag>
            )
          ) : null}
        </Space>
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="选择客户、用户档案号或结算户后可查看预存余额；流水默认展示本租户全部预存记录。"
        />
      )}
      <Table<PrepaymentEntry> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
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
        预存充值 / 退款在本页办理（复用收费资金语义：渠道、收据、幂等、并入收费员日结）；抵扣由开账后自动执行；冲正在收款记录页按权限操作。
      </Typography.Text>

      <Modal
        title="预存充值"
        open={topUpOpen}
        onCancel={() => setTopUpOpen(false)}
        onOk={() => topUpForm.submit()}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="充值资金先清欠费（按到期先后），余额存入预存；一笔资金一张收据，并入当日日结。"
        />
        <Form form={topUpForm} layout="vertical" onFinish={(v) => void submitMoney('top-ups', v)}>
          <Form.Item name="channel" label="收款渠道" rules={[{ required: true, message: '请选择渠道' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={Object.entries(PAY_CHANNEL_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item name="amountYuan" label="充值金额（元）" rules={[{ required: true, message: '请输入金额' }]}>
            <InputNumber min={0.01} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reason" label="备注">
            <Input placeholder="选填" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="预存退款"
        open={refundOpen}
        onCancel={() => setRefundOpen(false)}
        onOk={() => refundForm.submit()}
        destroyOnHidden
      >
        <Form form={refundForm} layout="vertical" onFinish={(v) => void submitMoney('refunds', v)}>
          <Form.Item name="channel" label="退款渠道" rules={[{ required: true, message: '请选择渠道' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={Object.entries(PAY_CHANNEL_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item name="amountYuan" label="退款金额（元）" rules={[{ required: true, message: '请输入金额' }]}>
            <InputNumber min={0.01} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reason" label="退款原因" rules={[{ required: true, message: '退款必须填写原因' }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`结算户阈值覆盖（${warnRow?.settleAccount.settleNo ?? ''}）`}
        open={!!warnRow}
        onCancel={() => setWarnRow(null)}
        onOk={() => warnForm.submit()}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="留空则回退租户默认规则（系统设置·租户参数 prepay.warn.*）。"
        />
        <Form form={warnForm} layout="vertical" onFinish={(v) => void submitWarn(v)}>
          <Form.Item name="amountYuan" label="固定金额阈值（元，留空=租户规则）">
            <InputNumber min={0} precision={2} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
