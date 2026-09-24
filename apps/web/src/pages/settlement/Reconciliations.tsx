import {
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
import type { ReconStatus, Reconciliation, ReconciliationCreated } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  cleanBody,
  fmtCent,
  fmtPeriod,
  fmtTime,
  newIdemKey,
  useWaterAccountLabels,
} from '../common';
import { CustomerSelect, WaterAccountSelect } from '../pickers';
import { RECON_STATUS_COLORS, RECON_STATUS_LABELS } from './common';

interface CreateFormValues {
  customerId?: string; // 仅级联过滤
  waterAccountId: string;
  actualReadingId?: string;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const RESULT_TEXT: Record<ReconStatus, string> = {
  DRAFT: '补差记录已创建（草稿）',
  ABSORBED: '差额已吸收进当期草稿结算',
  APPLIED: '已重算并生成调账账单',
  MANUAL_REVIEW: '已记录为待人工复核（换表或表码回退）',
};

/** 剩余用量带符号展示：+ 少抄（需补收）/ − 多抄（需冲减）。 */
const signedQty = (v: string | null) => {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return (
    <span style={{ color: n > 0 ? '#cf1322' : n < 0 ? '#1677ff' : undefined }}>
      {n > 0 ? `+${v}` : v} m³
    </span>
  );
};

/** 把技术状态翻译为业务人员能看懂的一句话。 */
const reconSummary = (d: Reconciliation): string => {
  const remainder = Number(d.remainderUsage ?? 0);
  const adj = Number(d.adjustmentAmountCent ?? 0) / 100;
  switch (d.status) {
    case 'ABSORBED':
      return `区间实际比已结算多 ${Math.abs(remainder)} m³，差额已并入当期草稿结算，随本期账单一并收取，不产生额外调账单。`;
    case 'APPLIED':
      if (adj > 0)
        return `区间实际用量多于已出账，按资费重算后需补收 ¥${adj.toFixed(2)}，已生成补收调账单。`;
      if (adj < 0)
        return `区间实际用量少于已出账（此前估水偏多），按资费重算后冲减 ¥${Math.abs(adj).toFixed(2)}，已生成冲减调账单用于抵减欠费；已收款部分不会自动退现金。`;
      return '按资费重算后差额为零，不产生任何调账。';
    case 'MANUAL_REVIEW':
      return '恢复实抄的表码低于此前估计止度（可能换表或表码回退），系统未改动任何结算与账单，请人工核对后处理。';
    default:
      return '草稿记录，尚未执行重算。';
  }
};

/**
 * 补差（Reconciliation）：两次可信实抄之间的校准 —— 列表 + 发起
 * （留空取最新可信实抄）+ 详情抽屉。写操作走 billing:write。
 */
export default function Reconciliations() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('billing:write');
  const canCustomerRead = hasPerm('customer:read');

  const [rows, setRows] = useState<Reconciliation[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterCustomerId, setFilterCustomerId] = useState<string | undefined>(undefined);
  const [waterAccountId, setWaterAccountId] = useState<string | undefined>(undefined);
  const [accountIdInput, setAccountIdInput] = useState('');
  const [status, setStatus] = useState<ReconStatus | undefined>(undefined);
  const [period, setPeriod] = useState<dayjs.Dayjs | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [detail, setDetail] = useState<Reconciliation | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createIdemKey, setCreateIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [createForm] = Form.useForm<CreateFormValues>();

  const effectiveAccountId = canCustomerRead
    ? waterAccountId
    : UUID_RE.test(accountIdInput.trim())
      ? accountIdInput.trim()
      : undefined;

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<Reconciliation[]>('/reconciliations', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(effectiveAccountId ? { waterAccountId: effectiveAccountId } : {}),
            ...(status ? { status } : {}),
            ...(period ? { period: period.format('YYYYMM') } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [effectiveAccountId, message, period, status],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  const accountLabel = useWaterAccountLabels(rows.map((r) => r.waterAccountId));

  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const openDetail = async (row: Reconciliation) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api.get<Reconciliation>(`/reconciliations/${row.id}`);
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setDetailLoading(false);
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
      const res = await api.post<ReconciliationCreated>(
        '/reconciliations',
        cleanBody({
          waterAccountId: values.waterAccountId,
          actualReadingId: values.actualReadingId,
        }),
        { headers: { 'Idempotency-Key': createIdemKey } },
      );
      const extra =
        res.data.status === 'APPLIED' && res.data.adjustmentBill
          ? `，调账金额 ${fmtCent(res.data.adjustmentAmountCent)}`
          : '';
      // Zero-delta APPLIED mints no bill — don't claim one was generated.
      const text =
        res.data.status === 'APPLIED' && !res.data.adjustmentBill
          ? '已重算，差额为零（无调账账单）'
          : RESULT_TEXT[res.data.status];
      message.success(`${text}${extra}`);
      setCreateOpen(false);
      await load(page, pageSize);
    } catch (err) {
      // RECONCILIATION_EXISTS / EMPTY_SPAN / UNBILLED_SPAN / ANCHOR_NOT_FOUND…
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<Reconciliation> = [
    {
      title: '用水户',
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
      title: '补差区间',
      key: 'span',
      width: 170,
      render: (_: unknown, r: Reconciliation) =>
        `${fmtPeriod(r.fromPeriod)} → ${fmtPeriod(r.toPeriod)}`,
    },
    {
      title: '实抄总用量',
      dataIndex: 'actualTotalUsage',
      key: 'actualTotalUsage',
      width: 105,
      align: 'right',
    },
    {
      title: '已结算用量',
      dataIndex: 'previouslySettledUsage',
      key: 'previouslySettledUsage',
      width: 105,
      align: 'right',
    },
    {
      title: '剩余用量',
      dataIndex: 'remainderUsage',
      key: 'remainderUsage',
      width: 105,
      align: 'right',
      render: signedQty,
    },
    {
      title: '调账金额',
      dataIndex: 'adjustmentAmountCent',
      key: 'adjustmentAmountCent',
      width: 105,
      align: 'right',
      render: (v: string | null) => {
        const n = Number(v ?? 0) / 100;
        if (!v || !Number.isFinite(n) || n === 0) return fmtCent(v);
        return (
          <span style={{ color: n > 0 ? '#cf1322' : '#1677ff' }}>
            {n > 0 ? `补收 ¥${n.toFixed(2)}` : `冲减 ¥${Math.abs(n).toFixed(2)}`}
          </span>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 95,
      render: (s: ReconStatus) => (
        <Tag color={RECON_STATUS_COLORS[s]}>{RECON_STATUS_LABELS[s]}</Tag>
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
      width: 80,
      render: (_: unknown, record: Reconciliation) => (
        <Button size="small" icon={<SearchOutlined />} onClick={() => void openDetail(record)}>
          详情
        </Button>
      ),
    },
  ];

  const shortId = (id: string | null) =>
    id ? (
      <Tooltip title={id}>
        <span style={{ fontFamily: 'monospace' }}>{id.slice(0, 8)}…</span>
      </Tooltip>
    ) : (
      '—'
    );

  return (
    <Card
      title="补差管理"
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
                  placeholder="按用水户过滤"
                />
              </span>
            </>
          ) : (
            <Input.Search
              allowClear
              placeholder="按用水户 ID 过滤"
              style={{ width: 260 }}
              value={accountIdInput}
              onChange={(e) => setAccountIdInput(e.target.value)}
              onSearch={() => setPage(1)}
            />
          )}
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 110 }}
            options={(['DRAFT', 'ABSORBED', 'APPLIED', 'MANUAL_REVIEW'] as const).map(
              (s) => ({ value: s, label: RECON_STATUS_LABELS[s] }),
            )}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          <DatePicker
            picker="month"
            allowClear
            placeholder="覆盖账期"
            value={period}
            onChange={(v) => {
              setPeriod(v);
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
                createForm.resetFields();
                setCreateIdemKey(newIdemKey());
                setCreateOpen(true);
              }}
            >
              发起补差
            </Button>
          )}
        </Space>
      }
    >
      <Table<Reconciliation>
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

      {/* 发起补差 */}
      <Modal
        open={createOpen}
        title="发起补差"
        okText="发起"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitCreate()}
        onCancel={() => setCreateOpen(false)}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="以最新可信实抄为终点、上一次可信实抄为锚点，对区间内已结算水量进行校准：可吸收进当期草稿结算，或对已出账区间生成调账账单。"
          description="恢复实抄低于此前估计止度时，应先校正已出账估水，再生成恢复实抄当期的结算。已收款不代表无需补差；减收调整不会自动执行现金退款。"
        />
        <Form form={createForm} layout="vertical">
          {canCustomerRead ? (
            <>
              <Form.Item name="customerId" label="客户（仅用于过滤用水户）">
                <CustomerSelect />
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(a, b) => a.customerId !== b.customerId}>
                {({ getFieldValue }) => (
                  <Form.Item
                    name="waterAccountId"
                    label="用水户"
                    rules={[{ required: true, message: '请选择用水户' }]}
                  >
                    <WaterAccountSelect customerId={getFieldValue('customerId')} />
                  </Form.Item>
                )}
              </Form.Item>
            </>
          ) : (
            <Form.Item
              name="waterAccountId"
              label="用水户 ID"
              rules={[
                { required: true, message: '请输入用水户 ID' },
                { pattern: UUID_RE, message: 'ID 格式不正确' },
              ]}
              extra="无客户查询权限，需直接填写用水户 ID"
            >
              <Input placeholder="用水户 uuid" />
            </Form.Item>
          )}
          <Form.Item
            name="actualReadingId"
            label="实抄读数 ID（可空）"
            rules={[{ pattern: UUID_RE, message: 'ID 格式不正确' }]}
            extra="留空自动取该户最新一条可信实抄（质检通过的实抄/远传）"
          >
            <Input placeholder="meter_reading uuid" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 详情抽屉 */}
      <Drawer
        open={detail !== null || detailLoading}
        width={560}
        title={
          detail
            ? `补差详情 — ${accountLabel(detail.waterAccountId)}`
            : '补差详情'
        }
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
              {
                key: 'wa',
                label: '用水户',
                children: accountLabel(detail.waterAccountId),
              },
              {
                key: 'status',
                label: '状态',
                children: (
                  <Tag color={RECON_STATUS_COLORS[detail.status]}>
                    {RECON_STATUS_LABELS[detail.status]}
                  </Tag>
                ),
              },
              {
                key: 'span',
                label: '补差区间',
                children: `${fmtPeriod(detail.fromPeriod)} → ${fmtPeriod(detail.toPeriod)}`,
              },
              {
                key: 'anchor',
                label: '锚点读数',
                children: shortId(detail.anchorReadingId),
              },
              {
                key: 'actual',
                label: '实抄读数',
                children: shortId(detail.actualReadingId),
              },
              {
                key: 'actualTotal',
                label: '实抄总用量',
                children: detail.actualTotalUsage,
              },
              {
                key: 'settled',
                label: '已结算用量（终审）',
                children: detail.previouslySettledUsage,
              },
              {
                key: 'absorbed',
                label: '吸收至结算',
                children: shortId(detail.absorbedSettlementId),
              },
              {
                key: 'correct',
                label: '应计费金额',
                children: fmtCent(detail.correctChargeCent),
              },
              {
                key: 'posted',
                label: '已出账金额',
                children: fmtCent(detail.postedChargeCent),
              },
              {
                key: 'adjustment',
                label: '调账金额',
                children: fmtCent(detail.adjustmentAmountCent),
              },
              {
                key: 'remainder',
                label: '剩余用量',
                children: signedQty(detail.remainderUsage),
              },
              {
                key: 'created',
                label: '创建时间',
                children: fmtTime(detail.createdAt),
              },
            ]}
          />
        )}
        {detail && (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 16 }}
            message="业务含义"
            description={reconSummary(detail)}
          />
        )}
      </Drawer>
    </Card>
  );
}
