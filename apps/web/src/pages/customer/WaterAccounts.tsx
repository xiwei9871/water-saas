import {
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SwapOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
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
  AccountInstallation,
  AccountStatus,
  Customer,
  HouseholdProfile,
  InstallReason,
  PrepaymentBalance,
  ReplaceResult,
  WaterAccount,
  WaterAccountDetail,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  ACCOUNT_STATUS_LABELS,
  cleanBody,
  DECIMAL_RULE,
  fmtCent,
  fmtDate,
  fmtPeriod,
  fmtTime,
  INSTALL_REASON_LABELS,
  newIdemKey,
  USAGE_CATEGORY_LABELS,
  USAGE_CATEGORY_OPTIONS,
} from '../common';
import {
  AccountStatusTag,
  CustomerSelect,
  InstallationStatusTag,
  MeterSelect,
  SettleAccountSelect,
} from '../pickers';

type EventKind = 'suspend' | 'resume' | 'close';

type ModalState =
  | { kind: 'create' }
  | { kind: 'edit'; account: WaterAccount }
  | { kind: 'transfer'; account: WaterAccount }
  | { kind: 'household'; account: WaterAccount }
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

interface HouseholdFormValues {
  householdSize: number;
  effectiveMonth: dayjs.Dayjs;
}

interface MeterInstallFormValues {
  meterId: string;
  initialReading: string;
  installedAt?: dayjs.Dayjs;
  reason?: InstallReason;
}

interface MeterRemoveFormValues {
  finalReading: string;
  removedAt?: dayjs.Dayjs;
}

interface MeterReplaceFormValues {
  newMeterId: string;
  oldFinalReading: string;
  newInitialReading: string;
  replacedAt?: dayjs.Dayjs;
  reason?: 'REPLACE' | 'FAULT' | 'PERIODIC_CHECK';
}

type MeterModalState =
  | { kind: 'install' }
  | { kind: 'remove'; inst: AccountInstallation }
  | { kind: 'replace'; inst: AccountInstallation }
  | null;

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
  // E6：过户前预取原结算户的预存余额，用于“余额不迁移”警告。
  const [transferBalance, setTransferBalance] = useState<string | null>(null);
  const [createForm] = Form.useForm<CreateFormValues>();
  const [editForm] = Form.useForm<EditFormValues>();
  const [transferForm] = Form.useForm<TransferFormValues>();
  const [eventForm] = Form.useForm<EventFormValues>();
  const [householdForm] = Form.useForm<HouseholdFormValues>();
  const [hhLoading, setHhLoading] = useState(false);
  const [hhCurrent, setHhCurrent] = useState<number | null>(null);
  const [hhProfiles, setHhProfiles] = useState<HouseholdProfile[]>([]);

  // ---- E7 水表对象抽屉：当前表 + 安装史 + 装/换/拆 ----
  const [meterDrawerId, setMeterDrawerId] = useState<string | null>(null);
  const [meterDetail, setMeterDetail] = useState<WaterAccountDetail | null>(null);
  const [meterLoading, setMeterLoading] = useState(false);
  const [meterModal, setMeterModal] = useState<MeterModalState>(null);
  const [meterInstallForm] = Form.useForm<MeterInstallFormValues>();
  const [meterRemoveForm] = Form.useForm<MeterRemoveFormValues>();
  const [meterReplaceForm] = Form.useForm<MeterReplaceFormValues>();

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
    if (m.kind === 'transfer') {
      setTransferBalance(null);
      api
        .get<PrepaymentBalance>(
          `/prepayments/balance?settleAccountId=${m.account.settleAccountId}`,
        )
        .then((res) => setTransferBalance(res.data.balance))
        .catch(() => setTransferBalance('0')); // 无预存读权限时不阻塞过户
    }
  };

  const loadHousehold = useCallback(async (accountId: string) => {
    setHhLoading(true);
    try {
      const [detail, profiles] = await Promise.all([
        api.get<WaterAccountDetail>(`/water-accounts/${accountId}`),
        api.get<HouseholdProfile[]>(
          `/water-accounts/${accountId}/household-profiles`,
        ),
      ]);
      setHhCurrent(detail.data.householdSize);
      setHhProfiles(profiles.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setHhLoading(false);
    }
  }, [message]);

  const openHousehold = (account: WaterAccount) => {
    householdForm.setFieldsValue({ effectiveMonth: dayjs() });
    setHhCurrent(null);
    setHhProfiles([]);
    openModal({ kind: 'household', account });
    void loadHousehold(account.id);
  };

  const submitHousehold = async () => {
    let values: HouseholdFormValues;
    try {
      values = await householdForm.validateFields();
    } catch {
      return;
    }
    if (modal?.kind !== 'household') return;
    setSaving(true);
    try {
      await api.post(
        `/water-accounts/${modal.account.id}/household-profiles`,
        {
          householdSize: values.householdSize,
          effectiveFromPeriod: values.effectiveMonth.format('YYYYMM'),
        },
        { headers: { 'Idempotency-Key': idemKey } },
      );
      message.success('人数申报已保存，自下个账期起生效于阶梯计费');
      householdForm.setFieldsValue({ householdSize: undefined });
      // 弹窗允许多次申报 —— 每次成功后换新幂等键（失败保留原键供重试回放）。
      setIdemKey(newIdemKey());
      await loadHousehold(modal.account.id);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
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

  const loadMeterDetail = useCallback(
    async (accountId: string) => {
      setMeterLoading(true);
      try {
        const res = await api.get<WaterAccountDetail>(
          `/water-accounts/${accountId}`,
        );
        setMeterDetail(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setMeterLoading(false);
      }
    },
    [message],
  );

  const openMeterDrawer = (account: WaterAccount) => {
    setMeterDrawerId(account.id);
    setMeterDetail(null);
    setMeterModal(null);
    void loadMeterDetail(account.id);
  };

  /** 装/换/拆完成后统一刷新详情 + 列表。 */
  const afterMeterMutation = async () => {
    setMeterModal(null);
    if (meterDrawerId) await loadMeterDetail(meterDrawerId);
    await load(page, pageSize);
  };

  const submitMeterInstall = async () => {
    let values: MeterInstallFormValues;
    try {
      values = await meterInstallForm.validateFields();
    } catch {
      return;
    }
    if (!meterDrawerId) return;
    setSaving(true);
    try {
      await api.post(
        '/meter-installations',
        cleanBody({
          waterAccountId: meterDrawerId,
          meterId: values.meterId,
          initialReading: values.initialReading,
          installedAt: values.installedAt?.format('YYYY-MM-DD'),
          reason: values.reason,
        }),
        { headers: { 'Idempotency-Key': idemKey } },
      );
      message.success('装表完成');
      await afterMeterMutation();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const submitMeterRemove = async () => {
    let values: MeterRemoveFormValues;
    try {
      values = await meterRemoveForm.validateFields();
    } catch {
      return;
    }
    if (meterModal?.kind !== 'remove') return;
    setSaving(true);
    try {
      await api.post(
        `/meter-installations/${meterModal.inst.id}/remove`,
        cleanBody({
          finalReading: values.finalReading,
          removedAt: values.removedAt?.format('YYYY-MM-DD'),
        }),
        { headers: { 'Idempotency-Key': idemKey } },
      );
      message.success('拆表完成');
      await afterMeterMutation();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const submitMeterReplace = async () => {
    let values: MeterReplaceFormValues;
    try {
      values = await meterReplaceForm.validateFields();
    } catch {
      return;
    }
    if (meterModal?.kind !== 'replace') return;
    setSaving(true);
    try {
      await api.post<ReplaceResult>(
        `/meter-installations/${meterModal.inst.id}/replace`,
        cleanBody({
          newMeterId: values.newMeterId,
          oldFinalReading: values.oldFinalReading,
          newInitialReading: values.newInitialReading,
          replacedAt: values.replacedAt?.format('YYYY-MM-DD'),
          reason: values.reason,
        }),
        { headers: { 'Idempotency-Key': idemKey } },
      );
      message.success('换表完成');
      await afterMeterMutation();
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
      width: 150,
      render: (v: string, row) => (
        <>
          {USAGE_CATEGORY_LABELS[v] ?? v}
          {row.billable === false && (
            <Tag color="blue" style={{ marginLeft: 6 }}>
              不计费
            </Tag>
          )}
        </>
      ),
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
            width: 300,
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
                  {!closed && record.billable !== false && (
                    <Button size="small" onClick={() => openHousehold(record)}>
                      人数
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
                  <Button
                    size="small"
                    icon={<ToolOutlined />}
                    onClick={() => openMeterDrawer(record)}
                  >
                    水表
                  </Button>
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
            rules={[{ required: true, message: '请选择用水类别' }]}
          >
            <Select options={USAGE_CATEGORY_OPTIONS} placeholder="选择用水类别" />
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
            rules={[{ required: true, message: '请选择用水类别' }]}
          >
            <Select options={USAGE_CATEGORY_OPTIONS} />
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
        {transferBalance !== null && Number(transferBalance) > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={`原结算户预存余额 ${fmtCent(transferBalance)} 不会随改挂迁移 —— 余额归属结算户而非水表户；如需跨结算户转移请先办理预存退款。`}
          />
        )}
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

      {/* 一户多人口申报 */}
      <Modal
        open={modal?.kind === 'household'}
        title={
          modal?.kind === 'household'
            ? `用水人数申报 — ${modal.account.accountNo}`
            : ''
        }
        okText="提交申报"
        cancelText="关闭"
        confirmLoading={saving}
        onOk={() => void submitHousehold()}
        onCancel={() => setModal(null)}
        width={640}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="申报按账期生效，不回溯改历史账单"
          description="申报记录自生效账期起参与阶梯水价计算（人数档位由资费方案的基准人数与每人扩展量决定）。历史账单与历史结算不受后续申报影响。"
        />
        <p style={{ color: '#666' }}>
          当前申报人数：<strong>{hhCurrent ?? '—'}</strong>
          <span style={{ marginLeft: 8, color: '#999' }}>
            （展示值；实际计费以各账期结算快照为准）
          </span>
        </p>
        <Form form={householdForm} layout="inline" style={{ marginBottom: 16 }}>
          <Form.Item
            name="householdSize"
            label="用水人数"
            rules={[{ required: true, message: '请输入人数' }]}
          >
            <InputNumber min={1} max={99} precision={0} placeholder="人" />
          </Form.Item>
          <Form.Item
            name="effectiveMonth"
            label="生效账期"
            rules={[{ required: true, message: '请选择生效账期' }]}
          >
            <DatePicker picker="month" allowClear={false} />
          </Form.Item>
        </Form>
        <Table<HouseholdProfile>
          rowKey="id"
          size="small"
          loading={hhLoading}
          dataSource={hhProfiles}
          pagination={false}
          locale={{ emptyText: '尚未申报，按资费基准人数计费' }}
          columns={[
            {
              title: '生效账期',
              dataIndex: 'effectiveFromPeriod',
              render: (p: string, row) => {
                const currentPeriod = dayjs().format('YYYYMM');
                return (
                  <>
                    {fmtPeriod(p)}
                    {p <= currentPeriod &&
                      row.id ===
                        hhProfiles.find((r) => r.effectiveFromPeriod <= currentPeriod)
                          ?.id && (
                        <Tag color="green" style={{ marginLeft: 6 }}>
                          当前生效
                        </Tag>
                      )}
                    {p > currentPeriod && (
                      <Tag style={{ marginLeft: 6 }}>未生效</Tag>
                    )}
                  </>
                );
              },
            },
            { title: '人数', dataIndex: 'householdSize', width: 80 },
            {
              title: '申报时间',
              dataIndex: 'createdAt',
              render: (v: string) => fmtTime(v),
            },
          ]}
        />
      </Modal>

      {/* E7 水表抽屉：当前表 + 安装史 + 装/换/拆 */}
      <Drawer
        open={meterDrawerId !== null}
        title={
          meterDetail
            ? `水表 — ${meterDetail.accountNo}`
            : '水表'
        }
        width={760}
        onClose={() => setMeterDrawerId(null)}
        loading={meterLoading}
      >
        {meterDetail && (
          <MeterSection
            detail={meterDetail}
            canWrite={canWrite}
            onInstall={() => {
              meterInstallForm.resetFields();
              setIdemKey(newIdemKey());
              setMeterModal({ kind: 'install' });
            }}
            onRemove={(inst) => {
              meterRemoveForm.resetFields();
              setIdemKey(newIdemKey());
              setMeterModal({ kind: 'remove', inst });
            }}
            onReplace={(inst) => {
              meterReplaceForm.resetFields();
              meterReplaceForm.setFieldValue('reason', 'REPLACE');
              setIdemKey(newIdemKey());
              setMeterModal({ kind: 'replace', inst });
            }}
          />
        )}
      </Drawer>

      {/* 装表（户内） */}
      <Modal
        open={meterModal?.kind === 'install'}
        title="装表"
        okText="确认装表"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitMeterInstall()}
        onCancel={() => setMeterModal(null)}
        destroyOnHidden
      >
        <Form form={meterInstallForm} layout="vertical">
          <Form.Item
            name="meterId"
            label="水表（仅可用表可安装）"
            rules={[{ required: true, message: '请选择水表' }]}
          >
            <MeterSelect status="AVAILABLE" />
          </Form.Item>
          <Form.Item
            name="initialReading"
            label="初始读数"
            rules={[{ required: true, message: '请输入初始读数' }, DECIMAL_RULE]}
          >
            <Input placeholder="如 0" />
          </Form.Item>
          <Form.Item name="installedAt" label="装表日期">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reason" label="装表原因">
            <Select
              allowClear
              options={(
                ['NEW', 'REPLACE', 'FAULT', 'PERIODIC_CHECK'] as const
              ).map((r) => ({ value: r, label: INSTALL_REASON_LABELS[r] }))}
              placeholder="默认新装"
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 拆表（户内） */}
      <Modal
        open={meterModal?.kind === 'remove'}
        title={
          meterModal?.kind === 'remove'
            ? `拆表 — ${meterModal.inst.meter.meterNo}`
            : ''
        }
        okText="确认拆除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitMeterRemove()}
        onCancel={() => setMeterModal(null)}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="拆表后安装记录转为已拆除，水表回到可用状态。"
          description={
            meterModal?.kind === 'remove'
              ? `拆除读数须不小于装表初始读数（${meterModal.inst.initialReading}）。`
              : undefined
          }
        />
        <Form form={meterRemoveForm} layout="vertical">
          <Form.Item
            name="finalReading"
            label="拆除读数"
            rules={[{ required: true, message: '请输入拆除读数' }, DECIMAL_RULE]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="removedAt" label="拆表日期">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 换表（户内）— 原子操作，两个读数分属不同物理表盘 */}
      <Modal
        open={meterModal?.kind === 'replace'}
        title={
          meterModal?.kind === 'replace'
            ? `换表 — ${meterModal.inst.meter.meterNo}`
            : ''
        }
        okText="确认换表"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitMeterReplace()}
        onCancel={() => setMeterModal(null)}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="换表为单事务操作：旧表按止码拆除、新表按始码挂装，两块物理表盘读数互相独立。"
          description="远传设备绑定不会自动迁移，新表需重新绑定。"
        />
        <Form form={meterReplaceForm} layout="vertical">
          <Form.Item
            name="newMeterId"
            label="新表（仅可用表）"
            rules={[{ required: true, message: '请选择新表' }]}
          >
            <MeterSelect status="AVAILABLE" />
          </Form.Item>
          <Form.Item
            name="oldFinalReading"
            label="旧表止码"
            rules={[{ required: true, message: '请输入旧表止码' }, DECIMAL_RULE]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="newInitialReading"
            label="新表始码"
            rules={[{ required: true, message: '请输入新表始码' }, DECIMAL_RULE]}
            extra="新表自身表盘读数，通常不等于旧表止码"
          >
            <Input />
          </Form.Item>
          <Form.Item name="replacedAt" label="换表日期">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reason" label="换表原因">
            <Select
              allowClear
              options={(['REPLACE', 'FAULT', 'PERIODIC_CHECK'] as const).map(
                (r) => ({ value: r, label: INSTALL_REASON_LABELS[r] }),
              )}
              placeholder="默认换表"
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

/**
 * 水表户详情的“水表”区（E7 对象中心视图）：
 * - 0 ACTIVE：装表入口
 * - 1 ACTIVE：当前表卡片 + 换表/拆表
 * - >1 ACTIVE：如实展示 + 异常警示（domain 允许多表，UI 不自动修复）
 * “当前表” = installed_at 最新的 ACTIVE，与抄表解析规则一致。
 */
function MeterSection({
  detail,
  canWrite,
  onInstall,
  onRemove,
  onReplace,
}: {
  detail: WaterAccountDetail;
  canWrite: boolean;
  onInstall: () => void;
  onRemove: (inst: AccountInstallation) => void;
  onReplace: (inst: AccountInstallation) => void;
}) {
  const installations = detail.meterInstallations ?? [];
  const actives = installations.filter((i) => i.status === 'ACTIVE');
  const current = actives[0]; // installed_at DESC — the newest
  const closed = detail.status === 'CLOSED';

  return (
    <>
      {actives.length > 1 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`该户存在 ${actives.length} 只在册水表`}
          description="一户多表为异常数据（多为历史遗留）。已全部如实展示，当前表按装表时间最新的一块解析；请在核实后拆除多余安装记录。"
        />
      )}
      {current ? (
        <Descriptions
          column={2}
          size="small"
          bordered
          title="当前表"
          style={{ marginBottom: 16 }}
        >
          <Descriptions.Item label="表号">
            {current.meter.meterNo}
          </Descriptions.Item>
          <Descriptions.Item label="品牌/口径">
            {[current.meter.brand, current.meter.caliber]
              .filter(Boolean)
              .join(' ') || '—'}
          </Descriptions.Item>
          <Descriptions.Item label="装表时间">
            {fmtDate(current.installedAt)}
          </Descriptions.Item>
          <Descriptions.Item label="装表始码">
            {current.initialReading}
          </Descriptions.Item>
        </Descriptions>
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="该户当前没有在册水表"
        />
      )}
      {canWrite && !closed && (
        <Space style={{ marginBottom: 16 }}>
          {actives.length === 0 && (
            <Button type="primary" onClick={onInstall}>
              装表
            </Button>
          )}
          {current && (
            <>
              <Button icon={<SwapOutlined />} onClick={() => onReplace(current)}>
                换表
              </Button>
              <Button danger onClick={() => onRemove(current)}>
                拆表
              </Button>
            </>
          )}
        </Space>
      )}
      <Table<AccountInstallation>
        rowKey="id"
        size="small"
        dataSource={installations}
        pagination={false}
        locale={{ emptyText: '暂无安装记录' }}
        columns={[
          {
            title: '表号',
            key: 'meterNo',
            render: (_: unknown, r) => r.meter.meterNo,
          },
          {
            title: '装表时间',
            dataIndex: 'installedAt',
            render: (v: string) => fmtDate(v),
          },
          {
            title: '拆表时间',
            dataIndex: 'removedAt',
            render: (v: string | null) => fmtDate(v),
          },
          { title: '始码', dataIndex: 'initialReading' },
          {
            title: '止码',
            dataIndex: 'finalReading',
            render: (v: string | null) => v ?? '—',
          },
          {
            title: '原因',
            dataIndex: 'reason',
            render: (r: InstallReason) => INSTALL_REASON_LABELS[r],
          },
          {
            title: '状态',
            dataIndex: 'status',
            render: (s) => <InstallationStatusTag status={s} />,
          },
          ...(canWrite && !closed && actives.length > 1
            ? [
                {
                  title: '操作',
                  key: 'actions',
                  render: (_: unknown, r: AccountInstallation) =>
                    r.status === 'ACTIVE' && r.id !== current?.id ? (
                      <Button size="small" danger onClick={() => onRemove(r)}>
                        拆除
                      </Button>
                    ) : null,
                },
              ]
            : []),
        ]}
      />
    </>
  );
}
