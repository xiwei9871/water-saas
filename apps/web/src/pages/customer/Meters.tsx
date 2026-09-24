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
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  InstallReason,
  InstallationStatus,
  Meter,
  MeterDetail,
  MeterInstallation,
  MeterStatus,
  ReplaceResult,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  DECIMAL_RULE,
  INSTALLATION_STATUS_LABELS,
  INSTALL_REASON_LABELS,
  METER_STATUS_LABELS,
  cleanBody,
  cleanPatch,
  fmtDate,
  fmtTime,
  newIdemKey,
} from '../common';
import {
  CustomerSelect,
  InstallationStatusTag,
  MeterSelect,
  MeterStatusTag,
  WaterAccountSelect,
} from '../pickers';

/**
 * PATCH /meters/:id 允许的状态流转（与服务端一致）：
 * INSTALLED 出入都走装/拆接口，PATCH 只管库存态之间的移动。
 */
const PATCH_TRANSITIONS: Record<MeterStatus, MeterStatus[]> = {
  AVAILABLE: ['MAINTENANCE', 'RETIRED'],
  INSTALLED: [],
  MAINTENANCE: ['AVAILABLE', 'RETIRED'],
  RETIRED: [],
};

interface MeterFormValues {
  meterNo?: string;
  serialNo?: string;
  barcode?: string;
  brand?: string;
  model?: string;
  caliber?: string;
  maxDial?: string;
  status?: MeterStatus;
}

interface InstallFormValues {
  customerId?: string; // 仅用于级联过滤用水户，不提交
  waterAccountId: string;
  meterId: string;
  initialReading: string;
  installedAt?: dayjs.Dayjs;
  reason?: InstallReason;
}

interface RemoveFormValues {
  finalReading: string;
  removedAt?: dayjs.Dayjs;
}

interface ReplaceFormValues {
  newMeterId: string;
  oldFinalReading: string;
  newInitialReading: string;
  replacedAt?: dayjs.Dayjs;
  reason?: 'REPLACE' | 'FAULT' | 'PERIODIC_CHECK';
}

const REASON_OPTIONS = (
  ['NEW', 'REPLACE', 'FAULT', 'PERIODIC_CHECK'] as const
).map((r) => ({ value: r, label: INSTALL_REASON_LABELS[r] }));

const REPLACE_REASON_OPTIONS = (
  ['REPLACE', 'FAULT', 'PERIODIC_CHECK'] as const
).map((r) => ({ value: r, label: INSTALL_REASON_LABELS[r] }));

/** 水表管理：设备台账（含受限状态流转）+ 装拆记录（装表/拆表）。 */
export default function Meters() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('customer:write');

  const [rows, setRows] = useState<Meter[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<MeterStatus | undefined>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [meterModal, setMeterModal] = useState<
    { mode: 'create' } | { mode: 'edit'; meter: Meter } | null
  >(null);
  const [idemKey, setIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [meterForm] = Form.useForm<MeterFormValues>();

  // ---- 装拆记录 ----
  const [instRows, setInstRows] = useState<MeterInstallation[]>([]);
  const [instLoading, setInstLoading] = useState(false);
  const [instStatus, setInstStatus] = useState<InstallationStatus | undefined>();
  const [instMeter, setInstMeter] = useState<{ id: string; meterNo: string } | null>(null);
  const [instCustomerId, setInstCustomerId] = useState<string | undefined>();
  const [instAccountId, setInstAccountId] = useState<string | undefined>();
  const [instPage, setInstPage] = useState(1);
  const [instPageSize, setInstPageSize] = useState(20);
  const instCardRef = useRef<HTMLDivElement>(null);

  const [installOpen, setInstallOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<MeterInstallation | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<MeterInstallation | null>(null);
  const [installForm] = Form.useForm<InstallFormValues>();
  const [removeForm] = Form.useForm<RemoveFormValues>();
  const [replaceForm] = Form.useForm<ReplaceFormValues>();
  const installCustomerId = Form.useWatch('customerId', installForm);

  // ---- 水表详情抽屉（台账对象中心视图：档案 + 安装史） ----
  const [detailMeterId, setDetailMeterId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MeterDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<Meter[]>('/meters', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(statusFilter ? { status: statusFilter } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [message, statusFilter],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  const loadInstallations = useCallback(
    async (p: number, size: number) => {
      setInstLoading(true);
      try {
        const res = await api.get<MeterInstallation[]>('/meter-installations', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(instStatus ? { status: instStatus } : {}),
            ...(instMeter ? { meterId: instMeter.id } : {}),
            ...(instAccountId ? { waterAccountId: instAccountId } : {}),
          },
        });
        setInstRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setInstLoading(false);
      }
    },
    [instAccountId, instMeter, instStatus, message],
  );

  useEffect(() => {
    queueMicrotask(() => void loadInstallations(instPage, instPageSize));
  }, [loadInstallations, instPage, instPageSize]);

  // The endpoints return a page, not a total — allow "next page" exactly
  // when the current page came back full.
  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );
  const instTotal = useMemo(
    () =>
      (instPage - 1) * instPageSize +
      instRows.length +
      (instRows.length === instPageSize ? 1 : 0),
    [instPage, instPageSize, instRows.length],
  );

  const openCreate = () => {
    meterForm.resetFields();
    setIdemKey(newIdemKey());
    setMeterModal({ mode: 'create' });
  };
  const openEdit = (meter: Meter) => {
    meterForm.setFieldsValue({
      serialNo: meter.serialNo ?? undefined,
      barcode: meter.barcode ?? undefined,
      brand: meter.brand ?? undefined,
      model: meter.model ?? undefined,
      caliber: meter.caliber ?? undefined,
      maxDial: meter.maxDial ?? undefined,
      status: meter.status,
    });
    setMeterModal({ mode: 'edit', meter });
  };

  const submitMeter = async () => {
    let values: MeterFormValues;
    try {
      values = await meterForm.validateFields();
    } catch {
      return; // inline field errors are already shown
    }
    setSaving(true);
    try {
      if (meterModal?.mode === 'create') {
        await api.post('/meters', cleanBody({ ...values }), {
          headers: { 'Idempotency-Key': idemKey },
        });
        message.success('水表已登记');
      } else if (meterModal?.mode === 'edit') {
        // meterNo 不在 PATCH 字段内 —— 只提交设备字段与状态。
        await api.patch(
          `/meters/${meterModal.meter.id}`,
          cleanPatch({
            serialNo: values.serialNo,
            barcode: values.barcode,
            brand: values.brand,
            model: values.model,
            caliber: values.caliber,
            maxDial: values.maxDial,
            status: values.status,
          }),
        );
        message.success('水表已更新');
      }
      setMeterModal(null);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const submitInstall = async () => {
    let values: InstallFormValues;
    try {
      values = await installForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      await api.post(
        '/meter-installations',
        cleanBody({
          waterAccountId: values.waterAccountId,
          meterId: values.meterId,
          initialReading: values.initialReading,
          installedAt: values.installedAt?.format('YYYY-MM-DD'),
          reason: values.reason,
        }),
        { headers: { 'Idempotency-Key': idemKey } },
      );
      message.success('装表完成');
      setInstallOpen(false);
      await Promise.all([load(page, pageSize), loadInstallations(instPage, instPageSize)]);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const submitRemove = async () => {
    let values: RemoveFormValues;
    try {
      values = await removeForm.validateFields();
    } catch {
      return;
    }
    if (!removeTarget) return;
    setSaving(true);
    try {
      await api.post(
        `/meter-installations/${removeTarget.id}/remove`,
        cleanBody({
          finalReading: values.finalReading,
          removedAt: values.removedAt?.format('YYYY-MM-DD'),
        }),
        { headers: { 'Idempotency-Key': idemKey } },
      );
      message.success('拆表完成');
      setRemoveTarget(null);
      await Promise.all([load(page, pageSize), loadInstallations(instPage, instPageSize)]);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 换表 — 单事务原子操作：旧表止码与新表始码是两块不同物理表盘，
   * 两个读数完全独立（服务端不会默认/强制相等）。
   */
  const submitReplace = async () => {
    let values: ReplaceFormValues;
    try {
      values = await replaceForm.validateFields();
    } catch {
      return;
    }
    if (!replaceTarget) return;
    setSaving(true);
    try {
      await api.post<ReplaceResult>(
        `/meter-installations/${replaceTarget.id}/replace`,
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
      setReplaceTarget(null);
      await Promise.all([load(page, pageSize), loadInstallations(instPage, instPageSize)]);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const openDetail = useCallback(
    async (meterId: string) => {
      setDetailMeterId(meterId);
      setDetail(null);
      setDetailLoading(true);
      try {
        const res = await api.get<MeterDetail>(`/meters/${meterId}`);
        setDetail(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
        setDetailMeterId(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [message],
  );

  const meterColumns: ColumnsType<Meter> = [
    { title: '表号', dataIndex: 'meterNo', key: 'meterNo', width: 150 },
    {
      title: '出厂编号',
      dataIndex: 'serialNo',
      key: 'serialNo',
      width: 130,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '品牌/型号',
      key: 'brandModel',
      width: 150,
      render: (_: unknown, r: Meter) =>
        [r.brand, r.model].filter(Boolean).join(' ') || '—',
    },
    {
      title: '口径',
      dataIndex: 'caliber',
      key: 'caliber',
      width: 90,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '最大读数',
      dataIndex: 'maxDial',
      key: 'maxDial',
      width: 100,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: MeterStatus) => <MeterStatusTag status={s} />,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: fmtTime,
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_: unknown, record: Meter) => (
        <Space size="small">
          {canWrite && (
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEdit(record)}
            >
              编辑
            </Button>
          )}
          <Button
            size="small"
            icon={<ToolOutlined />}
            onClick={() => {
              setInstMeter({ id: record.id, meterNo: record.meterNo });
              setInstPage(1);
              instCardRef.current?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            装拆记录
          </Button>
          <Button size="small" onClick={() => void openDetail(record.id)}>
            详情
          </Button>
        </Space>
      ),
    },
  ];

  const instColumns: ColumnsType<MeterInstallation> = [
    {
      title: '用水户',
      key: 'account',
      width: 150,
      render: (_: unknown, r: MeterInstallation) => r.waterAccount.accountNo,
    },
    {
      title: '表号',
      key: 'meter',
      width: 140,
      render: (_: unknown, r: MeterInstallation) => r.meter.meterNo,
    },
    {
      title: '装表时间',
      dataIndex: 'installedAt',
      key: 'installedAt',
      width: 120,
      render: (v: string) => fmtDate(v),
    },
    {
      title: '拆表时间',
      dataIndex: 'removedAt',
      key: 'removedAt',
      width: 120,
      render: (v: string | null) => fmtDate(v),
    },
    {
      title: '初始读数',
      dataIndex: 'initialReading',
      key: 'initialReading',
      width: 100,
    },
    {
      title: '拆除读数',
      dataIndex: 'finalReading',
      key: 'finalReading',
      width: 100,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '原因',
      dataIndex: 'reason',
      key: 'reason',
      width: 90,
      render: (r: InstallReason) => INSTALL_REASON_LABELS[r],
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: InstallationStatus) => <InstallationStatusTag status={s} />,
    },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 150,
            render: (_: unknown, record: MeterInstallation) =>
              record.status === 'ACTIVE' ? (
                <Space size={4}>
                  <Button
                    size="small"
                    icon={<SwapOutlined />}
                    onClick={() => {
                      replaceForm.resetFields();
                      replaceForm.setFieldValue('reason', 'REPLACE');
                      setIdemKey(newIdemKey());
                      setReplaceTarget(record);
                    }}
                  >
                    更换
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => {
                      removeForm.resetFields();
                      setIdemKey(newIdemKey());
                      setRemoveTarget(record);
                    }}
                  >
                    拆除
                  </Button>
                </Space>
              ) : null,
          } satisfies ColumnsType<MeterInstallation>[number],
        ]
      : []),
  ];

  const editTransitions =
    meterModal?.mode === 'edit' ? PATCH_TRANSITIONS[meterModal.meter.status] : [];

  return (
    <>
      <Card
        title="水表管理"
        extra={
          <Space wrap>
            <Select
              allowClear
              placeholder="按状态筛选"
              style={{ width: 130 }}
              options={(
                ['AVAILABLE', 'INSTALLED', 'MAINTENANCE', 'RETIRED'] as const
              ).map((s) => ({ value: s, label: METER_STATUS_LABELS[s] }))}
              value={statusFilter}
              onChange={(v) => {
                setStatusFilter(v);
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
                登记水表
              </Button>
            )}
          </Space>
        }
      >
        <Table<Meter>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={meterColumns}
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
      </Card>

      <div ref={instCardRef} style={{ marginTop: 16 }}>
        <Card
          title="装拆记录"
          extra={
            <Space wrap>
              {instMeter && (
                <Tag
                  closable
                  color="blue"
                  onClose={() => {
                    setInstMeter(null);
                    setInstPage(1);
                  }}
                >
                  水表：{instMeter.meterNo}
                </Tag>
              )}
              <Select
                allowClear
                placeholder="按状态筛选"
                style={{ width: 120 }}
                options={(['ACTIVE', 'REMOVED'] as const).map((s) => ({
                  value: s,
                  label: INSTALLATION_STATUS_LABELS[s],
                }))}
                value={instStatus}
                onChange={(v) => {
                  setInstStatus(v);
                  setInstPage(1);
                }}
              />
              <span style={{ width: 180, display: 'inline-block' }}>
                <CustomerSelect
                  value={instCustomerId}
                  onChange={(v) => {
                    setInstCustomerId(v);
                    setInstAccountId(undefined);
                  }}
                  placeholder="先选客户"
                />
              </span>
              <span style={{ width: 220, display: 'inline-block' }}>
                <WaterAccountSelect
                  customerId={instCustomerId}
                  value={instAccountId}
                  onChange={(v) => {
                    setInstAccountId(v);
                    setInstPage(1);
                  }}
                  placeholder="按用水户过滤"
                />
              </span>
              <Button
                icon={<ReloadOutlined />}
                onClick={() => void loadInstallations(instPage, instPageSize)}
              >
                刷新
              </Button>
              {canWrite && (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    installForm.resetFields();
                    setIdemKey(newIdemKey());
                    setInstallOpen(true);
                  }}
                >
                  装表
                </Button>
              )}
            </Space>
          }
        >
          <Table<MeterInstallation>
            rowKey="id"
            size="middle"
            loading={instLoading}
            columns={instColumns}
            dataSource={instRows}
            pagination={{
              current: instPage,
              pageSize: instPageSize,
              total: instTotal,
              showSizeChanger: true,
              onChange: (p, size) => {
                setInstPage(p);
                setInstPageSize(size);
              },
            }}
          />
        </Card>
      </div>

      {/* 登记 / 编辑水表 */}
      <Modal
        open={meterModal !== null}
        title={meterModal?.mode === 'create' ? '登记水表' : '编辑水表'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitMeter()}
        onCancel={() => setMeterModal(null)}
        destroyOnHidden
      >
        <Form form={meterForm} layout="vertical">
          {meterModal?.mode === 'create' && (
            <Form.Item name="meterNo" label="表号" extra="留空则由系统自动生成">
              <Input placeholder="如 M202501000001" />
            </Form.Item>
          )}
          <Form.Item name="serialNo" label="出厂编号">
            <Input />
          </Form.Item>
          <Form.Item name="barcode" label="条码">
            <Input />
          </Form.Item>
          <Form.Item name="brand" label="品牌">
            <Input />
          </Form.Item>
          <Form.Item name="model" label="型号">
            <Input />
          </Form.Item>
          <Form.Item name="caliber" label="口径">
            <Input placeholder="如 DN15" />
          </Form.Item>
          <Form.Item
            name="maxDial"
            label="最大读数（表位）"
            rules={[DECIMAL_RULE]}
          >
            <Input placeholder="如 99999" />
          </Form.Item>
          {meterModal?.mode === 'edit' && editTransitions.length > 0 && (
            <Form.Item name="status" label="状态">
              <Select
                options={[meterModal.meter.status, ...editTransitions].map(
                  (s) => ({ value: s, label: METER_STATUS_LABELS[s] }),
                )}
              />
            </Form.Item>
          )}
          {meterModal?.mode === 'edit' && meterModal.meter.status === 'INSTALLED' && (
            <Alert
              type="info"
              showIcon
              message="已安装水表须先拆表才能变更状态（走装拆记录，不在此处流转）。"
            />
          )}
        </Form>
      </Modal>

      {/* 装表 */}
      <Modal
        open={installOpen}
        title="装表"
        okText="确认装表"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitInstall()}
        onCancel={() => setInstallOpen(false)}
        destroyOnHidden
      >
        <Form
          form={installForm}
          layout="vertical"
          onValuesChange={(changed: Partial<InstallFormValues>) => {
            if ('customerId' in changed) {
              installForm.setFieldValue('waterAccountId', undefined);
            }
          }}
        >
          <Form.Item name="customerId" label="客户（用于筛选用水户）">
            <CustomerSelect />
          </Form.Item>
          <Form.Item
            name="waterAccountId"
            label="用水户"
            rules={[{ required: true, message: '请选择用水户' }]}
          >
            <WaterAccountSelect customerId={installCustomerId} />
          </Form.Item>
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
            <Select allowClear options={REASON_OPTIONS} placeholder="默认新装" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 拆表 */}
      <Modal
        open={removeTarget !== null}
        title={removeTarget ? `拆表 — ${removeTarget.meter.meterNo}` : ''}
        okText="确认拆除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitRemove()}
        onCancel={() => setRemoveTarget(null)}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="拆表后安装记录转为已拆除，水表回到可用状态。"
          description={
            removeTarget
              ? `拆除读数须不小于装表初始读数（${removeTarget.initialReading}）。`
              : undefined
          }
        />
        <Form form={removeForm} layout="vertical">
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

      {/* 换表 — 原子操作：旧表止码 + 新表始码各自独立填写 */}
      <Modal
        open={replaceTarget !== null}
        title={
          replaceTarget
            ? `换表 — ${replaceTarget.meter.meterNo}（用水户 ${replaceTarget.waterAccount.accountNo}）`
            : ''
        }
        okText="确认换表"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitReplace()}
        onCancel={() => setReplaceTarget(null)}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="换表为单事务操作：旧表按止码拆除、新表按始码挂装，两块物理表盘读数互相独立。"
          description={
            replaceTarget
              ? `旧表装表始码 ${replaceTarget.initialReading}；远传设备绑定不会自动迁移，新表需重新绑定。`
              : undefined
          }
        />
        <Form form={replaceForm} layout="vertical">
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
            <Input placeholder="旧表机械字轮读数" />
          </Form.Item>
          <Form.Item
            name="newInitialReading"
            label="新表始码"
            rules={[{ required: true, message: '请输入新表始码' }, DECIMAL_RULE]}
            extra="新表自身表盘读数，通常不等于旧表止码"
          >
            <Input placeholder="如 0" />
          </Form.Item>
          <Form.Item name="replacedAt" label="换表日期">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reason" label="换表原因">
            <Select allowClear options={REPLACE_REASON_OPTIONS} placeholder="默认换表" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 水表详情抽屉：档案字段 + 安装史（按调用者数据范围过滤） */}
      <Drawer
        open={detailMeterId !== null}
        title={detail ? `水表详情 — ${detail.meterNo}` : '水表详情'}
        width={720}
        onClose={() => setDetailMeterId(null)}
        loading={detailLoading}
      >
        {detail && (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="表号">{detail.meterNo}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <MeterStatusTag status={detail.status} />
              </Descriptions.Item>
              <Descriptions.Item label="出厂编号">
                {detail.serialNo ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="条码">
                {detail.barcode ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="品牌/型号">
                {[detail.brand, detail.model].filter(Boolean).join(' ') || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="口径">
                {detail.caliber ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="最大读数">
                {detail.maxDial ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="前任表">
                {detail.parentMeterId ?? '—'}
              </Descriptions.Item>
            </Descriptions>
            <Card
              size="small"
              title="安装历史"
              style={{ marginTop: 16 }}
            >
              <Table
                rowKey="id"
                size="small"
                dataSource={detail.installations}
                pagination={false}
                columns={[
                  {
                    title: '用水户',
                    key: 'acct',
                    render: (_: unknown, r: MeterDetail['installations'][number]) =>
                      r.waterAccount.accountNo,
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
                    render: (s: InstallationStatus) => (
                      <InstallationStatusTag status={s} />
                    ),
                  },
                ]}
              />
            </Card>
          </>
        )}
      </Drawer>
    </>
  );
}
