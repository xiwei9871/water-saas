import {
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  EyeOutlined,
  ReloadOutlined,
  SearchOutlined,
  UploadOutlined,
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
  Spin,
  Table,
  Tag,
  Tooltip,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, apiErrorText, toApiError } from '../../api/client';
import type {
  ImportRowError,
  MeterReading,
  QcStatus,
  ReadResultType,
  Staff,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  DECIMAL_RULE,
  cleanBody,
  fmtDate,
  fmtPeriod,
  fmtTime,
  newIdemKey,
} from '../common';
import {
  EXCEPTION_CODE_LABELS,
  QC_STATUS_COLORS,
  QC_STATUS_LABELS,
  READ_SOURCE_LABELS,
  RESULT_TYPE_COLORS,
  RESULT_TYPE_LABELS,
} from './common';

type QcAction = 'pass' | 'reject' | 'review';

/** 服务端 QC 状态机：PENDING → 全部三动作；MANUAL_REVIEW → 通过/驳回。 */
const QC_ACTIONS_BY_STATUS: Record<QcStatus, QcAction[]> = {
  PENDING: ['pass', 'reject', 'review'],
  MANUAL_REVIEW: ['pass', 'reject'],
  PASSED: [],
  REJECTED: [],
};

const QC_ACTION_TEXT: Record<QcAction, { label: string; icon: ReactNode; danger?: boolean }> = {
  pass: { label: '通过', icon: <CheckOutlined /> },
  reject: { label: '驳回', icon: <CloseOutlined />, danger: true },
  review: { label: '复核', icon: <EyeOutlined /> },
};

interface SupersedeFormValues {
  readingValue: string;
  readDate?: dayjs.Dayjs;
}

const CSV_HINT = `plan_item_id,result_type,reading_value,exception_code[,read_date]
示例：
f47ac10b-58cc-4372-a567-0e02b2c3d479,ACTUAL,123.5,,
f47ac10b-58cc-4372-a567-0e02b2c3d480,NO_READ,,LOCKED,2026-10-05`;

/**
 * 抄表记录 / 质检：append-only 采集事实的查询 + QC 质检 + 更正（supersede
 * 追加新事实行）+ CSV 批量导入（all-or-nothing，失败行报告内嵌展示）。
 */
export default function MeterReadings() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('metering:write');
  const canQc = canWrite || hasPerm('metering:qc');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const canIamRead = hasPerm('iam:read');

  const [rows, setRows] = useState<MeterReading[]>([]);
  const [loading, setLoading] = useState(false);
  // Draft input vs committed filter — the ids go through assertUuid
  // server-side, so committing on 搜索/回车 avoids a 400-toast per keystroke.
  const [planItemInput, setPlanItemInput] = useState('');
  const [installationInput, setInstallationInput] = useState('');
  const [planItemId, setPlanItemId] = useState('');
  const [installationId, setInstallationId] = useState('');
  const [period, setPeriod] = useState<dayjs.Dayjs | null>(null);
  const [resultType, setResultType] = useState<ReadResultType | undefined>(undefined);
  const [qcStatus, setQcStatus] = useState<QcStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [staff, setStaff] = useState<Staff[]>([]);
  const [acting, setActing] = useState<string | null>(null);

  const [supersedeTarget, setSupersedeTarget] = useState<MeterReading | null>(null);
  const [supersedeIdemKey, setSupersedeIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [supersedeForm] = Form.useForm<SupersedeFormValues>();

  const [importOpen, setImportOpen] = useState(false);
  const [importIdemKey, setImportIdemKey] = useState('');
  const [importSaving, setImportSaving] = useState(false);
  const [importForm] = Form.useForm<{ csv: string }>();
  const [failedRows, setFailedRows] = useState<ImportRowError[]>([]);

  const [detail, setDetail] = useState<MeterReading | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<MeterReading[]>('/meter-readings', {
          params: {
            take: size,
            ...(query ? { q: query } : {}),
            skip: (p - 1) * size,
            ...(planItemId.trim() ? { planItemId: planItemId.trim() } : {}),
            ...(installationId.trim()
              ? { installationId: installationId.trim() }
              : {}),
            ...(period ? { period: period.format('YYYYMM') } : {}),
            ...(resultType ? { resultType } : {}),
            ...(qcStatus ? { qcStatus } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [installationId, message, period, planItemId, qcStatus, resultType, query],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  useEffect(() => {
    if (!canIamRead) return;
    api
      .get<Staff[]>('/iam/staff')
      .then((res) => setStaff(res.data))
      .catch(() => setStaff([]));
  }, [canIamRead]);

  const staffName = useCallback(
    (id: string | null) => {
      if (!id) return '—';
      const s = staff.find((x) => x.id === id);
      return s ? s.name : `${id.slice(0, 8)}…`;
    },
    [staff],
  );

  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const openDetail = async (reading: MeterReading) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api.get<MeterReading>(`/meter-readings/${reading.id}`);
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const qc = async (reading: MeterReading, action: QcAction) => {
    setActing(reading.id);
    try {
      await api.post(
        `/meter-readings/${reading.id}/qc`,
        { action },
        { headers: { 'Idempotency-Key': newIdemKey() } },
      );
      message.success(`质检已${QC_ACTION_TEXT[action].label}`);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
      await load(page, pageSize);
    } finally {
      setActing(null);
    }
  };

  const submitSupersede = async () => {
    let values: SupersedeFormValues;
    try {
      values = await supersedeForm.validateFields();
    } catch {
      return;
    }
    if (!supersedeTarget) return;
    setSaving(true);
    try {
      await api.post(
        `/meter-readings/${supersedeTarget.id}/supersede`,
        cleanBody({
          readingValue: values.readingValue,
          readDate: values.readDate?.format('YYYY-MM-DD'),
        }),
        { headers: { 'Idempotency-Key': supersedeIdemKey } },
      );
      message.success('更正读数已生成（原记录保留为历史）');
      setSupersedeTarget(null);
      await load(page, pageSize);
    } catch (err) {
      // ALREADY_SUPERSEDED / NOT_SUPERSEDABLE 等直接透出。
      message.error(apiErrorText(err));
      await load(page, pageSize);
    } finally {
      setSaving(false);
    }
  };

  const submitImport = async () => {
    let values: { csv: string };
    try {
      values = await importForm.validateFields();
    } catch {
      return;
    }
    setImportSaving(true);
    setFailedRows([]);
    try {
      const res = await api.post<{ created: number }>(
        '/meter-readings/import',
        { csv: values.csv },
        { headers: { 'Idempotency-Key': importIdemKey } },
      );
      message.success(`已导入 ${res.data.created} 条抄表记录`);
      setImportOpen(false);
      await load(page, pageSize);
    } catch (err) {
      const e = toApiError(err);
      if (e.code === 'IMPORT_VALIDATION_FAILED') {
        const failed = (e.body as { failed?: ImportRowError[] } | undefined)?.failed;
        setFailedRows(Array.isArray(failed) ? failed : []);
      }
      message.error(apiErrorText(e));
    } finally {
      setImportSaving(false);
    }
  };

  const columns: ColumnsType<MeterReading> = [
    { title: '户号', key: 'account', width: 165, render: (_, r) => r.account?.accountNo ?? '—' },
    { title: '客户', key: 'customer', width: 190, render: (_, r) => r.account?.customerName ?? '—' },
    { title: '用水地址', key: 'addr', width: 220, render: (_, r) => r.account?.addr ?? '—' },
    {
      title: '账期',
      dataIndex: 'period',
      key: 'period',
      width: 90,
      render: fmtPeriod,
    },
    {
      title: '抄表日期',
      dataIndex: 'readDate',
      key: 'readDate',
      width: 105,
      render: (v: string) => fmtDate(v),
    },
    {
      title: '结果',
      dataIndex: 'resultType',
      key: 'resultType',
      width: 90,
      render: (t: ReadResultType) => (
        <Tag color={RESULT_TYPE_COLORS[t]}>{RESULT_TYPE_LABELS[t]}</Tag>
      ),
    },
    {
      title: '读数 / 异常',
      key: 'value',
      width: 150,
      render: (_: unknown, r: MeterReading) =>
        r.resultType === 'NO_READ' ? (
          <Space size={4}>
            <Tag color="orange">
              {r.exceptionCode ? EXCEPTION_CODE_LABELS[r.exceptionCode] : r.exceptionCode}
            </Tag>
            {r.estimateQty != null && (
              <Tooltip title="抄表员预计用量，非表码">
                <Tag color="cyan">估 {r.estimateQty} m³</Tag>
              </Tooltip>
            )}
          </Space>
        ) : (
          (r.readingValue ?? '—')
        ),
    },
    {
      title: '质检',
      key: 'qc',
      width: 100,
      render: (_: unknown, r: MeterReading) => (
        <Tooltip
          title={r.qcAt ? `质检人 ${(r.qcByName ?? staffName(r.qcBy))} · ${fmtTime(r.qcAt)}` : undefined}
        >
          <Tag color={QC_STATUS_COLORS[r.qcStatus]}>{QC_STATUS_LABELS[r.qcStatus]}</Tag>
        </Tooltip>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 90,
      render: (s: MeterReading['source']) => <Tag>{READ_SOURCE_LABELS[s]}</Tag>,
    },
    {
      title: '更正链',
      key: 'supersede',
      width: 120,
      render: (_: unknown, r: MeterReading) => (
        <Space size={2} wrap>
          {r.supersedesReadingId && (
            <Tooltip title={`更正自 ${r.supersedesReadingId}`}>
              <Tag color="blue">更正记录</Tag>
            </Tooltip>
          )}
          {r.supersededById && (
            <Tooltip title={`被 ${r.supersededById} 更正`}>
              <Tag color="default">已被更正</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '抄表人',
      dataIndex: 'operatorId',
      key: 'operatorId',
      width: 100,
      render: (_: unknown, r: MeterReading) => r.operatorName ?? staffName(r.operatorId),
    },
    {
      title: '录入时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 165,
      render: fmtTime,
    },
    {
      title: '操作',
      key: 'actions',
      width: canQc ? 300 : 80,
      render: (_: unknown, record: MeterReading) => {
        const superseded = !!record.supersededById;
        const qcActions =
          canQc && !superseded ? QC_ACTIONS_BY_STATUS[record.qcStatus] : [];
        const canSupersede =
          canWrite &&
          !superseded &&
          (record.resultType === 'ACTUAL' || record.resultType === 'REMOTE');
        return (
          <Space size={4} wrap>
            <Button
              size="small"
              icon={<SearchOutlined />}
              onClick={() => void openDetail(record)}
            >
              详情
            </Button>
            {qcActions.map((a) => (
              <Button
                key={a}
                size="small"
                icon={QC_ACTION_TEXT[a].icon}
                danger={QC_ACTION_TEXT[a].danger}
                loading={acting === record.id}
                onClick={() => void qc(record, a)}
              >
                {QC_ACTION_TEXT[a].label}
              </Button>
            ))}
            {canSupersede && (
              <Button
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  supersedeForm.resetFields();
                  setSupersedeIdemKey(newIdemKey());
                  setSupersedeTarget(record);
                }}
              >
                更正
              </Button>
            )}
          </Space>
        );
      },
    },
  ];

  const failedColumns: ColumnsType<ImportRowError> = [
    { title: '行号', dataIndex: 'row', width: 70 },
    {
      title: '错误码',
      dataIndex: 'code',
      width: 190,
      render: (c: string) => <Tag color="red">{c}</Tag>,
    },
    { title: '说明', dataIndex: 'error' },
  ];

  return (
    <Card
      title="抄表记录 / 质检"
      extra={
        <Space wrap>
          <Input.Search allowClear placeholder="搜索户号、客户或地址" style={{ width: 250 }}
            value={searchInput} onChange={e => setSearchInput(e.target.value)}
            onSearch={value => { setQuery(value.trim()); setPage(1); }} />
          <Input.Search
            allowClear
            placeholder="计划明细 ID"
            style={{ width: 200 }}
            value={planItemInput}
            onChange={(e) => setPlanItemInput(e.target.value)}
            onSearch={(v) => {
              setPlanItemId(v);
              setPage(1);
            }}
          />
          <Input.Search
            allowClear
            placeholder="表计安装 ID"
            style={{ width: 200 }}
            value={installationInput}
            onChange={(e) => setInstallationInput(e.target.value)}
            onSearch={(v) => {
              setInstallationId(v);
              setPage(1);
            }}
          />
          <DatePicker
            picker="month"
            allowClear
            placeholder="账期"
            value={period}
            onChange={(v) => {
              setPeriod(v);
              setPage(1);
            }}
          />
          <Select
            allowClear
            placeholder="结果类型"
            style={{ width: 110 }}
            options={(['ACTUAL', 'REMOTE', 'NO_READ'] as const).map((t) => ({
              value: t,
              label: RESULT_TYPE_LABELS[t],
            }))}
            value={resultType}
            onChange={(v) => {
              setResultType(v);
              setPage(1);
            }}
          />
          <Select
            allowClear
            placeholder="质检状态"
            style={{ width: 120 }}
            options={(['PENDING', 'PASSED', 'REJECTED', 'MANUAL_REVIEW'] as const).map(
              (s) => ({ value: s, label: QC_STATUS_LABELS[s] }),
            )}
            value={qcStatus}
            onChange={(v) => {
              setQcStatus(v);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(page, pageSize)}>
            刷新
          </Button>
          {canWrite && (
            <Button
              type="primary"
              icon={<UploadOutlined />}
              onClick={() => {
                importForm.resetFields();
                setFailedRows([]);
                setImportIdemKey(newIdemKey());
                setImportOpen(true);
              }}
            >
              批量导入
            </Button>
          )}
        </Space>
      }
    >
      <Table<MeterReading>
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 1900 }}
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

      {/* 更正读数 */}
      <Modal
        open={supersedeTarget !== null}
        title="更正读数（追加新事实行，原记录保留为历史）"
        okText="更正"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitSupersede()}
        onCancel={() => setSupersedeTarget(null)}
        destroyOnHidden
      >
        {supersedeTarget && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={`原读数：${supersedeTarget.readingValue ?? '—'}（${RESULT_TYPE_LABELS[supersedeTarget.resultType]} · ${fmtPeriod(supersedeTarget.period)}）`}
          />
        )}
        <Form form={supersedeForm} layout="vertical">
          <Form.Item
            name="readingValue"
            label="更正后表码读数"
            rules={[{ required: true, message: '请输入表码读数' }, DECIMAL_RULE]}
          >
            <Input placeholder="如 123.5" />
          </Form.Item>
          <Form.Item name="readDate" label="抄表日期" extra="留空取当前时间">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* CSV 批量导入 */}
      <Modal
        open={importOpen}
        title="批量导入抄表记录（全部成功或全部回滚）"
        okText="导入"
        cancelText="取消"
        width={720}
        confirmLoading={importSaving}
        onOk={() => void submitImport()}
        onCancel={() => setImportOpen(false)}
        destroyOnHidden
      >
        <Form form={importForm} layout="vertical">
          <Form.Item label="CSV 文件" extra="选择文件后内容会填入下方文本框，可直接编辑">
            <Upload
              accept=".csv,.txt"
              showUploadList={false}
              beforeUpload={(file) => {
                void file.text().then((text) => importForm.setFieldsValue({ csv: text }));
                return false; // 不真正上传 —— 只读文本进表单
              }}
            >
              <Button icon={<UploadOutlined />}>选择 CSV 文件</Button>
            </Upload>
          </Form.Item>
          <Form.Item
            name="csv"
            label="CSV 内容"
            rules={[{ required: true, message: '请粘贴 CSV 内容或选择文件' }]}
            extra={
              <span style={{ whiteSpace: 'pre-line', fontSize: 12 }}>{CSV_HINT}</span>
            }
          >
            <Input.TextArea rows={8} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
        </Form>
        {failedRows.length > 0 && (
          <Alert
            type="error"
            showIcon
            message="导入校验失败 —— 未写入任何记录，请按行修正后重新提交"
            style={{ marginTop: 8 }}
            description={
              <Table<ImportRowError>
                rowKey="row"
                size="small"
                columns={failedColumns}
                dataSource={failedRows}
                pagination={false}
                style={{ marginTop: 8, background: '#fff' }}
              />
            }
          />
        )}
      </Modal>

      {/* 记录详情 */}
      <Drawer
        open={detail !== null || detailLoading}
        width={560}
        title="抄表记录详情"
        onClose={() => setDetail(null)}
      >
        {detailLoading || !detail ? (
          <Spin />
        ) : (
          <Descriptions
            bordered
            size="small"
            column={1}
            items={[
              { key: 'accountNo', label: '户号', children: detail.account?.accountNo ?? '—' },
              { key: 'customer', label: '客户', children: detail.account?.customerName ?? '—' },
              { key: 'address', label: '用水地址', children: detail.account?.addr ?? '—' },
              { key: 'meterNo', label: '表号', children: detail.meterNo ?? '—' },
              {
                key: 'id',
                label: '记录 ID',
                children: <span style={{ fontFamily: 'monospace' }}>{detail.id}</span>,
              },
              {
                key: 'result',
                label: '抄表结果',
                children: (
                  <Space size={4}>
                    <Tag color={RESULT_TYPE_COLORS[detail.resultType]}>
                      {RESULT_TYPE_LABELS[detail.resultType]}
                    </Tag>
                    {detail.resultType === 'NO_READ'
                      ? detail.exceptionCode
                        ? EXCEPTION_CODE_LABELS[detail.exceptionCode]
                        : '—'
                      : (detail.readingValue ?? '—')}
                  </Space>
                ),
              },
              { key: 'period', label: '账期', children: fmtPeriod(detail.period) },
              { key: 'readDate', label: '抄表日期', children: fmtDate(detail.readDate) },
              {
                key: 'qc',
                label: '质检',
                children: (
                  <Space size={4}>
                    <Tag color={QC_STATUS_COLORS[detail.qcStatus]}>
                      {QC_STATUS_LABELS[detail.qcStatus]}
                    </Tag>
                    {detail.qcAt &&
                      `${(detail.qcByName ?? staffName(detail.qcBy))} · ${fmtTime(detail.qcAt)}`}
                  </Space>
                ),
              },
              {
                key: 'source',
                label: '来源',
                children: <Tag>{READ_SOURCE_LABELS[detail.source]}</Tag>,
              },
              {
                key: 'item',
                label: '计划明细',
                children: detail.planItemId ?? '—（计划外录入）',
              },
              { key: 'inst', label: '表计安装 ID', children: detail.installationId },
              { key: 'meter', label: '表计 ID', children: detail.meterId },
              {
                key: 'chain',
                label: '更正链',
                children: (
                  <Space size={4} wrap>
                    {detail.supersedesReadingId && (
                      <Tooltip title={detail.supersedesReadingId}>
                        <Tag color="blue">更正记录</Tag>
                      </Tooltip>
                    )}
                    {detail.supersededById && (
                      <Tooltip title={detail.supersededById}>
                        <Tag>已被更正</Tag>
                      </Tooltip>
                    )}
                    {!detail.supersedesReadingId && !detail.supersededById && '—'}
                  </Space>
                ),
              },
              { key: 'operator', label: '抄表人', children: detail.operatorName ?? staffName(detail.operatorId) },
              { key: 'photo', label: '照片凭证', children: detail.photoRef ?? '—' },
              { key: 'remark', label: '备注', children: detail.remark ?? '—' },
              { key: 'created', label: '录入时间', children: fmtTime(detail.createdAt) },
            ]}
          />
        )}
      </Drawer>
    </Card>
  );
}
