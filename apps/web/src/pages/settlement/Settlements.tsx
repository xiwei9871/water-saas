import {
  CheckCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
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
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  ConsumptionComponent,
  ConsumptionSettlement,
  EstimatePreview,
  SettlementStatus,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  DECIMAL_RULE,
  cleanBody,
  fmtPeriod,
  fmtTime,
  newIdemKey,
  useWaterAccountLabels,
} from '../common';
import { CustomerSelect, WaterAccountSelect } from '../pickers';
import {
  COMPONENT_SOURCE_COLORS,
  COMPONENT_SOURCE_LABELS,
  ESTIMATE_METHOD_LABELS,
  SETTLEMENT_STATUS_COLORS,
  SETTLEMENT_STATUS_LABELS,
} from './common';

interface GenerateFormValues {
  customerId?: string; // 仅级联过滤
  waterAccountId: string;
  period: dayjs.Dayjs;
  usageQty?: string;
  estimateReason?: string;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 结算水量：列表（账期/账户/状态/预估过滤）+ 详情抽屉（分量 + 预估依据）
 * + 终审（DRAFT→FINAL）+ 生成结算（usageQty 快捷预估 / estimateReason
 * 必填提示 + AUTO_AVG3 预估预览）。
 */
export default function Settlements() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('metering:write');
  const canCustomerRead = hasPerm('customer:read');

  const [rows, setRows] = useState<ConsumptionSettlement[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterCustomerId, setFilterCustomerId] = useState<string | undefined>(undefined);
  const [waterAccountId, setWaterAccountId] = useState<string | undefined>(undefined);
  const [accountIdInput, setAccountIdInput] = useState(''); // 无 customer:read 的兜底输入
  const [period, setPeriod] = useState<dayjs.Dayjs | null>(null);
  const [status, setStatus] = useState<SettlementStatus | undefined>(undefined);
  const [isEstimated, setIsEstimated] = useState<boolean | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [detail, setDetail] = useState<ConsumptionSettlement | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [genOpen, setGenOpen] = useState(false);
  const [genIdemKey, setGenIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<EstimatePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [genForm] = Form.useForm<GenerateFormValues>();
  // 账户变化后预览作废 —— 避免把别的账户的建议量当成依据（账期侧在
  // DatePicker onChange 里同样处理）。setState 走 microtask，不在 effect
  // 内同步触发级联渲染。
  const genAccountId = Form.useWatch('waterAccountId', genForm);
  useEffect(() => {
    queueMicrotask(() => setPreview(null));
  }, [genAccountId]);

  const [acting, setActing] = useState<string | null>(null);

  const effectiveAccountId = canCustomerRead
    ? waterAccountId
    : UUID_RE.test(accountIdInput.trim())
      ? accountIdInput.trim()
      : undefined;

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<ConsumptionSettlement[]>('/consumption-settlements', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(effectiveAccountId ? { waterAccountId: effectiveAccountId } : {}),
            ...(period ? { period: period.format('YYYYMM') } : {}),
            ...(status ? { status } : {}),
            ...(isEstimated !== undefined ? { isEstimated: String(isEstimated) } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [effectiveAccountId, isEstimated, message, period, status],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  const accountLabel = useWaterAccountLabels(rows.map((r) => r.waterAccountId));

  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const openDetail = async (row: ConsumptionSettlement) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api.get<ConsumptionSettlement>(`/consumption-settlements/${row.id}`);
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const finalize = async (row: ConsumptionSettlement) => {
    setActing(row.id);
    try {
      await api.post(
        `/consumption-settlements/${row.id}/finalize`,
        {},
        { headers: { 'Idempotency-Key': newIdemKey() } },
      );
      message.success(`${fmtPeriod(row.period)} 结算已终审`);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setActing(null);
      // Resync even on failure so a stale status/action button can't linger.
      await load(page, pageSize);
    }
  };

  const doPreview = async () => {
    const values = genForm.getFieldsValue();
    if (!values.waterAccountId || !values.period) {
      message.warning('请先选择水表户与账期');
      return;
    }
    setPreviewing(true);
    try {
      const res = await api.post<EstimatePreview>('/estimate/preview', {
        waterAccountId: values.waterAccountId,
        period: values.period.format('YYYYMM'),
      });
      setPreview(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  const submitGenerate = async () => {
    let values: GenerateFormValues;
    try {
      values = await genForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      await api.post(
        '/consumption-settlements',
        cleanBody({
          waterAccountId: values.waterAccountId,
          period: values.period.format('YYYYMM'),
          usageQty: values.usageQty,
          estimateReason: values.estimateReason,
        }),
        { headers: { 'Idempotency-Key': genIdemKey } },
      );
      message.success('结算已生成（草稿）');
      setGenOpen(false);
      await load(page, pageSize);
    } catch (err) {
      // SETTLEMENT_ALREADY_EXISTS / ESTIMATE_REASON_REQUIRED / NO_INSTALLATION_IN_PERIOD…
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<ConsumptionSettlement> = [
    {
      title: '账期',
      dataIndex: 'period',
      key: 'period',
      width: 95,
      render: fmtPeriod,
    },
    {
      title: '水表户',
      dataIndex: 'waterAccountId',
      key: 'waterAccountId',
      width: 150,
      render: (id: string) => (
        <Tooltip title={id}>
          <span>{accountLabel(id)}</span>
        </Tooltip>
      ),
    },
    {
      title: '结算水量',
      dataIndex: 'totalUsageQty',
      key: 'totalUsageQty',
      width: 110,
      align: 'right',
    },
    {
      title: '口径',
      key: 'estimated',
      width: 130,
      render: (_: unknown, r: ConsumptionSettlement) =>
        r.isEstimated ? (
          <Tag color="orange">
            预估{r.estimateMethod ? `（${ESTIMATE_METHOD_LABELS[r.estimateMethod]}）` : ''}
          </Tag>
        ) : (
          <Tag color="green">实读</Tag>
        ),
    },
    {
      title: '连续预估',
      dataIndex: 'consecutiveEstimates',
      key: 'consecutiveEstimates',
      width: 95,
      render: (n: number) =>
        n > 0 ? <Tag color={n >= 3 ? 'red' : 'orange'}>{n} 期</Tag> : '—',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: SettlementStatus) => (
        <Tag color={SETTLEMENT_STATUS_COLORS[s]}>{SETTLEMENT_STATUS_LABELS[s]}</Tag>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 165,
      render: fmtTime,
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_: unknown, record: ConsumptionSettlement) => (
        <Space size={4} wrap>
          <Button size="small" icon={<SearchOutlined />} onClick={() => void openDetail(record)}>
            详情
          </Button>
          {canWrite && record.status === 'DRAFT' && (
            <Popconfirm
              title={`终审 ${fmtPeriod(record.period)} 结算？`}
              description="终审后不可修改；错误终审通过补差处理。"
              okText="终审"
              cancelText="取消"
              onConfirm={() => void finalize(record)}
            >
              <Button
                size="small"
                type="primary"
                ghost
                icon={<CheckCircleOutlined />}
                loading={acting === record.id}
              >
                终审
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const componentColumns: ColumnsType<ConsumptionComponent> = [
    {
      title: '安装记录',
      dataIndex: 'installationId',
      key: 'installationId',
      width: 110,
      render: (id: string) => (
        <Tooltip title={id}>
          <span style={{ fontFamily: 'monospace' }}>{id.slice(0, 8)}…</span>
        </Tooltip>
      ),
    },
    {
      title: '来源',
      dataIndex: 'sourceType',
      key: 'sourceType',
      width: 80,
      render: (t: ConsumptionComponent['sourceType']) => (
        <Tag color={COMPONENT_SOURCE_COLORS[t]}>{COMPONENT_SOURCE_LABELS[t]}</Tag>
      ),
    },
    {
      title: '上期读数',
      dataIndex: 'prevReadingValue',
      key: 'prevReadingValue',
      width: 100,
      align: 'right',
    },
    {
      title: '本期读数',
      dataIndex: 'endReadingValue',
      key: 'endReadingValue',
      width: 100,
      align: 'right',
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '用量',
      dataIndex: 'usageQty',
      key: 'usageQty',
      width: 90,
      align: 'right',
    },
    {
      title: '来源读数',
      dataIndex: 'sourceReadingId',
      key: 'sourceReadingId',
      width: 110,
      render: (id: string | null) =>
        id ? (
          <Tooltip title={id}>
            <span style={{ fontFamily: 'monospace' }}>{id.slice(0, 8)}…</span>
          </Tooltip>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <Card
      title="结算水量"
      extra={
        <Space wrap>
          {canCustomerRead ? (
            <>
              <span style={{ width: 180, display: 'inline-block' }}>
                <CustomerSelect
                  value={filterCustomerId}
                  onChange={(v) => {
                    setFilterCustomerId(v);
                    setWaterAccountId(undefined);
                    setPage(1);
                  }}
                  placeholder="按客户过滤"
                />
              </span>
              <span style={{ width: 220, display: 'inline-block' }}>
                <WaterAccountSelect
                  customerId={filterCustomerId}
                  value={waterAccountId}
                  onChange={(v) => {
                    setWaterAccountId(v);
                    setPage(1);
                  }}
                  placeholder="按水表户过滤"
                />
              </span>
            </>
          ) : (
            <Input.Search
              allowClear
              placeholder="按水表户 ID 过滤"
              style={{ width: 260 }}
              value={accountIdInput}
              onChange={(e) => setAccountIdInput(e.target.value)}
              onSearch={() => setPage(1)}
            />
          )}
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
            placeholder="状态"
            style={{ width: 100 }}
            options={(['DRAFT', 'FINAL'] as const).map((s) => ({
              value: s,
              label: SETTLEMENT_STATUS_LABELS[s],
            }))}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          <Select
            allowClear
            placeholder="口径"
            style={{ width: 100 }}
            options={[
              { value: 'true', label: '预估' },
              { value: 'false', label: '实读' },
            ]}
            value={isEstimated === undefined ? undefined : String(isEstimated)}
            onChange={(v) => {
              setIsEstimated(v === undefined ? undefined : v === 'true');
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(page, pageSize)}>
            刷新
          </Button>
          {canWrite && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                genForm.resetFields();
                setPreview(null);
                setGenIdemKey(newIdemKey());
                setGenOpen(true);
              }}
            >
              生成结算
            </Button>
          )}
        </Space>
      }
    >
      <Table<ConsumptionSettlement>
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

      {/* 详情抽屉 */}
      <Drawer
        open={detail !== null || detailLoading}
        width={720}
        title={
          detail
            ? `结算详情 — ${accountLabel(detail.waterAccountId)} · ${fmtPeriod(detail.period)}`
            : '结算详情'
        }
        onClose={() => setDetail(null)}
      >
        {detailLoading || !detail ? (
          <Spin />
        ) : (
          <>
            <Descriptions
              bordered
              size="small"
              column={2}
              items={[
                { key: 'period', label: '账期', children: fmtPeriod(detail.period) },
                {
                  key: 'status',
                  label: '状态',
                  children: (
                    <Tag color={SETTLEMENT_STATUS_COLORS[detail.status]}>
                      {SETTLEMENT_STATUS_LABELS[detail.status]}
                    </Tag>
                  ),
                },
                {
                  key: 'wa',
                  label: '水表户',
                  children: accountLabel(detail.waterAccountId),
                },
                {
                  key: 'total',
                  label: '结算水量',
                  children: detail.totalUsageQty,
                },
                {
                  key: 'est',
                  label: '口径',
                  children: detail.isEstimated ? (
                    <Tag color="orange">预估</Tag>
                  ) : (
                    <Tag color="green">实读</Tag>
                  ),
                },
                {
                  key: 'streak',
                  label: '连续预估',
                  children:
                    detail.consecutiveEstimates > 0
                      ? `${detail.consecutiveEstimates} 期`
                      : '—',
                },
                ...(detail.isEstimated
                  ? [
                      {
                        key: 'method',
                        label: '预估方式',
                        children: detail.estimateMethod
                          ? ESTIMATE_METHOD_LABELS[detail.estimateMethod]
                          : '—',
                      },
                      {
                        key: 'reason',
                        label: '预估原因',
                        children: detail.estimateReason ?? '—',
                      },
                      {
                        key: 'basis',
                        label: '预估依据（历史用量）',
                        children:
                          detail.estimateBasis?.historyUsageQtys?.join(' / ') || '—',
                      },
                    ]
                  : []),
                { key: 'created', label: '创建时间', children: fmtTime(detail.createdAt) },
              ]}
            />
            <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>结算分量</div>
            <Table<ConsumptionComponent>
              rowKey="id"
              size="small"
              columns={componentColumns}
              dataSource={detail.components}
              pagination={false}
            />
          </>
        )}
      </Drawer>

      {/* 生成结算 */}
      <Modal
        open={genOpen}
        title="生成结算（草稿）"
        okText="生成"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitGenerate()}
        onCancel={() => setGenOpen(false)}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="任一分量按预估口径结算时，预估原因为必填；usageQty 是单一预估分量的快捷用量覆盖。"
        />
        <Form form={genForm} layout="vertical">
          {canCustomerRead ? (
            <>
              <Form.Item name="customerId" label="客户（仅用于过滤水表户）">
                <CustomerSelect />
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(a, b) => a.customerId !== b.customerId}>
                {({ getFieldValue }) => (
                  <Form.Item
                    name="waterAccountId"
                    label="水表户"
                    rules={[{ required: true, message: '请选择水表户' }]}
                  >
                    <WaterAccountSelect customerId={getFieldValue('customerId')} />
                  </Form.Item>
                )}
              </Form.Item>
            </>
          ) : (
            <Form.Item
              name="waterAccountId"
              label="水表户 ID"
              rules={[
                { required: true, message: '请输入水表户 ID' },
                { pattern: UUID_RE, message: 'ID 格式不正确' },
              ]}
              extra="无客户查询权限，需直接填写水表户 ID"
            >
              <Input placeholder="水表户 uuid" />
            </Form.Item>
          )}
          <Form.Item
            name="period"
            label="账期"
            rules={[{ required: true, message: '请选择账期' }]}
          >
            <DatePicker
              picker="month"
              style={{ width: '100%' }}
              onChange={() => setPreview(null)}
            />
          </Form.Item>
          <Form.Item label="预估预览">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button
                icon={<SearchOutlined />}
                loading={previewing}
                onClick={() => void doPreview()}
              >
                查询 AUTO_AVG3 建议用量
              </Button>
              {preview && (
                <Alert
                  type={preview.suggestedUsage === null ? 'warning' : 'success'}
                  showIcon
                  message={
                    preview.suggestedUsage === null
                      ? '无历史实读用量，建议手工填写用量'
                      : `建议用量 ${preview.suggestedUsage}（${ESTIMATE_METHOD_LABELS[preview.method]}）`
                  }
                  description={
                    preview.basis.historyUsageQtys.length > 0
                      ? `依据：近 ${preview.basis.window} 期实读用量 ${preview.basis.historyUsageQtys.join(' / ')}`
                      : undefined
                  }
                />
              )}
            </Space>
          </Form.Item>
          <Form.Item
            name="usageQty"
            label="预估用量（可空）"
            rules={[DECIMAL_RULE]}
            extra="仅当恰有一个分量走预估时生效；多分量请走服务端 overrides"
          >
            <Input placeholder="如 12.5" />
          </Form.Item>
          <Form.Item
            name="estimateReason"
            label="预估原因"
            extra="含预估分量时必填"
          >
            <Input.TextArea rows={2} placeholder="如：连续两月未抄见，按近三月均量预估" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
