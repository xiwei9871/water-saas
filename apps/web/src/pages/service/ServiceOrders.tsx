import {
  CheckOutlined,
  CloseOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  StopOutlined,
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
  Timeline,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FOCUS_ROW_CLASS,
  FocusTaskBar,
  useFocusList,
  useFocusParams,
  useTaskGroup,
} from '../../components/TaskFocus';
import { api, apiErrorText } from '../../api/client';
import {
  enumLabel,
  fmtDate,
  fmtTime,
  newIdemKey,
  ORDER_SOURCE_LABELS,
  SERVICE_ORDER_STATUS_COLORS,
  SERVICE_ORDER_STATUS_LABELS,
  SERVICE_TYPE_LABELS,
} from '../common';
import {
  MeterSelect,
  StaffSelect,
  WaterAccountSearchSelect,
} from '../pickers';

interface ServiceOrder {
  id: string;
  orderNo: string;
  waterAccountId: string;
  meterInstallationId: string | null;
  meterId: string | null;
  serviceType: string;
  reason: string | null;
  payload: Record<string, unknown> | null;
  sourceType: string;
  sourceReadingId: string | null;
  status: string;
  applicantId: string | null;
  applicantName?: string | null;
  appliedAt: string;
  approverId: string | null;
  approverName?: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
  dispatcherId: string | null;
  assigneeId: string | null;
  assigneeName?: string | null;
  dispatchedAt: string | null;
  taskId: string | null;
  executedBy: string | null;
  executedByName?: string | null;
  executedAt: string | null;
  resultNote: string | null;
  linkRef: Record<string, unknown> | null;
  archivedAt: string | null;
  createdAt: string;
  /** 后端注入的展示标签（户号+客户名+地址 / 表号 / 来源读数）。 */
  waterAccountLabel?: string | null;
  meterLabel?: string | null;
  sourceReadingLabel?: string | null;
  /** 详情接口注入（T6 执行屏）：目标表具档案 + 关联表位。 */
  targetMeter?: {
    id: string;
    meterNo: string;
    serialNo: string | null;
    caliber: string | null;
    brand: string | null;
    model: string | null;
    maxDial: string | null;
    checkPeriodYears: number | null;
    lastCheckDate: string | null;
    status: string;
  } | null;
  installation?: {
    id: string;
    status: string;
    installedAt: string;
    removedAt: string | null;
    initialReading: string;
    finalReading: string | null;
    locationRemark: string | null;
  } | null;
}

interface LifecycleItem {
  at: string;
  kind: 'INSTALL' | 'REMOVE' | 'SERVICE_ORDER' | 'ACCOUNT_EVENT';
  refId: string;
  meterId: string | null;
  detail: Record<string, unknown>;
}

const STATUS_OPTIONS = Object.entries(SERVICE_ORDER_STATUS_LABELS).map(([value, label]) => ({
  value,
  label,
}));
const TYPE_OPTIONS = Object.entries(SERVICE_TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
}));

/** 20261021 整改：归档佐证必传清单（与后端 ARCHIVE_EVIDENCE 对齐，仅作提示用） */
const ARCHIVE_EVIDENCE_HINT: Record<string, { min: number; items: string[] }> = {
  FAULT: { min: 3, items: ['新表铭牌照片', '旧表拆表止码照片', '新表装表始码照片'] },
  PERIODIC_CHECK: { min: 1, items: ['检定证书照片/扫描件 + 检定结果'] },
  DISPUTE_CHECK: { min: 1, items: ['检定证书照片/扫描件 + 检定结果'] },
  SUSPEND: { min: 1, items: ['停水现场照片（阀门操作照）'] },
  STOP: { min: 1, items: ['停水现场照片（阀门操作照）'] },
  RESUME: { min: 1, items: ['复水现场照片（阀门操作照）'] },
  FLOW_LIMIT: { min: 1, items: ['限流装置照片'] },
  FACILITY_MAINTENANCE: { min: 2, items: ['整改前照片', '整改后照片'] },
  SITE_RECTIFICATION: { min: 2, items: ['整改前照片', '整改后照片'] },
  METER_GROUP_CLEANING: { min: 2, items: ['清洁前照片', '清洁后照片'] },
  CLOSE: { min: 2, items: ['拆除水表照片', '拆除读数照片'] },
};

/** 需要执行联动表单的类型 → 该类型载荷字段（20261020 核查 T6 全字段）。 */
const NEEDS_CHECK_RESULT = new Set(['PERIODIC_CHECK', 'DISPUTE_CHECK']);
const NEEDS_REPLACE_FIELDS = new Set(['FAULT']);
const IS_STATUS_FLIP = new Set(['SUSPEND', 'STOP', 'RESUME']);
const IS_FLOW_LIMIT = new Set(['FLOW_LIMIT']);
const IS_SITE_WORK = new Set([
  'FACILITY_MAINTENANCE',
  'SITE_RECTIFICATION',
  'METER_GROUP_CLEANING',
]);
const IS_CLOSE = new Set(['CLOSE']);

export default function ServiceOrders() {
  const { message } = AntdApp.useApp();
  const { focusId, clear: clearFocus } = useFocusParams();

  const [items, setItems] = useState<ServiceOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>();
  const [serviceType, setServiceType] = useState<string>();
  const [range, setRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<ServiceOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [lifecycle, setLifecycle] = useState<LifecycleItem[] | null>(null);
  const [action, setAction] = useState<
    null | 'approve' | 'reject' | 'dispatch' | 'execute' | 'cancel' | 'archive'
  >(null);
  const [activeInstallations, setActiveInstallations] = useState<
    {
      id: string;
      meterId: string;
      installedAt?: string;
      initialReading?: string;
      meter?: { meterNo: string; serialNo: string | null } | null;
    }[]
  >([]);
  const instLabel = (i: {
    installedAt?: string;
    initialReading?: string;
    meter?: { meterNo: string; serialNo: string | null } | null;
  }) =>
    `表 ${i.meter?.meterNo ?? '?'}${i.installedAt ? ` · 装于 ${fmtDate(i.installedAt)}` : ''}`;
  const [form] = Form.useForm();
  const [execForm] = Form.useForm();

  const load = useCallback(
    async (p = page) => {
      setLoading(true);
      try {
        const res = await api.get<{ total: number; items: ServiceOrder[] }>(
          '/service-orders',
          {
            params: {
              take: 20,
              skip: (p - 1) * 20,
              ...(status ? { status } : {}),
              ...(serviceType ? { serviceType } : {}),
              ...(range?.[0] ? { from: range[0].format('YYYY-MM-DD') } : {}),
              ...(range?.[1] ? { to: range[1].format('YYYY-MM-DD') } : {}),
            },
          },
        );
        setItems(res.data.items);
        setTotal(res.data.total);
      } catch (e) {
        message.error(apiErrorText(e));
      } finally {
        setLoading(false);
      }
    },
    [page, status, serviceType, range, message],
  );

  useEffect(() => {
    void load(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status, serviceType, range]);

  const openDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        const res = await api.get<ServiceOrder>(`/service-orders/${id}`);
        setDetail(res.data);
      } catch (e) {
        message.error(apiErrorText(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [message],
  );

  // 任务中心直达 ?focusId=
  useEffect(() => {
    if (focusId) void openDetail(focusId);
  }, [focusId, openDetail]);

  // U2 任务分组：工单任务挂在工单上。
  const taskGroup = useTaskGroup<ServiceOrder>('service_order', items, (r) => r.id);
  const focusList = useFocusList<ServiceOrder>(
    focusId,
    taskGroup.filtered,
    focusId ? (r) => r.id === focusId : null,
    { onShowAll: () => setPage(1) },
  );
  const shownItems = focusList.shown;

  const doAction = async (
    verb: 'approve' | 'reject' | 'dispatch' | 'cancel' | 'archive',
    body: Record<string, unknown> = {},
  ) => {
    if (!detail) return;
    try {
      await api.post(`/service-orders/${detail.id}/${verb}`, body, {
        headers: { 'Idempotency-Key': newIdemKey() },
      });
      message.success('操作成功');
      setAction(null);
      form.resetFields();
      await openDetail(detail.id);
      void load(page);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const doExecute = async () => {
    if (!detail) return;
    const v = await execForm.validateFields();
    const payload: Record<string, unknown> = {};
    const d = (x?: dayjs.Dayjs) => (x ? x.format('YYYY-MM-DD') : undefined);
    // 在网表检定单（needReplace）= 先换表后送检：两类字段都要填。
    const needReplace =
      NEEDS_REPLACE_FIELDS.has(detail.serviceType) || detail.payload?.needReplace === true;
    if (NEEDS_CHECK_RESULT.has(detail.serviceType)) {
      payload.checkOrg = v.checkOrg;
      payload.checkDate = d(v.checkDate);
      payload.checkResult = v.checkResult;
      payload.checkError = v.checkError;
      payload.certNo = v.certNo;
      payload.nextCheckDate = d(v.nextCheckDate);
      payload.effectiveDate = d(v.checkDate ?? v.effectiveDate);
    }
    if (needReplace) {
      payload.newMeterId = v.newMeterId;
      payload.oldFinalReading = v.oldFinalReading;
      payload.newInitialReading = v.newInitialReading;
      if (v.installationId) payload.meterInstallationId = v.installationId;
      if (v.replacedAt) payload.replacedAt = v.replacedAt.format('YYYY-MM-DD');
    } else if (IS_STATUS_FLIP.has(detail.serviceType)) {
      if (v.effectiveDate) payload.effectiveDate = v.effectiveDate.format('YYYY-MM-DD');
      if (v.remark) payload.remark = v.remark;
    } else if (IS_FLOW_LIMIT.has(detail.serviceType)) {
      payload.limitMethod = v.limitMethod;
      payload.limitValue = v.limitValue;
      payload.effectiveDate = d(v.effectiveDate);
      payload.restoreDate = d(v.restoreDate);
    } else if (IS_SITE_WORK.has(detail.serviceType)) {
      payload.content = v.content;
    } else if (IS_CLOSE.has(detail.serviceType)) {
      payload.finalReading = v.finalReading;
      payload.removedAt = d(v.removedAt);
      if (v.installationId) payload.meterInstallationId = v.installationId;
      if (v.remark) payload.remark = v.remark;
    }
    if (v.photoRefs) {
      payload.photoRefs = String(v.photoRefs)
        .split(/[\s,，;；]+/)
        .filter(Boolean);
    }
    try {
      await api.post(
        `/service-orders/${detail.id}/execute`,
        { resultNote: v.resultNote, payload },
        { headers: { 'Idempotency-Key': newIdemKey() } },
      );
      message.success('执行完成');
      setAction(null);
      execForm.resetFields();
      await openDetail(detail.id);
      void load(page);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const onCreate = async () => {
    const v = await form.validateFields();
    try {
      const res = await api.post<ServiceOrder>(
        '/service-orders',
        {
          waterAccountId: v.waterAccountId,
          serviceType: v.serviceType,
          reason: v.reason,
          meterInstallationId: v.meterInstallationId,
        },
        { headers: { 'Idempotency-Key': newIdemKey() } },
      );
      message.success(`工单 ${res.data.orderNo} 已提交`);
      setCreateOpen(false);
      form.resetFields();
      void load(1);
      setPage(1);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  // 发起 FAULT 工单或执行换表时需要户下 ACTIVE 安装行
  const loadInstallations = useCallback(
    async (waterAccountId: string) => {
      try {
        const res = await api.get<
          { id: string; meterId: string; meter?: { meterNo?: string } }[]
        >('/meter-installations', {
          params: { waterAccountId, status: 'ACTIVE', take: 50 },
        });
        setActiveInstallations(res.data.map((i) => ({ id: i.id, meterId: i.meterId })));
      } catch {
        setActiveInstallations([]);
      }
    },
    [],
  );

  const showLifecycle = async () => {
    if (!detail) return;
    try {
      const res = await api.get<{ timeline: LifecycleItem[] }>(
        `/service-orders/meter-lifecycle/${detail.waterAccountId}`,
      );
      setLifecycle(res.data.timeline);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const columns: ColumnsType<ServiceOrder> = useMemo(
    () => [
      { title: '工单号', dataIndex: 'orderNo', width: 170 },
      {
        title: '服务类型',
        dataIndex: 'serviceType',
        width: 140,
        render: (v: string) => enumLabel(SERVICE_TYPE_LABELS, v),
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 96,
        render: (v: string) => (
          <Tag color={SERVICE_ORDER_STATUS_COLORS[v]}>
            {enumLabel(SERVICE_ORDER_STATUS_LABELS, v)}
          </Tag>
        ),
      },
      {
        title: '用水户',
        dataIndex: 'waterAccountLabel',
        width: 210,
        ellipsis: true,
        render: (v) => v ?? '—',
      },
      {
        title: '来源',
        dataIndex: 'sourceType',
        width: 90,
        render: (v: string) => enumLabel(ORDER_SOURCE_LABELS, v),
      },
      { title: '申请人', dataIndex: 'applicantName', width: 100, render: (v) => v ?? '—' },
      { title: '执行人', dataIndex: 'assigneeName', width: 100, render: (v) => v ?? '—' },
      { title: '事由', dataIndex: 'reason', ellipsis: true, render: (v) => v ?? '—' },
      { title: '申请时间', dataIndex: 'appliedAt', width: 165, render: fmtTime },
      {
        title: '操作',
        key: 'op',
        width: 80,
        render: (_, r) => (
          <Button size="small" icon={<EyeOutlined />} onClick={() => void openDetail(r.id)}>
            详情
          </Button>
        ),
      },
    ],
    [openDetail],
  );

  return (
    <Card
      title="表务工单"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="服务类型"
            style={{ width: 160 }}
            options={TYPE_OPTIONS}
            value={serviceType}
            onChange={(v) => {
              setServiceType(v);
              setPage(1);
            }}
          />
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 120 }}
            options={STATUS_OPTIONS}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          <DatePicker.RangePicker
            value={range as never}
            onChange={(v) => {
              setRange(v);
              setPage(1);
            }}
            style={{ width: 240 }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(page)} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            发起工单
          </Button>
        </Space>
      }
    >
      {focusId && (
        <FocusTaskBar
          focusId={focusId}
          summary={<span>该张工单已定位并打开详情</span>}
          showAll={focusList.showAll}
          onToggleAll={focusList.toggleAll}
          onOpenDetail={() => void openDetail(focusId)}
          onClose={clearFocus}
        />
      )}
      {!focusList.focusing && taskGroup.tabs}
      <Table<ServiceOrder> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={shownItems}
        rowClassName={(r) => (r.id === focusId ? FOCUS_ROW_CLASS : '')}
        pagination={
          focusList.focusing
            ? false
            : {
                current: page,
                total,
                pageSize: 20,
                onChange: setPage,
                showTotal: (t) => `共 ${t} 条`,
              }
        }
      />

      {/* 发起工单 */}
      <Modal
        title="发起表务工单"
        open={createOpen}
        onOk={onCreate}
        onCancel={() => setCreateOpen(false)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="waterAccountId"
            label="用水户"
            rules={[{ required: true, message: '请选择用水户' }]}
          >
            <WaterAccountSearchSelect
              onSelect={(a) => a && void loadInstallations(a.id)}
            />
          </Form.Item>
          <Form.Item
            name="serviceType"
            label="服务类型"
            rules={[{ required: true, message: '请选择服务类型' }]}
          >
            <Select options={TYPE_OPTIONS} placeholder="选择处置类型" />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(a, b) => a.serviceType !== b.serviceType}
          >
            {() =>
              activeInstallations.length > 0 ? (
                <Form.Item name="meterInstallationId" label="关联表位(安装记录)">
                  <Select
                    allowClear
                    options={activeInstallations.map((i) => ({
                      value: i.id,
                      label: instLabel(i),
                    }))}
                    placeholder="故障换表等类型建议关联"
                  />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name="reason" label="事由">
            <Input.TextArea rows={2} placeholder="申请原因 / 现场情况" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 详情抽屉 */}
      <Drawer
        title={detail ? `工单 ${detail.orderNo}` : '工单详情'}
        open={Boolean(detail)}
        onClose={() => {
          setDetail(null);
          setAction(null);
          setLifecycle(null);
        }}
        width={560}
      >
        {detailLoading && <Card loading />}
        {detail && (
          <>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="状态">
                <Tag color={SERVICE_ORDER_STATUS_COLORS[detail.status]}>
                  {enumLabel(SERVICE_ORDER_STATUS_LABELS, detail.status)}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="服务类型">
                {enumLabel(SERVICE_TYPE_LABELS, detail.serviceType)}
              </Descriptions.Item>
              <Descriptions.Item label="来源">
                <Tag>{enumLabel(ORDER_SOURCE_LABELS, detail.sourceType)}</Tag>
                {detail.sourceReadingLabel ?? ''}
              </Descriptions.Item>
              <Descriptions.Item label="用水户">
                {detail.waterAccountLabel ?? '—'}
              </Descriptions.Item>
              {detail.targetMeter ? (
                <Descriptions.Item label="目标表具">
                  {detail.targetMeter.meterNo} · 口径{' '}
                  {detail.targetMeter.caliber ?? '—'} · 检定周期{' '}
                  {detail.targetMeter.checkPeriodYears ?? '未设'}年 · 上次检定{' '}
                  {fmtDate(detail.targetMeter.lastCheckDate)}
                </Descriptions.Item>
              ) : null}
              <Descriptions.Item label="事由">{detail.reason ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="申请">
                {detail.applicantName ?? '—'} · {fmtTime(detail.appliedAt)}
              </Descriptions.Item>
              <Descriptions.Item label="审批">
                {detail.approverName
                  ? `${detail.approverName} · ${detail.approvedAt ? fmtTime(detail.approvedAt) : '—'}${
                      detail.approvalNote ? `（${detail.approvalNote}）` : ''
                    }`
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="派单">
                {detail.dispatchedAt
                  ? `${detail.assigneeName ?? '未指定'} · ${fmtTime(detail.dispatchedAt)}`
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="执行">
                {detail.executedAt
                  ? `${detail.executedByName ?? '—'} · ${fmtTime(detail.executedAt)}`
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="执行结果">
                {detail.resultNote ?? '—'}
              </Descriptions.Item>
              {detail.linkRef ? (
                <Descriptions.Item label="联动产物">
                  {Object.entries(detail.linkRef).map(([k, v]) => `${k}: ${String(v)}`).join('，')}
                </Descriptions.Item>
              ) : null}
              <Descriptions.Item label="归档">
                {detail.archivedAt ? fmtTime(detail.archivedAt) : '—'}
              </Descriptions.Item>
            </Descriptions>

            <Space style={{ marginTop: 16 }} wrap>
              {detail.status === 'PENDING_APPROVAL' && (
                <>
                  <Button
                    type="primary"
                    icon={<CheckOutlined />}
                    onClick={() => setAction('approve')}
                  >
                    审批通过
                  </Button>
                  <Button danger icon={<CloseOutlined />} onClick={() => setAction('reject')}>
                    驳回
                  </Button>
                </>
              )}
              {detail.status === 'APPROVED' && (
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  onClick={() => setAction('dispatch')}
                >
                  派单
                </Button>
              )}
              {detail.status === 'DISPATCHED' && (
                <Button type="primary" icon={<ToolOutlined />} onClick={() => setAction('execute')}>
                  执行回填
                </Button>
              )}
              {detail.status === 'EXECUTED' && (
                <Button type="primary" onClick={() => setAction('archive')}>
                  归档
                </Button>
              )}
              {['PENDING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(detail.status) && (
                <Button danger icon={<StopOutlined />} onClick={() => setAction('cancel')}>
                  撤销
                </Button>
              )}
              <Button onClick={() => void showLifecycle()}>生命周期</Button>
            </Space>

            {lifecycle && (
              <Timeline
                style={{ marginTop: 24 }}
                items={lifecycle.map((t) => ({
                  key: `${t.kind}-${t.refId}`,
                  children: `${fmtTime(t.at)} — ${
                    t.kind === 'INSTALL'
                      ? '装表'
                      : t.kind === 'REMOVE'
                        ? '拆表'
                        : t.kind === 'SERVICE_ORDER'
                          ? `工单 ${(t.detail as { orderNo?: string }).orderNo ?? ''} ${enumLabel(
                              SERVICE_TYPE_LABELS,
                              (t.detail as { serviceType?: string }).serviceType,
                            )}`
                          : `账户事件 ${(t.detail as { type?: string }).type ?? ''}`
                  }`,
                }))}
              />
            )}
          </>
        )}
      </Drawer>

      {/* 审批/驳回/派单/撤销/归档 轻表单 */}
      <Modal
        title={
          action === 'approve'
            ? '审批通过'
            : action === 'reject'
              ? '驳回工单'
              : action === 'dispatch'
                ? '派单'
                : action === 'archive'
                  ? '归档工单'
                  : '撤销工单'
        }
        open={action !== null && action !== 'execute'}
        onOk={() => {
          const v = form.getFieldsValue();
          if (action === 'approve') return doAction('approve', { note: v.note });
          if (action === 'reject') return doAction('reject', { note: v.note });
          if (action === 'dispatch')
            return doAction('dispatch', { assigneeId: v.assigneeId, note: v.note });
          if (action === 'cancel') return doAction('cancel', { reason: v.note });
          if (action === 'archive') {
            const refs = String(v.photoRefs ?? '')
              .split(/[\s,，;；]+/)
              .filter(Boolean);
            return doAction('archive', { photoRefs: refs });
          }
        }}
        onCancel={() => setAction(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {action === 'dispatch' && (
            <Form.Item name="assigneeId" label="指派给">
              <StaffSelect placeholder="执行人（可选）" />
            </Form.Item>
          )}
          {action === 'archive' && detail && (
            <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message={`归档须佐证：${ARCHIVE_EVIDENCE_HINT[detail.serviceType]?.items.join('、') ?? '现场照片'}（已有 ${
                  Array.isArray(detail.linkRef?.photoRefs)
                    ? (detail.linkRef!.photoRefs as unknown[]).length
                    : 0
                } 项）`}
              />
              <Form.Item
                name="photoRefs"
                label="补充佐证照片引用"
                tooltip="上传接口返回的引用，空格或逗号分隔；已有佐证不足时将拒绝归档"
              >
                <Input.TextArea rows={2} placeholder="photo-ref-1, photo-ref-2" />
              </Form.Item>
            </>
          )}
          {action !== 'archive' && (
            <Form.Item name="note" label="备注">
              <Input.TextArea rows={2} />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 执行回填 — 按类型出载荷字段 */}
      <Modal
        title={`执行回填 — ${detail ? enumLabel(SERVICE_TYPE_LABELS, detail.serviceType) : ''}`}
        open={action === 'execute'}
        onOk={doExecute}
        onCancel={() => setAction(null)}
        destroyOnHidden
        width={520}
      >
        {detail?.targetMeter && (
          <Card size="small" title="目标表具档案" style={{ marginBottom: 16 }}>
            <Descriptions column={2} size="small">
              <Descriptions.Item label="表号">
                {detail.targetMeter.meterNo}
              </Descriptions.Item>
              <Descriptions.Item label="口径">
                {detail.targetMeter.caliber ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="检定周期">
                {detail.targetMeter.checkPeriodYears
                  ? `${detail.targetMeter.checkPeriodYears} 年`
                  : '未设'}
              </Descriptions.Item>
              <Descriptions.Item label="上次检定">
                {fmtDate(detail.targetMeter.lastCheckDate)}
              </Descriptions.Item>
              <Descriptions.Item label="表位读数">
                始 {detail.installation?.initialReading ?? '—'} / 止{' '}
                {detail.installation?.finalReading ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="表位位置">
                {detail.installation?.locationRemark ?? '—'}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        )}
        <Form form={execForm} layout="vertical">
          {detail && NEEDS_CHECK_RESULT.has(detail.serviceType) && (
            <>
              <Form.Item name="checkOrg" label="检定机构">
                <Input placeholder="检定/校准机构名称" />
              </Form.Item>
              <Form.Item name="checkDate" label="检定日期">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="checkResult"
                label="检定结果"
                rules={[{ required: true, message: '请填检定结果' }]}
              >
                <Select
                  options={[
                    { value: 'PASS', label: '合格' },
                    { value: 'FAIL', label: '不合格' },
                    { value: 'ADJUSTED', label: '调校后合格' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="checkError" label="示值误差(%)">
                <Input placeholder="如 +1.2" />
              </Form.Item>
              <Form.Item name="certNo" label="检定证书号">
                <Input />
              </Form.Item>
              <Form.Item
                name="nextCheckDate"
                label="下次检定日期"
                tooltip="缺省按 检定日期+检定周期年限 推算"
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </>
          )}
          {detail &&
            (NEEDS_REPLACE_FIELDS.has(detail.serviceType) ||
              detail.payload?.needReplace === true) && (
            <>
              {!detail.meterInstallationId && (
                <Form.Item
                  name="installationId"
                  label="被换表位(安装记录)"
                  rules={[{ required: true, message: '工单未关联表位，请选择' }]}
                >
                  <Select
                    options={activeInstallations.map((i) => ({
                      value: i.id,
                      label: instLabel(i),
                    }))}
                    placeholder="选择要拆除的安装记录"
                  />
                </Form.Item>
              )}
              <Form.Item
                name="newMeterId"
                label="新表"
                rules={[{ required: true, message: '请选择新表' }]}
              >
                <MeterSelect status="AVAILABLE" placeholder="可用库存表" />
              </Form.Item>
              <Form.Item
                name="oldFinalReading"
                label="老表止码"
                rules={[{ required: true, message: '必填' }]}
              >
                <InputNumber style={{ width: '100%' }} min={0} precision={4} />
              </Form.Item>
              <Form.Item
                name="newInitialReading"
                label="新表始码"
                rules={[{ required: true, message: '必填' }]}
              >
                <InputNumber style={{ width: '100%' }} min={0} precision={4} />
              </Form.Item>
              <Form.Item name="replacedAt" label="换表日期">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </>
          )}
          {detail && IS_STATUS_FLIP.has(detail.serviceType) && (
            <>
              <Form.Item name="effectiveDate" label="生效日期">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="remark" label="备注">
                <Input />
              </Form.Item>
            </>
          )}
          {detail && IS_FLOW_LIMIT.has(detail.serviceType) && (
            <>
              <Form.Item name="limitMethod" label="限流方式">
                <Select
                  allowClear
                  options={[
                    { value: 'THROTTLE', label: '阀门节流' },
                    { value: 'ORIFICE', label: '限流片' },
                    { value: 'PRESSURE', label: '压力控制' },
                    { value: 'OTHER', label: '其他' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="limitValue" label="限流值">
                <Input placeholder="如 2 m³/h" />
              </Form.Item>
              <Form.Item name="effectiveDate" label="限流开始日期">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="restoreDate" label="恢复日期">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </>
          )}
          {detail && IS_SITE_WORK.has(detail.serviceType) && (
            <Form.Item name="content" label="作业内容记录">
              <Input.TextArea rows={3} placeholder="维护/整改/清洁内容与处理情况" />
            </Form.Item>
          )}
          {detail && IS_CLOSE.has(detail.serviceType) && (
            <>
              {!detail.meterInstallationId && (
                <Form.Item
                  name="installationId"
                  label="拆除表位(安装记录)"
                  tooltip="缺省取该户最新在装表位"
                >
                  <Select
                    allowClear
                    options={activeInstallations.map((i) => ({
                      value: i.id,
                      label: instLabel(i),
                    }))}
                  />
                </Form.Item>
              )}
              <Form.Item
                name="finalReading"
                label="拆除止码"
                rules={[{ required: true, message: '必填' }]}
              >
                <InputNumber style={{ width: '100%' }} min={0} precision={4} />
              </Form.Item>
              <Form.Item name="removedAt" label="拆除日期">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="remark" label="备注">
                <Input />
              </Form.Item>
            </>
          )}
          <Form.Item
            name="photoRefs"
            label="现场照片引用"
            tooltip="处置前/后照片的上传引用，空格或逗号分隔"
          >
            <Input.TextArea rows={2} placeholder="photo-ref-1, photo-ref-2" />
          </Form.Item>
          <Form.Item name="resultNote" label="处置结果说明">
            <Input.TextArea rows={2} placeholder="现场处置情况" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
