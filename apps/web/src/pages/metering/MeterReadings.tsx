import {
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  EyeOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  UploadOutlined,
  WarningOutlined,
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
  Popover,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, apiErrorText, toApiError } from '../../api/client';
import type {
  ImportRowError,
  MeterReading,
  QcStatus,
  ReadResultType,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  enumLabel,
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
import {
  FOCUS_ROW_CLASS,
  FocusTaskBar,
  useFocusParams,
  useTaskGroup,
} from '../../components/TaskFocus';

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
  const { message, modal } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('metering:write');
  // 质检是复核动作（metering:qc），录表权限不再放行（Round-2 报告 §2）。
  const canQc = hasPerm('metering:qc');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');

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

  const [acting, setActing] = useState<string | null>(null);

  const [supersedeTarget, setSupersedeTarget] = useState<MeterReading | null>(null);
  const [supersedeIdemKey, setSupersedeIdemKey] = useState('');
  // 20261021 整改 任务E：抄表员上报疑似违章（→ PENDING_REVIEW，派发稽查任务）。
  const [violationTarget, setViolationTarget] = useState<MeterReading | null>(null);
  const [violationForm] = Form.useForm<{ violationType: string; description?: string; photoRefs?: string }>();
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


  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const { focusId, clear: clearFocus } = useFocusParams();
  const focusDone = useRef<string | null>(null);
  const [focusRecord, setFocusRecord] = useState<MeterReading | null>(null);

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

  // U1 任务直达 ?focusId= → 定位到"该条"记录：置顶警示条 + 行高亮 + 自动开详情。
  useEffect(() => {
    if (!focusId) {
      setFocusRecord(null);
      focusDone.current = null;
      return;
    }
    if (focusDone.current === focusId) return;
    focusDone.current = focusId;
    void (async () => {
      try {
        const res = await api.get<MeterReading>(`/meter-readings/${focusId}`);
        setFocusRecord(res.data);
      } catch {
        setFocusRecord(null);
      }
      await openDetail({ id: focusId } as MeterReading);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  // U2 任务分组：默认「未完成」，任务全部办结的记录归入「已完成」。
  const taskGroup = useTaskGroup<MeterReading>('meterReading', rows, (r) => r.id);
  const shownRows = taskGroup.filtered;

  // 聚焦行进入视口即高亮滚动到位。
  useEffect(() => {
    if (!focusId) return;
    const t = window.setTimeout(() => {
      document.querySelector(`.${FOCUS_ROW_CLASS}`)?.scrollIntoView({ block: 'center' });
    }, 600);
    return () => window.clearTimeout(t);
  }, [focusId, shownRows.length]);

  const doQc = async (reading: MeterReading, action: QcAction) => {
    setActing(reading.id);
    try {
      const res = await api.post(
        `/meter-readings/${reading.id}/qc`,
        { action },
        { headers: { 'Idempotency-Key': newIdemKey() } },
      );
      message.success(`质检已${QC_ACTION_TEXT[action].label}`);
      // 任务书 T10/§1.8 三段式：有权限者「请从待办领取」，无权限者「已通知××，您无需操作」。
      const st = (res.data as {
        supplementTask?: { id: string; deduped: boolean; candidates: { name: string }[] } | null;
      }).supplementTask;
      if (st) {
        const names = st.candidates.length
          ? st.candidates.map((c) => c.name).join('、')
          : '（暂无具备权限的账号，已告警管理员）';
        modal.warning({
          title: '检测到【实抄止度 < 估计止度】，已生成【补差任务】',
          content: hasPerm('billing:write')
            ? `该任务在您的待办中心可领取处理${st.deduped ? '（沿用既有任务）' : ''}，候选责任人：${names}。`
            : `已${st.deduped ? '沿用既有任务并' : ''}通知具备权限的账号：${names}。您无需操作。`,
        });
      }
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
      await load(page, pageSize);
    } finally {
      setActing(null);
    }
  };

  /**
   * Round-2 报告 §10：通过一条「未抄见」读数且该户已连续多期未抄见时，
   * 强制二次确认 —— 长期估抄需要复核员有意识地放行，不能顺手点过。
   */
  const qc = (reading: MeterReading, action: QcAction) => {
    const streak = reading.consecutiveNoRead ?? 0;
    if (action === 'pass' && reading.resultType === 'NO_READ' && streak >= 2) {
      modal.confirm({
        title: '连续未抄见警示',
        content: `该户截至本期已连续 ${streak} 期未抄见（含本条）。通过后将继续按预估口径结算；达到连续预估上限的账户请转异常中心跟进入户核查。确认仍要通过？`,
        okText: '仍要通过',
        cancelText: '取消',
        onOk: () => doQc(reading, action),
      });
      return;
    }
    void doQc(reading, action);
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
    { title: '客户名称', key: 'customer', width: 190, render: (_, r) => r.account?.customerName ?? '—' },
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
        <Tag color={RESULT_TYPE_COLORS[t]}>{enumLabel(RESULT_TYPE_LABELS, t)}</Tag>
      ),
    },
    {
      title: '读数 / 异常',
      key: 'value',
      width: 150,
      render: (_: unknown, r: MeterReading) =>
        r.resultType === 'NO_READ' ? (
          <Space size={4} wrap>
            <Tag color="orange">
              {r.exceptionCode ? enumLabel(EXCEPTION_CODE_LABELS, r.exceptionCode) : r.exceptionCode}
            </Tag>
            {r.estimateQty != null && (
              <Tooltip title="抄表员预计用量，非表码">
                <Tag color="cyan">估 {r.estimateQty} m³</Tag>
              </Tooltip>
            )}
            {(r.consecutiveNoRead ?? 0) >= 2 && (
              <Tooltip title="该户连续多期未抄见，复核前请确认是否已达连续预估上限并需入户核查">
                <Tag color="red">连{r.consecutiveNoRead}期未抄</Tag>
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
          title={r.qcAt ? `质检人 ${(r.qcByName ?? '—')} · ${fmtTime(r.qcAt)}` : undefined}
        >
          <Tag color={QC_STATUS_COLORS[r.qcStatus]}>{enumLabel(QC_STATUS_LABELS, r.qcStatus)}</Tag>
        </Tooltip>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 90,
      render: (s: MeterReading['source']) => <Tag>{enumLabel(READ_SOURCE_LABELS, s)}</Tag>,
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
      render: (_: unknown, r: MeterReading) => r.operatorName ?? '—',
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
                onClick={() => qc(record, a)}
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
            {canWrite && (
              <Button
                size="small"
                danger
                icon={<WarningOutlined />}
                onClick={() => {
                  violationForm.resetFields();
                  setViolationTarget(record);
                }}
              >
                上报违章
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
    <>
      <Card
      title="抄表记录 / 质检"
      extra={
        <Space wrap>
          <Input.Search allowClear placeholder="搜索户号、客户或地址" style={{ width: 250 }}
            value={searchInput} onChange={e => setSearchInput(e.target.value)}
            onSearch={value => { setQuery(value.trim()); setPage(1); }} />
          <Popover
            trigger="click"
            placement="bottomLeft"
            title="高级筛选（技术参数，日常按户号搜索即可）"
            content={
              <Space direction="vertical" style={{ width: 300 }}>
                <Input.Search
                  allowClear
                  placeholder="计划明细 ID"
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
                  value={installationInput}
                  onChange={(e) => setInstallationInput(e.target.value)}
                  onSearch={(v) => {
                    setInstallationId(v);
                    setPage(1);
                  }}
                />
              </Space>
            }
          >
            <Button
              icon={<SettingOutlined />}
              type={
                planItemId.trim() || installationId.trim()
                  ? 'primary'
                  : 'default'
              }
            >
              高级筛选
            </Button>
          </Popover>
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
              label: enumLabel(RESULT_TYPE_LABELS, t),
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
              (s) => ({ value: s, label: enumLabel(QC_STATUS_LABELS, s) }),
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
      {focusId && (
        <FocusTaskBar
          focusId={focusId}
          summary={
            focusRecord ? (
              <span>
                户号 {focusRecord.account?.accountNo ?? '—'} · 账期 {focusRecord.period} · 读数{' '}
                {String(focusRecord.readingValue ?? '—')} · 质检{' '}
                {enumLabel(QC_STATUS_LABELS, focusRecord.qcStatus)}
              </span>
            ) : (
              <span>记录 {focusId.slice(0, 8)}…</span>
            )
          }
          onOpenDetail={() => void openDetail({ id: focusId } as MeterReading)}
          onClose={clearFocus}
        />
      )}
      {taskGroup.tabs}
      <Table<MeterReading>
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={shownRows}
        rowClassName={(r) => (r.id === focusId ? FOCUS_ROW_CLASS : '')}
        scroll={{ x: 1900, y: 'calc(100vh - 340px)' }}
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
      <Modal maskClosable={false}
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
            message={`原读数：${supersedeTarget.readingValue ?? '—'}（${enumLabel(RESULT_TYPE_LABELS, supersedeTarget.resultType)} · ${fmtPeriod(supersedeTarget.period)}）`}
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

      {/* 上报疑似违章（20261021 任务E：READING 来源，进入待核实） */}
      <Modal
        maskClosable={false}
        open={violationTarget !== null}
        title="上报疑似违章（转稽查核实）"
        okText="上报"
        cancelText="取消"
        onOk={async () => {
          const v = await violationForm.validateFields();
          try {
            await api.post(`/meter-readings/${violationTarget!.id}/report-violation`, {
              violationType: v.violationType,
              description: v.description,
              photoRefs: String(v.photoRefs ?? '')
                .split(/[\s,，;；]+/)
                .filter(Boolean),
            });
            message.success('已上报，稽查岗将在待办中核实');
            setViolationTarget(null);
          } catch (e) {
            message.error(apiErrorText(e));
          }
        }}
        onCancel={() => setViolationTarget(null)}
        destroyOnHidden
      >
        <Form form={violationForm} layout="vertical">
          <Form.Item name="violationType" label="疑似违章类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'THEFT', label: '盗窃用水' },
                { value: 'PRIVATE_CONN', label: '私自接水' },
                { value: 'TAMPER', label: '破坏表计' },
                { value: 'SEAL_BROKEN', label: '破坏铅封' },
                { value: 'CATEGORY_MISUSE', label: '擅自改变用水性质' },
              ]}
            />
          </Form.Item>
          <Form.Item name="description" label="现场描述">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="photoRefs" label="现场照片引用（空格分隔，可选）">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* CSV 批量导入 */}
      <Modal maskClosable={false}
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
              { key: 'customer', label: '客户名称', children: detail.account?.customerName ?? '—' },
              { key: 'address', label: '用水地址', children: detail.account?.addr ?? '—' },
              { key: 'meterNo', label: '表号', children: detail.meterNo ?? '—' },
              {
                key: 'result',
                label: '抄表结果',
                children: (
                  <Space size={4}>
                    <Tag color={RESULT_TYPE_COLORS[detail.resultType]}>
                      {enumLabel(RESULT_TYPE_LABELS, detail.resultType)}
                    </Tag>
                    {detail.resultType === 'NO_READ'
                      ? detail.exceptionCode
                        ? enumLabel(EXCEPTION_CODE_LABELS, detail.exceptionCode)
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
                      {enumLabel(QC_STATUS_LABELS, detail.qcStatus)}
                    </Tag>
                    {detail.qcAt &&
                      `${(detail.qcByName ?? '—')} · ${fmtTime(detail.qcAt)}`}
                  </Space>
                ),
              },
              {
                key: 'source',
                label: '来源',
                children: <Tag>{enumLabel(READ_SOURCE_LABELS, detail.source)}</Tag>,
              },
              {
                key: 'tech',
                label: '技术信息',
                children: (
                  <details>
                    <summary style={{ cursor: 'pointer', color: '#888' }}>
                      展开查看（排查用）
                    </summary>
                    <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      记录 {detail.id} · 明细 {detail.planItemId ?? '无（计划外录入）'} ·
                      安装 {detail.installationId} · 表计 {detail.meterId}
                    </span>
                  </details>
                ),
              },
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
              { key: 'operator', label: '抄表人', children: detail.operatorName ?? '—' },
              { key: 'photo', label: '照片凭证', children: detail.photoRef ?? '—' },
              { key: 'remark', label: '备注', children: detail.remark ?? '—' },
              { key: 'created', label: '录入时间', children: fmtTime(detail.createdAt) },
            ]}
          />
        )}
      </Drawer>
    </Card>
    </>
  );
}
