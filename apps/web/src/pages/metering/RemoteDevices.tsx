import { EditOutlined, LinkOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, apiErrorText } from '../../api/client';
import type {
  MeterInstallation,
  RemoteDevice,
  RemoteDeviceBinding,
  RemoteDeviceDetail,
  RemoteSource,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { cleanBody, fmtTime, newIdemKey } from '../common';

interface DeviceFormValues {
  vendorDeviceKey: string;
  vendorMeterNo?: string;
  communicationId?: string;
  model?: string;
  status?: 'ACTIVE' | 'DISABLED';
}

interface BindingFormValues {
  installationId: string;
  range: [Dayjs, Dayjs | null];
}

/** 安装位置选择器 —— 取一页在用安装记录本地过滤。 */
function InstallationSelect({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (v: string | undefined) => void;
}) {
  const { message } = AntdApp.useApp();
  const [opts, setOpts] = useState<MeterInstallation[]>([]);
  useEffect(() => {
    api
      .get<MeterInstallation[]>('/meter-installations', { params: { take: 200 } })
      .then((r) => setOpts(r.data))
      .catch((err) => message.error(apiErrorText(err)));
  }, [message]);
  return (
    <Select
      showSearch
      allowClear
      value={value}
      onChange={onChange}
      placeholder="选择安装位置（表号 / 户号过滤）"
      optionFilterProp="label"
      options={opts.map((i) => ({
        value: i.id,
        label: `${i.meter.meterNo} · 户 ${i.waterAccount.accountNo} · ${i.status === 'ACTIVE' ? '在用' : '已拆'}`,
      }))}
    />
  );
}

/**
 * 远传设备（E5）— vendor 侧设备身份 + 生效区间绑定管理。
 * URL ?sourceId= 过滤到单个数据源。
 */
export default function RemoteDevices() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canManage = hasPerm('metering:remote:manage');
  const [params] = useSearchParams();
  const sourceIdFilter = params.get('sourceId') ?? undefined;

  const [sources, setSources] = useState<RemoteSource[]>([]);
  const [sourceId, setSourceId] = useState<string | undefined>(sourceIdFilter);
  const [rows, setRows] = useState<RemoteDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [modal, setModal] = useState<{ kind: 'create' } | { kind: 'edit'; row: RemoteDevice } | null>(null);
  const [idemKey, setIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<DeviceFormValues>();

  const [detail, setDetail] = useState<RemoteDeviceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [bindModal, setBindModal] = useState(false);
  const [bindSaving, setBindSaving] = useState(false);
  const [bindForm] = Form.useForm<BindingFormValues>();

  const sourceName = useCallback(
    (id: string) => sources.find((s) => s.id === id)?.name ?? `${id.slice(0, 8)}…`,
    [sources],
  );

  useEffect(() => {
    api
      .get<RemoteSource[]>('/remote-sources', { params: { take: 200 } })
      .then((r) => setSources(r.data))
      .catch(() => setSources([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<RemoteDevice[]>('/remote-devices', {
        params: {
          take: pageSize,
          skip: (page - 1) * pageSize,
          ...(sourceId ? { remoteSourceId: sourceId } : {}),
          ...(q.trim() ? { q: q.trim() } : {}),
        },
      });
      setRows(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, sourceId, q, message]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await api.get<RemoteDeviceDetail>(`/remote-devices/${id}`);
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const openCreate = () => {
    form.resetFields();
    setIdemKey(newIdemKey());
    setModal({ kind: 'create' });
  };

  const openEdit = (row: RemoteDevice) => {
    form.setFieldsValue({
      vendorDeviceKey: row.vendorDeviceKey,
      vendorMeterNo: row.vendorMeterNo ?? undefined,
      communicationId: row.communicationId ?? undefined,
      model: row.model ?? undefined,
      status: row.status,
    });
    setModal({ kind: 'edit', row });
  };

  const submit = async () => {
    let values: DeviceFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (modal?.kind === 'create') {
        if (!sourceId) {
          message.error('请先选择数据源');
          return;
        }
        await api.post(
          '/remote-devices',
          cleanBody({
            remoteSourceId: sourceId,
            vendorDeviceKey: values.vendorDeviceKey,
            vendorMeterNo: values.vendorMeterNo,
            communicationId: values.communicationId,
            model: values.model,
          }),
          { headers: { 'Idempotency-Key': idemKey } },
        );
        message.success('设备已登记');
      } else if (modal?.kind === 'edit') {
        await api.patch(
          `/remote-devices/${modal.row.id}`,
          cleanBody({
            vendorMeterNo: values.vendorMeterNo ?? null,
            communicationId: values.communicationId ?? null,
            model: values.model ?? null,
            status: values.status,
          }),
        );
        message.success('设备已更新');
      }
      setModal(null);
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const submitBinding = async () => {
    let values: BindingFormValues;
    try {
      values = await bindForm.validateFields();
    } catch {
      return;
    }
    if (!detail) return;
    setBindSaving(true);
    try {
      await api.post(
        `/remote-devices/${detail.id}/bindings`,
        cleanBody({
          installationId: values.installationId,
          effectiveFrom: values.range[0].toISOString(),
          effectiveTo: values.range[1] ? values.range[1].toISOString() : undefined,
        }),
      );
      message.success('绑定已创建');
      setBindModal(false);
      bindForm.resetFields();
      void openDetail(detail.id);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setBindSaving(false);
    }
  };

  const closeBinding = async (b: RemoteDeviceBinding) => {
    if (!detail) return;
    try {
      await api.patch(`/remote-device-bindings/${b.id}`, {
        effectiveTo: dayjs().toISOString(),
      });
      message.success('绑定已关闭');
      void openDetail(detail.id);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const bindingCols: ColumnsType<RemoteDeviceBinding> = useMemo(
    () => [
      {
        title: '安装位置',
        key: 'inst',
        render: (_, b) =>
          b.installation
            ? `${b.installation.meter.meterNo} · 户 ${b.installation.waterAccount.accountNo}`
            : b.installationId.slice(0, 8),
      },
      { title: '生效自', dataIndex: 'effectiveFrom', width: 170, render: fmtTime },
      {
        title: '生效至',
        dataIndex: 'effectiveTo',
        width: 170,
        render: (v: string | null) => (v ? fmtTime(v) : <Tag color="green">当前</Tag>),
      },
      ...(canManage
        ? [
            {
              title: '操作',
              key: 'ops',
              width: 110,
              render: (_: unknown, b: RemoteDeviceBinding) =>
                b.effectiveTo === null && (
                  <Popconfirm
                    title="立即关闭此绑定？"
                    description="生效至 = 当前时间，此后事件不再路由到该安装位置。"
                    onConfirm={() => void closeBinding(b)}
                  >
                    <Button size="small" danger>
                      关闭
                    </Button>
                  </Popconfirm>
                ),
            },
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canManage, detail?.id],
  );

  const columns: ColumnsType<RemoteDevice> = [
    { title: '厂商设备 Key', dataIndex: 'vendorDeviceKey', width: 200 },
    { title: '厂商表号', dataIndex: 'vendorMeterNo', width: 130, render: (v) => v ?? '—' },
    { title: '通信 ID', dataIndex: 'communicationId', width: 160, render: (v) => v ?? '—' },
    { title: '型号', dataIndex: 'model', width: 110, render: (v) => v ?? '—' },
    {
      title: '数据源',
      dataIndex: 'remoteSourceId',
      width: 150,
      render: sourceName,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (s: string) => (s === 'ACTIVE' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: '操作',
      key: 'ops',
      width: 180,
      render: (_, row) => (
        <Space size="small">
          <Button size="small" icon={<LinkOutlined />} onClick={() => void openDetail(row.id)}>
            绑定
          </Button>
          {canManage && <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="远传设备"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="数据源"
            style={{ width: 200 }}
            value={sourceId}
            onChange={(v) => {
              setSourceId(v);
              setPage(1);
            }}
            options={sources.map((s) => ({ value: s.id, label: `${s.code} ${s.name}` }))}
          />
          <Input.Search
            placeholder="设备 Key / 表号 / 通信 ID"
            allowClear
            style={{ width: 240 }}
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onSearch={(v) => {
              setQ(v);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()} />
          {canManage && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!sourceId}>
              登记设备
            </Button>
          )}
        </Space>
      }
    >
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={{
          current: page,
          pageSize,
          total: (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
          onChange: (p, s) => {
            setPage(p);
            setPageSize(s);
          },
          showSizeChanger: true,
        }}
      />

      <Modal
        title={modal?.kind === 'edit' ? '编辑设备' : '登记设备'}
        open={modal !== null}
        onCancel={() => setModal(null)}
        onOk={() => void submit()}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="vendorDeviceKey" label="厂商设备 Key" rules={[{ required: true }]}>
            <Input disabled={modal?.kind === 'edit'} placeholder="IMEI / ICCID / DevEUI / 集中器通道" />
          </Form.Item>
          <Form.Item name="vendorMeterNo" label="厂商表号（可选）">
            <Input />
          </Form.Item>
          <Form.Item name="communicationId" label="通信 ID（可选）">
            <Input />
          </Form.Item>
          <Form.Item name="model" label="型号（可选）">
            <Input />
          </Form.Item>
          {modal?.kind === 'edit' && (
            <Form.Item name="status" label="状态">
              <Select
                options={[
                  { value: 'ACTIVE', label: '启用' },
                  { value: 'DISABLED', label: '停用' },
                ]}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Drawer
        title={`设备 ${detail?.vendorDeviceKey ?? ''} — 绑定历史`}
        open={detail !== null}
        onClose={() => setDetail(null)}
        width={720}
        loading={detailLoading}
      >
        {detail && (
          <>
            <Descriptions size="small" column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="数据源">{sourceName(detail.remoteSourceId)}</Descriptions.Item>
              <Descriptions.Item label="厂商表号">{detail.vendorMeterNo ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="通信 ID">{detail.communicationId ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="型号">{detail.model ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="登记时间">{fmtTime(detail.createdAt)}</Descriptions.Item>
            </Descriptions>
            <Table
              rowKey="id"
              size="small"
              columns={bindingCols}
              dataSource={detail.bindings}
              pagination={false}
            />
            {canManage && (
              <Button
                style={{ marginTop: 12 }}
                icon={<PlusOutlined />}
                onClick={() => setBindModal(true)}
              >
                新增绑定
              </Button>
            )}
          </>
        )}
        <Modal
          title="新增生效区间绑定"
          open={bindModal}
          onCancel={() => setBindModal(false)}
          onOk={() => void submitBinding()}
          confirmLoading={bindSaving}
          destroyOnHidden
        >
          <Form form={bindForm} layout="vertical">
            <Form.Item name="installationId" label="安装位置" rules={[{ required: true }]}>
              <InstallationSelect />
            </Form.Item>
            <Form.Item
              name="range"
              label="生效区间 [from, to) — 结束留空表示当前"
              rules={[{ required: true }]}
            >
              <DatePicker.RangePicker showTime allowEmpty={[false, true]} style={{ width: '100%' }} />
            </Form.Item>
          </Form>
        </Modal>
      </Drawer>
    </Card>
  );
}
