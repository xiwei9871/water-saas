import {
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiErrorText } from '../../api/client';
import type {
  AccountStatus,
  PrepaymentBalance,
  PrepaymentEntriesPage,
  SettleAccount,
  SettleAccountDetail,
  WaterAccountRef,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  ACCOUNT_STATUS_LABELS,
  cleanBody,
  cleanPatch,
  fmtCent,
  fmtTime,
  newIdemKey,
  USAGE_CATEGORY_LABELS,
} from '../common';
import { PREPAY_ENTRY_COLORS, PREPAY_ENTRY_LABELS } from '../payment/common';
import { AccountStatusTag } from '../pickers';

interface SettleFormValues {
  settleNo?: string;
  name: string;
  phone?: string;
  status?: AccountStatus;
}

const STATUS_OPTIONS = (['NORMAL', 'SUSPENDED', 'CLOSED'] as const).map((s) => ({
  value: s,
  label: ACCOUNT_STATUS_LABELS[s],
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

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<SettleAccount[]>('/settle-accounts', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(status ? { status } : {}),
          },
        });
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
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  // The endpoint returns a page, not a total — allow "next page" exactly
  // when the current page came back full.
  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

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
      await load(page, pageSize);
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
    { title: '名称', dataIndex: 'name', key: 'name' },
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
        </Space>
      ),
    },
  ];

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
      render: (v: string) => USAGE_CATEGORY_LABELS[v] ?? v,
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
            onClick={() => void load(page, pageSize)}
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
      <Table<SettleAccount>
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

      <Modal
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
                  label: ACCOUNT_STATUS_LABELS[s],
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
                { key: 'name', label: '名称', children: detail.name },
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
              结算的水表户
            </div>
            <Table<WaterAccountRef>
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
                <Table
                  rowKey="topUpEntryId"
                  size="small"
                  dataSource={prepay.lots}
                  pagination={false}
                  locale={{ emptyText: '无预存批次' }}
                  columns={[
                    {
                      title: '批次',
                      dataIndex: 'topUpEntryId',
                      render: (v: string) => (
                        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {v.slice(0, 8)}…
                        </span>
                      ),
                    },
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
                <Table
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
                        <Tag color={PREPAY_ENTRY_COLORS[t]}>{PREPAY_ENTRY_LABELS[t]}</Tag>
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
    </Card>
  );
}
