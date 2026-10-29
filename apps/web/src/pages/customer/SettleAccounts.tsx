import Select from '../../components/CopySelect';
import {
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {App as AntdApp, Button, Card, Descriptions, Drawer, Form, Input, InputNumber, Modal, Space, Spin, Tag, Typography} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FocusTaskBar, useFocusList } from '../../components/TaskFocus';
import { api, fetchAll, apiErrorText } from '../../api/client';
import type {
  AccountStatus,
  PayChannel,
  PrepaymentBalance,
  PrepaymentEntriesPage,
  SettleAccount,
  SettleAccountDetail,
  WaterAccountRef,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  enumLabel,
  ACCOUNT_STATUS_LABELS,
  cleanBody,
  cleanPatch,
  fmtCent,
  fmtTime,
  newIdemKey,
  USAGE_CATEGORY_LABELS,
} from '../common';
import { PAY_CHANNEL_LABELS, PREPAY_ENTRY_COLORS, PREPAY_ENTRY_LABELS } from '../payment/common';
import { AccountStatusTag } from '../pickers';
import Table from '../../components/PageTable';


interface SettleFormValues {
  settleNo?: string;
  name: string;
  phone?: string;
  status?: AccountStatus;
}

const STATUS_OPTIONS = (['NORMAL', 'SUSPENDED', 'CLOSED'] as const).map((s) => ({
  value: s,
  label: enumLabel(ACCOUNT_STATUS_LABELS, s),
}));

/** 结算户：列表 + 名称/状态过滤 + 新建/编辑（含 NORMAL↔SUSPENDED）+ 详情抽屉。 */
export default function SettleAccounts() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('customer:write');

  const [rows, setRows] = useState<SettleAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState<AccountStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; row: SettleAccount } | null
  >(null);
  const [idemKey, setIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<SettleFormValues>();

  const [detail, setDetail] = useState<SettleAccountDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // E6：详情抽屉联动的预存余额 + 最近流水。
  const [prepay, setPrepay] = useState<PrepaymentBalance | null>(null);
  const [prepayEntries, setPrepayEntries] = useState<PrepaymentEntriesPage | null>(null);
  // 预存退款快捷入口（列表行内直达，不必进收费台详情）
  const [refundFor, setRefundFor] = useState<SettleAccount | null>(null);
  const [refundBalance, setRefundBalance] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState<number | null>(null);
  const [refundChannel, setRefundChannel] = useState<PayChannel>('CASH');
  const [refundReason, setRefundReason] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundKey, setRefundKey] = useState('');

  // A2 缺失/单户类异常直达：?wa=用水户id → 只显示该户的结算户。
  const [focusParams, setFocusParams] = useSearchParams();
  const focusWa = focusParams.get('wa');
  const [focusSettleId, setFocusSettleId] = useState<string | null>(null);
  const [focusWaNo, setFocusWaNo] = useState<string | null>(null);
  useEffect(() => {
    if (!focusWa) {
      setFocusSettleId(null);
      setFocusWaNo(null);
      return;
    }
    let live = true;
    api
      .get<{ id: string; accountNo: string; settleAccountId: string }>(`/water-accounts/${focusWa}`)
      .then((r) => {
        if (!live) return;
        setFocusSettleId(r.data.settleAccountId);
        setFocusWaNo(r.data.accountNo);
      })
      .catch(() => {
        if (live) setFocusSettleId(null);
      });
    return () => {
      live = false;
    };
  }, [focusWa]);
  const focusList = useFocusList<SettleAccount>(
    focusSettleId,
    rows,
    focusSettleId ? (r) => r.id === focusSettleId : null,
    { onShowAll: () => setPage(1) },
  );

  const load = useCallback(
    async () => {
      setLoading(true);
      try {
        const res = { data: await fetchAll<SettleAccount>('/settle-accounts', {            ...(name.trim() ? { name: name.trim() } : {}),
            ...(status ? { status } : {}),
          }) };
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [message, name, status],
  );

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  // The endpoint returns a page, not a total — allow "next page" exactly
  // when the current page came back full.
  const total = rows.length;

  const openCreate = () => {
    form.resetFields();
    setIdemKey(newIdemKey());
    setModal({ mode: 'create' });
  };
  const openEdit = (row: SettleAccount) => {
    form.setFieldsValue({
      name: row.name,
      phone: row.phone ?? undefined,
      status: row.status === 'CLOSED' ? undefined : row.status,
    });
    setModal({ mode: 'edit', row });
  };

  const submit = async () => {
    let values: SettleFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // inline field errors are already shown
    }
    setSaving(true);
    try {
      if (modal?.mode === 'create') {
        await api.post('/settle-accounts', cleanBody({ ...values }), {
          headers: { 'Idempotency-Key': idemKey },
        });
        message.success('结算户已创建');
      } else if (modal?.mode === 'edit') {
        await api.patch(
          `/settle-accounts/${modal.row.id}`,
          cleanPatch({
            name: values.name,
            phone: values.phone,
            status: values.status,
          }),
        );
        message.success('结算户已更新');
      }
      setModal(null);
      await load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (row: SettleAccount) => {
    setDetailLoading(true);
    setDetail(null);
    setPrepay(null);
    setPrepayEntries(null);
    try {
      const res = await api.get<SettleAccountDetail>(`/settle-accounts/${row.id}`);
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setDetailLoading(false);
    }
    // 预存视图是旁路信息 —— 无 payment:read 权限时静默省略，不阻塞详情。
    try {
      const [bal, entries] = await Promise.all([
        api.get<PrepaymentBalance>(`/prepayments/balance?settleAccountId=${row.id}`),
        api.get<PrepaymentEntriesPage>(
          `/prepayments/entries?settleAccountId=${row.id}&take=20`,
        ),
      ]);
      setPrepay(bal.data);
      setPrepayEntries(entries.data);
    } catch {
      /* permission/edge — 预存区块静默省略 */
    }
  };

  const columns: ColumnsType<SettleAccount> = [
    { title: '结算号', dataIndex: 'settleNo', key: 'settleNo', width: 150 },
    { title: '结算户名称', dataIndex: 'name', key: 'name' },
    {
      title: '电话',
      dataIndex: 'phone',
      key: 'phone',
      width: 140,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: AccountStatus) => <AccountStatusTag status={s} />,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: fmtTime,
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: unknown, record: SettleAccount) => (
        <Space size="small">
          <Button size="small" onClick={() => void openDetail(record)}>
            详情
          </Button>
          {canWrite && record.status !== 'CLOSED' && (
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEdit(record)}
            >
              编辑
            </Button>
          )}
          {record.status !== 'CLOSED' && (
            <Button size="small" danger onClick={() => void openRefund(record)}>
              预存退款
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const openRefund = async (row: SettleAccount) => {
    setRefundFor(row);
    setRefundAmount(null);
    setRefundReason('');
    setRefundKey(newIdemKey());
    try {
      const res = await api.get<{ balance: string }>(
        `/prepayments/balance?settleAccountId=${row.id}`,
      );
      setRefundBalance(res.data.balance);
    } catch {
      setRefundBalance(null);
    }
  };

  const submitRefund = async () => {
    if (!refundFor) return;
    const cent = Math.round((refundAmount ?? 0) * 100);
    if (!Number.isFinite(cent) || cent <= 0) {
      message.warning('请输入退款金额');
      return;
    }
    if (!refundReason.trim()) {
      message.warning('请填写退款原因');
      return;
    }
    setRefundBusy(true);
    try {
      await api.post(
        '/prepayments/refunds',
        {
          settleAccountId: refundFor.id,
          channel: refundChannel,
          amount: String(cent),
          reason: refundReason.trim(),
        },
        { headers: { 'Idempotency-Key': refundKey } },
      );
      message.success('预存退款已完成');
      setRefundFor(null);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setRefundBusy(false);
    }
  };

  const accountColumns: ColumnsType<WaterAccountRef> = [
    {
      title: '户号',
      dataIndex: 'accountNo',
      key: 'accountNo',
      render: (no: string) => (
        <Link to={`/customer/water-accounts?accountNo=${encodeURIComponent(no)}`}>{no}</Link>
      ),
    },
    {
      title: '用水类别',
      dataIndex: 'usageCategory',
      key: 'usageCategory',
      render: (v: string) => enumLabel(USAGE_CATEGORY_LABELS, v),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: WaterAccountRef['status']) => <AccountStatusTag status={s} />,
    },
  ];

  return (
    <Card
      title="结算户"
      extra={
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="按名称搜索"
            style={{ width: 180 }}
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onSearch={(v) => {
              setName(v);
              setPage(1);
            }}
          />
          <Select
                    showSearch
                    optionFilterProp="label"
            allowClear
            placeholder="按状态筛选"
            style={{ width: 140 }}
            options={STATUS_OPTIONS}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void load()}
          >
            刷新
          </Button>
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增结算户
            </Button>
          )}
        </Space>
      }
    >
      {focusWa && (
        <FocusTaskBar
          focusId={focusWa}
          summary={
            <span>
              用水户 {focusWaNo ?? '…'} 的结算户已定位（销户余额残留请走行内「预存退款」）
            </span>
          }
          showAll={focusList.showAll}
          onToggleAll={focusList.toggleAll}
          onClose={() => {
            const next = new URLSearchParams(focusParams);
            next.delete('wa');
            setFocusParams(next, { replace: true });
          }}
        />
      )}
      <Table<SettleAccount> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={focusList.shown}
        pagination={
          focusList.focusing
            ? false
            : {
                current: page,
                pageSize,
                total,
                showSizeChanger: true,
                onChange: (p, size) => {
                  setPage(p);
                  setPageSize(size);
                },
              }
        }
      />

      <Modal maskClosable={false}
        open={modal !== null}
        title={modal?.mode === 'create' ? '新增结算户' : '编辑结算户'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {modal?.mode === 'create' && (
            <Form.Item
              name="settleNo"
              label="结算号"
              extra="留空则由系统自动生成"
            >
              <Input placeholder="如 S202501000001" />
            </Form.Item>
          )}
          <Form.Item
            name="name"
            label="结算户名称"
            rules={[{ required: true, message: '请输入结算户名称' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="联系电话">
            <Input />
          </Form.Item>
          {modal?.mode === 'edit' && (
            <Form.Item
              name="status"
              label="状态"
              extra="已销户的结算户不可编辑，也不能恢复"
            >
              <Select
                options={(['NORMAL', 'SUSPENDED'] as const).map((s) => ({
                  value: s,
                  label: enumLabel(ACCOUNT_STATUS_LABELS, s),
                }))}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Drawer
        open={detail !== null || detailLoading}
        width={560}
        title={detail ? `结算户详情 — ${detail.name}` : '结算户详情'}
        onClose={() => setDetail(null)}
      >
        {detailLoading || !detail ? (
          <Spin />
        ) : (
          <>
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                { key: 'no', label: '结算号', children: detail.settleNo },
                { key: 'name', label: '结算户名称', children: detail.name },
                {
                  key: 'status',
                  label: '状态',
                  children: <AccountStatusTag status={detail.status} />,
                },
                { key: 'phone', label: '电话', children: detail.phone ?? '—' },
                {
                  key: 'created',
                  label: '创建时间',
                  children: fmtTime(detail.createdAt),
                },
              ]}
            />
            <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>
              结算的用水户
            </div>
            <Table<WaterAccountRef> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
              rowKey="id"
              size="small"
              columns={accountColumns}
              dataSource={detail.waterAccounts}
              pagination={false}
            />
            {prepay && (
              <>
                <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>
                  预存余额：<b>{fmtCent(prepay.balance)}</b>
                  {prepay.lots.length > 0 && (
                    <span style={{ fontWeight: 400, color: '#888' }}>
                      （{prepay.lots.length} 个未耗批次）
                    </span>
                  )}
                </div>
                <Table scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
                  rowKey="topUpEntryId"
                  size="small"
                  dataSource={prepay.lots}
                  pagination={false}
                  locale={{ emptyText: '无预存批次' }}
                  columns={[
                    {
                      title: '充值额',
                      dataIndex: 'amount',
                      align: 'right',
                      render: (v: string) => fmtCent(v),
                    },
                    {
                      title: '剩余',
                      dataIndex: 'remaining',
                      align: 'right',
                      render: (v: string) => <b>{fmtCent(v)}</b>,
                    },
                    {
                      title: '充值时间',
                      dataIndex: 'createdAt',
                      render: fmtTime,
                    },
                  ]}
                />
                <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>
                  最近预存流水
                </div>
                <Table scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
                  rowKey="id"
                  size="small"
                  dataSource={prepayEntries?.items ?? []}
                  pagination={false}
                  locale={{ emptyText: '无流水' }}
                  columns={[
                    {
                      title: '时间',
                      dataIndex: 'createdAt',
                      width: 165,
                      render: fmtTime,
                    },
                    {
                      title: '类型',
                      dataIndex: 'type',
                      width: 100,
                      render: (t: keyof typeof PREPAY_ENTRY_LABELS) => (
                        <Tag color={PREPAY_ENTRY_COLORS[t]}>{enumLabel(PREPAY_ENTRY_LABELS, t)}</Tag>
                      ),
                    },
                    {
                      title: '金额',
                      dataIndex: 'amount',
                      width: 110,
                      align: 'right',
                      render: (v: string) => fmtCent(v),
                    },
                  ]}
                />
              </>
            )}
          </>
        )}
      </Drawer>

      <Modal
        maskClosable={false}
        title={refundFor ? `预存退款 — ${refundFor.settleNo} ${refundFor.name}` : ''}
        open={!!refundFor}
        onOk={() => void submitRefund()}
        onCancel={() => setRefundFor(null)}
        confirmLoading={refundBusy}
        okText="确认退款"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          当前预存余额：{refundBalance !== null ? fmtCent(refundBalance) : '查询中…'}
          。退款按充值批次 FIFO 拆行，产生一笔负收款进入当日日结。
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            退款金额（元）
            <InputNumber
              style={{ width: '100%', marginTop: 4 }}
              min={0.01}
              precision={2}
              value={refundAmount}
              onChange={(v) => setRefundAmount(v)}
            />
          </div>
          <div>
            退款渠道
            <Select
              style={{ width: '100%', marginTop: 4 }}
              value={refundChannel}
              onChange={(v) => setRefundChannel(v)}
              options={(['CASH', 'POS', 'TRANSFER'] as PayChannel[]).map((c) => ({
                value: c,
                label: enumLabel(PAY_CHANNEL_LABELS, c),
              }))}
            />
          </div>
          <div>
            退款原因
            <Input
              style={{ marginTop: 4 }}
              maxLength={120}
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              placeholder="如：销户退款 / 客户申请退回预存"
            />
          </div>
        </Space>
      </Modal>
    </Card>
  );
}
