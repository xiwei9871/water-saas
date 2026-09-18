import {
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  ToolOutlined,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  InstallReason,
  InstallationStatus,
  Meter,
  MeterInstallation,
  MeterStatus,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  DECIMAL_RULE,
  INSTALLATION_STATUS_LABELS,
  INSTALL_REASON_LABELS,
  METER_STATUS_LABELS,
  cleanBody,
  fmtDate,
  fmtTime,
  newIdemKey,
} from './common';
import {
  CustomerSelect,
  InstallationStatusTag,
  MeterSelect,
  MeterStatusTag,
  WaterAccountSelect,
} from './pickers';

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
  customerId?: string; // 仅用于级联过滤水表户，不提交
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

const REASON_OPTIONS = (
  ['NEW', 'REPLACE', 'FAULT', 'PERIODIC_CHECK'] as const
).map((r) => ({ value: r, label: INSTALL_REASON_LABELS[r] }));

/** 水表档案：设备台账（含受限状态流转）+ 装拆记录（装表/拆表）。 */
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
  const [installForm] = Form.useForm<InstallFormValues>();
  const [removeForm] = Form.useForm<RemoveFormValues>();
  const installCustomerId = Form.useWatch('customerId', installForm);

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
          cleanBody({
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
        </Space>
      ),
    },
  ];

  const instColumns: ColumnsType<MeterInstallation> = [
    {
      title: '水表户',
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
            width: 90,
            render: (_: unknown, record: MeterInstallation) =>
              record.status === 'ACTIVE' ? (
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
        title="水表档案"
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
                  placeholder="按水表户过滤"
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
          <Form.Item name="customerId" label="客户（用于筛选水表户）">
            <CustomerSelect />
          </Form.Item>
          <Form.Item
            name="waterAccountId"
            label="水表户"
            rules={[{ required: true, message: '请选择水表户' }]}
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
    </>
  );
}
