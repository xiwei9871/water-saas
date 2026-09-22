import {
  CloudUploadOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiErrorText } from '../../api/client';
import type {
  OrgUnit,
  RemoteImportReport,
  RemoteSource,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { cleanBody, newIdemKey } from '../common';
import { OrgUnitTreeSelect } from '../pickers';

interface SourceFormValues {
  code: string;
  name: string;
  type: 'FILE_IMPORT' | 'API_PULL' | 'WEBHOOK';
  adapterKey: string;
  timezone: string;
  orgUnitId?: string;
  credentialRef?: string;
  configText?: string;
  status?: 'ACTIVE' | 'DISABLED';
}

interface ImportFormValues {
  targetPeriod: string;
  fileName?: string;
}

const TYPE_LABELS: Record<string, string> = {
  FILE_IMPORT: '文件导入',
  API_PULL: 'API 拉取',
  WEBHOOK: 'Webhook 推送',
};

const PERIOD_RE = /^\d{6}$/;

const readFileText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsText(file, 'utf-8');
  });

const readFileBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

/**
 * 远传数据源（E5）— 厂商平台配置 + 文件导入入口。
 * 写操作需要 metering:remote:manage；组织字段需要 iam:read。
 */
export default function RemoteSources() {
  const { message } = AntdApp.useApp();
  const { user, hasPerm } = useAuth();
  const canManage = hasPerm('metering:remote:manage');
  const canIamRead = hasPerm('iam:read');
  const navigate = useNavigate();

  const [rows, setRows] = useState<RemoteSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [orgs, setOrgs] = useState<OrgUnit[]>([]);

  const [modal, setModal] = useState<{ kind: 'create' } | { kind: 'edit'; row: RemoteSource } | null>(null);
  const [idemKey, setIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<SourceFormValues>();

  const [importSource, setImportSource] = useState<RemoteSource | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<RemoteImportReport | null>(null);
  const [importForm] = Form.useForm<ImportFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<RemoteSource[]>('/remote-sources', {
        params: {
          take: pageSize,
          skip: (page - 1) * pageSize,
          ...(q.trim() ? { q: q.trim() } : {}),
        },
      });
      setRows(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, q, message]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  useEffect(() => {
    if (!canIamRead) return;
    api.get<OrgUnit[]>('/iam/orgs').then((r) => setOrgs(r.data)).catch(() => setOrgs([]));
  }, [canIamRead]);

  const orgName = useCallback(
    (id: string | null) =>
      id === null ? '全公司' : (orgs.find((o) => o.id === id)?.name ?? `${id.slice(0, 8)}…`),
    [orgs],
  );

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({
      type: 'FILE_IMPORT',
      adapterKey: 'file-csv',
      timezone: 'Asia/Shanghai',
      orgUnitId: user?.orgUnitId,
      configText: JSON.stringify(
        {
          deviceKeyColumn: '表号',
          readingColumn: '当前读数',
          collectedAtColumn: '采集时间',
          eventIdColumn: '流水号',
          qualityColumn: '状态',
        },
        null,
        2,
      ),
    });
    setIdemKey(newIdemKey());
    setModal({ kind: 'create' });
  };

  const openEdit = (row: RemoteSource) => {
    form.setFieldsValue({
      code: row.code,
      name: row.name,
      type: row.type,
      adapterKey: row.adapterKey,
      timezone: row.timezone,
      orgUnitId: row.orgUnitId ?? undefined,
      credentialRef: row.credentialRef ?? undefined,
      status: row.status,
      configText: row.config ? JSON.stringify(row.config, null, 2) : undefined,
    });
    setIdemKey(newIdemKey());
    setModal({ kind: 'edit', row });
  };

  const submit = async () => {
    let values: SourceFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    let config: Record<string, unknown> | undefined;
    if (values.configText?.trim()) {
      try {
        config = JSON.parse(values.configText) as Record<string, unknown>;
      } catch {
        message.error('字段映射 JSON 格式错误');
        return;
      }
    }
    setSaving(true);
    try {
      if (modal?.kind === 'create') {
        await api.post(
          '/remote-sources',
          cleanBody({
            code: values.code,
            name: values.name,
            type: values.type,
            adapterKey: values.adapterKey,
            timezone: values.timezone,
            orgUnitId: values.orgUnitId,
            credentialRef: values.credentialRef,
            config,
          }),
          { headers: { 'Idempotency-Key': idemKey } },
        );
        message.success('数据源已创建');
      } else if (modal?.kind === 'edit') {
        await api.patch(
          `/remote-sources/${modal.row.id}`,
          cleanBody({
            name: values.name,
            status: values.status,
            timezone: values.timezone,
            orgUnitId: values.orgUnitId ?? null,
            credentialRef: values.credentialRef ?? null,
            config: config ?? null,
          }),
        );
        message.success('数据源已更新');
      }
      setModal(null);
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const doImport = async () => {
    let values: ImportFormValues;
    try {
      values = await importForm.validateFields();
    } catch {
      return;
    }
    if (!importFile || !importSource) {
      message.error('请选择文件');
      return;
    }
    setImporting(true);
    try {
      const isXlsx = importFile.name.toLowerCase().endsWith('.xlsx');
      const content = isXlsx ? await readFileBase64(importFile) : await readFileText(importFile);
      const res = await api.post<RemoteImportReport>(
        `/remote-sources/${importSource.id}/import`,
        {
          targetPeriod: values.targetPeriod,
          format: isXlsx ? 'xlsx' : 'csv',
          fileName: importFile.name,
          content,
        },
      );
      setReport(res.data);
      message.success(`导入完成：${res.data.parsed} 行入队`);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setImporting(false);
    }
  };

  const columns: ColumnsType<RemoteSource> = [
    { title: '编码', dataIndex: 'code', width: 140 },
    { title: '名称', dataIndex: 'name' },
    {
      title: '类型',
      dataIndex: 'type',
      width: 110,
      render: (t: string) => TYPE_LABELS[t] ?? t,
    },
    { title: 'Adapter', dataIndex: 'adapterKey', width: 110 },
    { title: '时区', dataIndex: 'timezone', width: 130 },
    {
      title: '组织',
      dataIndex: 'orgUnitId',
      width: 120,
      render: (id: string | null) => orgName(id),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (s: string) =>
        s === 'ACTIVE' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>,
    },
    {
      title: '操作',
      key: 'ops',
      width: 240,
      render: (_, row) => (
        <Space size="small" wrap>
          {canManage && (
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          )}
          <Button size="small" onClick={() => navigate(`/metering/remote-devices?sourceId=${row.id}`)}>
            设备
          </Button>
          <Button size="small" onClick={() => navigate(`/metering/remote-events?sourceId=${row.id}`)}>
            事件
          </Button>
          {canManage && row.type === 'FILE_IMPORT' && row.status === 'ACTIVE' && (
            <Button
              size="small"
              icon={<CloudUploadOutlined />}
              onClick={() => {
                setImportSource(row);
                setReport(null);
                setImportFile(null);
                importForm.resetFields();
              }}
            >
              导入
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="远传数据源"
      extra={
        <Space>
          <Input.Search
            placeholder="编码 / 名称"
            allowClear
            style={{ width: 220 }}
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onSearch={(v) => {
              setQ(v);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()} />
          {canManage && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建数据源
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
        title={modal?.kind === 'edit' ? `编辑数据源 ${modal.row.code}` : '新建数据源'}
        open={modal !== null}
        onCancel={() => setModal(null)}
        onOk={() => void submit()}
        confirmLoading={saving}
        width={620}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="code" label="编码" rules={[{ required: modal?.kind === 'create' }]}>
            <Input disabled={modal?.kind === 'edit'} placeholder="如 NB_CLOUD" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="如 宁波水表云平台" />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name="type" label="类型" rules={[{ required: true }]} style={{ width: '50%' }}>
              <Select
                disabled={modal?.kind === 'edit'}
                options={[
                  { value: 'FILE_IMPORT', label: '文件导入' },
                  { value: 'API_PULL', label: 'API 拉取' },
                  { value: 'WEBHOOK', label: 'Webhook 推送' },
                ]}
              />
            </Form.Item>
            <Form.Item name="adapterKey" label="Adapter Key" rules={[{ required: true }]} style={{ width: '50%' }}>
              <Input disabled={modal?.kind === 'edit'} placeholder="file-csv" />
            </Form.Item>
          </Space.Compact>
          <Space.Compact block>
            <Form.Item name="timezone" label="时区（IANA）" rules={[{ required: true }]} style={{ width: '50%' }}>
              <Input placeholder="Asia/Shanghai" />
            </Form.Item>
            <Form.Item name="orgUnitId" label="组织范围（留空=全公司）" style={{ width: '50%' }}>
              <OrgUnitTreeSelect disabled={!canIamRead} />
            </Form.Item>
          </Space.Compact>
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
          <Form.Item
            name="credentialRef"
            label="凭证引用（vault/env 引用，禁止明文）"
          >
            <Input placeholder="vault://nb-cloud/api-key" />
          </Form.Item>
          <Form.Item
            name="configText"
            label="文件列映射（JSON，文件导入需要）"
            tooltip="deviceKeyColumn / readingColumn / collectedAtColumn 必填；eventIdColumn / qualityColumn / periodColumn 可选"
          >
            <Input.TextArea rows={7} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`导入远传文件 — ${importSource?.name ?? ''}`}
        open={importSource !== null}
        onCancel={() => setImportSource(null)}
        footer={null}
        width={640}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="部分成功语义：坏行只进报告，不回滚好行；同一文件重复上传整批幂等重放，不产生新事件。"
        />
        <Form form={importForm} layout="vertical">
          <Form.Item
            name="targetPeriod"
            label="目标账期（YYYYMM）"
            rules={[
              { required: true, message: '必填' },
              { pattern: PERIOD_RE, message: '格式 YYYYMM' },
            ]}
          >
            <Input placeholder="202610" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item label="厂商导出文件（CSV / XLSX）" required>
            <Upload.Dragger
              maxCount={1}
              beforeUpload={(f) => {
                // Whole file travels inside a JSON body (xlsx→base64 inflates
                // ~4/3); API allows 10MB JSON, keep UI guard at 5MB.
                if (f.size > 5 * 1024 * 1024) {
                  message.error('文件超过 5MB，请先拆分后再导入');
                  return Upload.LIST_IGNORE;
                }
                setImportFile(f);
                return false;
              }}
              onRemove={() => setImportFile(null)}
            >
              <p>点击或拖拽上传 .csv / .xlsx</p>
            </Upload.Dragger>
          </Form.Item>
          <Button
            type="primary"
            loading={importing}
            disabled={!importFile}
            onClick={() => void doImport()}
          >
            开始导入
          </Button>
        </Form>
        {report && (
          <div style={{ marginTop: 16 }}>
            <Descriptions size="small" column={2} bordered title="导入报告">
              <Descriptions.Item label="总行数">{report.totalRows}</Descriptions.Item>
              <Descriptions.Item label="成功入队">{report.parsed}</Descriptions.Item>
              {Object.entries(report.counts).map(([k, v]) => (
                <Descriptions.Item key={k} label={k}>
                  {v}
                </Descriptions.Item>
              ))}
            </Descriptions>
            {report.invalid.length > 0 && (
              <Table
                size="small"
                style={{ marginTop: 12 }}
                rowKey="row"
                dataSource={report.invalid}
                pagination={false}
                columns={[
                  { title: '行', dataIndex: 'row', width: 60 },
                  { title: '错误码', dataIndex: 'code', width: 180 },
                  { title: '说明', dataIndex: 'error' },
                ]}
              />
            )}
            <Typography.Link onClick={() => navigate(`/metering/remote-events?sourceId=${importSource?.id}`)}>
              查看事件列表 →
            </Typography.Link>
          </div>
        )}
      </Modal>
    </Card>
  );
}
