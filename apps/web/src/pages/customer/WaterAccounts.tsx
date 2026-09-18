import {
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, apiErrorText } from '../../api/client';
import type {
  AccountStatus,
  Customer,
  WaterAccount,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  ACCOUNT_STATUS_LABELS,
  cleanBody,
  fmtDate,
  newIdemKey,
} from './common';
import {
  AccountStatusTag,
  CustomerSelect,
  SettleAccountSelect,
} from './pickers';

type EventKind = 'suspend' | 'resume' | 'close';

type ModalState =
  | { kind: 'create' }
  | { kind: 'edit'; account: WaterAccount }
  | { kind: 'transfer'; account: WaterAccount }
  | { kind: EventKind; account: WaterAccount }
  | null;

const EVENT_TEXT: Record<
  EventKind,
  { title: string; ok: string; success: string }
> = {
  suspend: { title: '暂停供水', ok: '确认暂停', success: '已暂停' },
  resume: { title: '恢复供水', ok: '确认恢复', success: '已恢复' },
  close: { title: '销户', ok: '确认销户', success: '已销户' },
};

const STATUS_OPTIONS = (['NORMAL', 'SUSPENDED', 'CLOSED'] as const).map((s) => ({
  value: s,
  label: ACCOUNT_STATUS_LABELS[s],
}));

interface CreateFormValues {
  customerId: string;
  settleAccountId: string;
  usageCategory: string;
  addr: string;
  accountNo?: string;
  openedAt?: dayjs.Dayjs;
}

interface EditFormValues {
  usageCategory: string;
  addr: string;
}

interface TransferFormValues {
  customerId?: string;
  settleAccountId?: string;
  effectiveDate?: dayjs.Dayjs;
  remark?: string;
}

interface EventFormValues {
  effectiveDate?: dayjs.Dayjs;
  remark?: string;
}

/**
 * 水表户：户号精确搜索 + 状态/客户过滤 + 开户 + 编辑 + 生命周期操作
 * （暂停/恢复/销户/过户，各走独立 POST + account_event）。
 * URL 参数：?accountNo= / ?customerId=（客户详情抽屉的“查看全部”入口）。
 */
export default function WaterAccounts() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('customer:write');
  const [searchParams] = useSearchParams();

  const [rows, setRows] = useState<WaterAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [noInput, setNoInput] = useState(searchParams.get('accountNo') ?? '');
  const [accountNo, setAccountNo] = useState(searchParams.get('accountNo') ?? '');
  const [status, setStatus] = useState<AccountStatus | undefined>(undefined);
  const [customerId, setCustomerId] = useState<string | undefined>(
    searchParams.get('customerId') ?? undefined,
  );
  // 从 URL 带入的 customerId —— 拉一次客户信息仅用于过滤标签展示。
  const [presetCustomer, setPresetCustomer] = useState<Customer | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [modal, setModal] = useState<ModalState>(null);
  const [idemKey, setIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [createForm] = Form.useForm<CreateFormValues>();
  const [editForm] = Form.useForm<EditFormValues>();
  const [transferForm] = Form.useForm<TransferFormValues>();
  const [eventForm] = Form.useForm<EventFormValues>();

  // Same-route navigations only swap the query string — keep the filters in
  // sync so 抽屉里的“查看全部”链接总是生效。setState 走 microtask，不在
  // effect 内同步触发级联渲染。
  useEffect(() => {
    const no = searchParams.get('accountNo');
    const cid = searchParams.get('customerId');
    queueMicrotask(() => {
      if (no !== null) {
        setNoInput(no);
        setAccountNo(no);
        setPage(1);
      }
      if (cid) setCustomerId(cid);
    });
  }, [searchParams]);

  useEffect(() => {
    const id = searchParams.get('customerId');
    if (!id) return;
    let cancelled = false;
    api
      .get<Customer>(`/customers/${id}`)
      .then((res) => {
        if (!cancelled) setPresetCustomer(res.data);
      })
      .catch(() => setPresetCustomer(null));
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<WaterAccount[]>('/water-accounts', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(accountNo.trim() ? { accountNo: accountNo.trim() } : {}),
            ...(status ? { status } : {}),
            ...(customerId ? { customerId } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [accountNo, customerId, message, status],
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

  const openModal = (m: NonNullable<ModalState>) => {
    setIdemKey(newIdemKey()); // 每次打开表单生成一次幂等键
    setModal(m);
  };

  const submitCreate = async () => {
    let values: CreateFormValues;
    try {
      values = await createForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      await api.post(
        '/water-accounts',
        cleanBody({
          customerId: values.customerId,
          settleAccountId: values.settleAccountId,
          usageCategory: values.usageCategory,
          addr: values.addr,
          accountNo: values.accountNo,
          openedAt: values.openedAt?.format('YYYY-MM-DD'),
        }),
        { headers: { 'Idempotency-Key': idemKey } },
      );
      message.success('水表户已开立');
      setModal(null);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const submitEdit = async () => {
    let values: EditFormValues;
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }
    if (modal?.kind !== 'edit') return;
    setSaving(true);
    try {
      await api.patch(
        `/water-accounts/${modal.account.id}`,
        cleanBody({ usageCategory: values.usageCategory, addr: values.addr }),
      );
      message.success('水表户已更新');
      setModal(null);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const submitTransfer = async () => {
    let values: TransferFormValues;
    try {
      values = await transferForm.validateFields();
    } catch {
      return;
    }
    if (modal?.kind !== 'transfer') return;
    if (!values.customerId && !values.settleAccountId) {
      message.warning('请选择过户目标客户或结算户');
      return;
    }
    setSaving(true);
    try {
      await api.post(
        `/water-accounts/${modal.account.id}/transfer`,
        cleanBody({
          customerId: values.customerId,
          settleAccountId: values.settleAccountId,
          effectiveDate: values.effectiveDate?.format('YYYY-MM-DD'),
          remark: values.remark,
        }),
        { headers: { 'Idempotency-Key': idemKey } },
      );
      message.success('已过户');
      setModal(null);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const submitEvent = async () => {
    let values: EventFormValues;
    try {
      values = await eventForm.validateFields();
    } catch {
      return;
    }
    if (modal?.kind !== 'suspend' && modal?.kind !== 'resume' && modal?.kind !== 'close') {
      return;
    }
    setSaving(true);
    try {
      await api.post(
        `/water-accounts/${modal.account.id}/${modal.kind}`,
        cleanBody({
          effectiveDate: values.effectiveDate?.format('YYYY-MM-DD'),
          remark: values.remark,
        }),
        { headers: { 'Idempotency-Key': idemKey } },
      );
      message.success(`${modal.account.accountNo} ${EVENT_TEXT[modal.kind].success}`);
      setModal(null);
      await load(page, pageSize);
    } catch (err) {
      // 销户被拒（如 ACCOUNT_OUTSTANDING_BALANCE）时直接透出服务端 code 文案。
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<WaterAccount> = [
    { title: '户号', dataIndex: 'accountNo', key: 'accountNo', width: 150 },
    {
      title: '客户',
      key: 'customer',
      width: 160,
      render: (_: unknown, r: WaterAccount) =>
        r.customer ? `${r.customer.name}（${r.customer.customerNo}）` : '—',
    },
    {
      title: '结算户',
      key: 'settleAccount',
      width: 160,
      render: (_: unknown, r: WaterAccount) =>
        r.settleAccount
          ? `${r.settleAccount.name}（${r.settleAccount.settleNo}）`
          : '—',
    },
    {
      title: '用水类别',
      dataIndex: 'usageCategory',
      key: 'usageCategory',
      width: 110,
    },
    {
      title: '地址',
      dataIndex: 'addr',
      key: 'addr',
      ellipsis: true,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 80,
      render: (s: AccountStatus) => <AccountStatusTag status={s} />,
    },
    {
      title: '开户日期',
      dataIndex: 'openedAt',
      key: 'openedAt',
      width: 110,
      render: (v: string | null) => fmtDate(v),
    },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 250,
            render: (_: unknown, record: WaterAccount) => {
              const closed = record.status === 'CLOSED';
              return (
                <Space size={4} wrap>
                  {!closed && (
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => {
                        editForm.setFieldsValue({
                          usageCategory: record.usageCategory,
                          addr: record.addr,
                        });
                        openModal({ kind: 'edit', account: record });
                      }}
                    >
                      编辑
                    </Button>
                  )}
                  {!closed && (
                    <Button
                      size="small"
                      icon={<SwapOutlined />}
                      onClick={() => {
                        transferForm.resetFields();
                        openModal({ kind: 'transfer', account: record });
                      }}
                    >
                      过户
                    </Button>
                  )}
                  {record.status === 'NORMAL' && (
                    <Button
                      size="small"
                      onClick={() => {
                        eventForm.resetFields();
                        openModal({ kind: 'suspend', account: record });
                      }}
                    >
                      暂停
                    </Button>
                  )}
                  {record.status === 'SUSPENDED' && (
                    <Button
                      size="small"
                      onClick={() => {
                        eventForm.resetFields();
                        openModal({ kind: 'resume', account: record });
                      }}
                    >
                      恢复
                    </Button>
                  )}
                  {!closed && (
                    <Button
                      size="small"
                      danger
                      onClick={() => {
                        eventForm.resetFields();
                        openModal({ kind: 'close', account: record });
                      }}
                    >
                      销户
                    </Button>
                  )}
                </Space>
              );
            },
          } satisfies ColumnsType<WaterAccount>[number],
        ]
      : []),
  ];

  const eventKind =
    modal?.kind === 'suspend' || modal?.kind === 'resume' || modal?.kind === 'close'
      ? modal.kind
      : null;

  return (
    <Card
      title="水表户"
      extra={
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="按户号精确查询"
            style={{ width: 180 }}
            value={noInput}
            onChange={(e) => setNoInput(e.target.value)}
            onSearch={(v) => {
              setAccountNo(v);
              setPage(1);
            }}
          />
          <Select
            allowClear
            placeholder="按状态筛选"
            style={{ width: 120 }}
            options={STATUS_OPTIONS}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          <span style={{ width: 200, display: 'inline-block' }}>
            <CustomerSelect
              // URL 带入的 customerId 由下方 Tag 展示 —— Select 保持空置，
              // 否则选项里没有该客户时会显示裸 uuid。
              value={presetCustomer ? undefined : customerId}
              onChange={(v) => {
                setCustomerId(v);
                setPresetCustomer(null);
                setPage(1);
              }}
              placeholder="按客户过滤"
            />
          </span>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void load(page, pageSize)}
          >
            刷新
          </Button>
          {canWrite && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                createForm.resetFields();
                openModal({ kind: 'create' });
              }}
            >
              开户
            </Button>
          )}
        </Space>
      }
    >
      {presetCustomer && customerId && (
        <div style={{ marginBottom: 12 }}>
          <Tag
            closable
            color="blue"
            onClose={() => {
              setCustomerId(undefined);
              setPresetCustomer(null);
            }}
          >
            客户：{presetCustomer.name}（{presetCustomer.customerNo}）
          </Tag>
        </div>
      )}
      <Table<WaterAccount>
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

      {/* 开户 */}
      <Modal
        open={modal?.kind === 'create'}
        title="开立水表户"
        okText="开户"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitCreate()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical">
          <Form.Item
            name="customerId"
            label="客户"
            rules={[{ required: true, message: '请选择客户' }]}
          >
            <CustomerSelect />
          </Form.Item>
          <Form.Item
            name="settleAccountId"
            label="结算户"
            rules={[{ required: true, message: '请选择结算户' }]}
          >
            <SettleAccountSelect />
          </Form.Item>
          <Form.Item
            name="usageCategory"
            label="用水类别"
            rules={[{ required: true, message: '请输入用水类别' }]}
          >
            <Input placeholder="如 居民用水 / 商业用水" />
          </Form.Item>
          <Form.Item
            name="addr"
            label="用水地址"
            rules={[{ required: true, message: '请输入用水地址' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="accountNo" label="户号" extra="留空则由系统自动生成">
            <Input placeholder="如 A202501000001" />
          </Form.Item>
          <Form.Item name="openedAt" label="开户日期">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑 */}
      <Modal
        open={modal?.kind === 'edit'}
        title={modal?.kind === 'edit' ? `编辑水表户 — ${modal.account.accountNo}` : ''}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitEdit()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item
            name="usageCategory"
            label="用水类别"
            rules={[{ required: true, message: '请输入用水类别' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="addr"
            label="用水地址"
            rules={[{ required: true, message: '请输入用水地址' }]}
          >
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      {/* 过户 */}
      <Modal
        open={modal?.kind === 'transfer'}
        title={
          modal?.kind === 'transfer' ? `过户 — ${modal.account.accountNo}` : ''
        }
        okText="确认过户"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitTransfer()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="至少选择一项过户目标：客户或结算户。未选的一方保持原值不变。"
        />
        <Form form={transferForm} layout="vertical">
          <Form.Item name="customerId" label="过户至客户">
            <CustomerSelect placeholder="搜索目标客户名称" />
          </Form.Item>
          <Form.Item name="settleAccountId" label="过户至结算户">
            <SettleAccountSelect placeholder="搜索目标结算户名称" />
          </Form.Item>
          <Form.Item name="effectiveDate" label="生效日期">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 暂停 / 恢复 / 销户 */}
      <Modal
        open={eventKind !== null}
        title={
          eventKind && modal && 'account' in modal
            ? `${EVENT_TEXT[eventKind].title} — ${modal.account.accountNo}`
            : ''
        }
        okText={eventKind ? EVENT_TEXT[eventKind].ok : '确定'}
        okButtonProps={{ danger: eventKind === 'close' }}
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitEvent()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        {eventKind === 'close' && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="销户为不可逆操作"
            description="销户前须结清该户全部欠费与余额，存在未结清款项时服务端将拒绝。"
          />
        )}
        <Form form={eventForm} layout="vertical">
          <Form.Item name="effectiveDate" label="生效日期">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
