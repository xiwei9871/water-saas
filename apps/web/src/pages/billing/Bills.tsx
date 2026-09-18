import {
  ReloadOutlined,
  SearchOutlined,
  SwapOutlined,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  Bill,
  BillDetail,
  BillItem,
  BillStatus,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  DECIMAL_RULE,
  fmtCent,
  fmtDate,
  fmtPeriod,
  fmtTime,
  newIdemKey,
  useWaterAccountLabels,
} from '../common';
import { CustomerSelect, SettleAccountSelect, WaterAccountSelect } from '../pickers';
import {
  BILL_ITEM_TYPE_LABELS,
  BILL_KIND_COLORS,
  BILL_KIND_LABELS,
  BILL_SOURCE_TYPE_LABELS,
  BILL_STATUS_COLORS,
  BILL_STATUS_LABELS,
} from './common';

interface ReplaceFormValues {
  usageQty: string;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const shortId = (id: string | null | undefined) =>
  id ? (
    <Tooltip title={id}>
      <span style={{ fontFamily: 'monospace' }}>{id.slice(0, 8)}…</span>
    </Tooltip>
  ) : (
    '—'
  );

/** 可纠正（红冲/换票）的账单：POSTED|PARTIAL_PAID 且非红冲单。 */
const correctable = (b: Bill) =>
  b.billKind !== 'REVERSAL' && (b.status === 'POSTED' || b.status === 'PARTIAL_PAID');

/**
 * 账单（Bill）：已出账债权 —— 列表 + 全条件过滤 + 明细抽屉 +
 * 红冲（生成 REVERSAL 负单）/ 换票（按原资费版本以新用量重开
 * REPLACEMENT 单）。已出账财务事实永不改写，纠错只追加。
 */
export default function Bills() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('billing:write');
  const canCustomerRead = hasPerm('customer:read');

  const [rows, setRows] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterCustomerId, setFilterCustomerId] = useState<string | undefined>(undefined);
  const [waterAccountId, setWaterAccountId] = useState<string | undefined>(undefined);
  const [accountIdInput, setAccountIdInput] = useState('');
  const [settleAccountId, setSettleAccountId] = useState<string | undefined>(undefined);
  const [settleIdInput, setSettleIdInput] = useState('');
  const [runIdInput, setRunIdInput] = useState('');
  const [billingRunId, setBillingRunId] = useState('');
  const [period, setPeriod] = useState<dayjs.Dayjs | null>(null);
  const [status, setStatus] = useState<BillStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [detail, setDetail] = useState<BillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [replaceFor, setReplaceFor] = useState<Bill | null>(null);
  const [replaceIdemKey, setReplaceIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [replaceForm] = Form.useForm<ReplaceFormValues>();

  const effectiveAccountId = canCustomerRead
    ? waterAccountId
    : UUID_RE.test(accountIdInput.trim())
      ? accountIdInput.trim()
      : undefined;
  const effectiveSettleId = canCustomerRead
    ? settleAccountId
    : UUID_RE.test(settleIdInput.trim())
      ? settleIdInput.trim()
      : undefined;
  const effectiveRunId = UUID_RE.test(billingRunId.trim())
    ? billingRunId.trim()
    : undefined;

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<Bill[]>('/bills', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(period ? { period: period.format('YYYYMM') } : {}),
            ...(status ? { status } : {}),
            ...(effectiveAccountId ? { waterAccountId: effectiveAccountId } : {}),
            ...(effectiveSettleId ? { settleAccountId: effectiveSettleId } : {}),
            ...(effectiveRunId ? { billingRunId: effectiveRunId } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [effectiveAccountId, effectiveRunId, effectiveSettleId, message, period, status],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  const accountLabel = useWaterAccountLabels(rows.map((r) => r.waterAccountId));

  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const detailSeq = useRef(0);

  const openDetail = async (row: Bill) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api.get<BillDetail>(`/bills/${row.id}`);
      if (seq === detailSeq.current) setDetail(res.data);
    } catch (err) {
      if (seq === detailSeq.current) message.error(apiErrorText(err));
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  };

  /** 红冲：原单翻 REVERSED + 生成 POSTED REVERSAL 负单（幂等键随动作生成）。 */
  const reverse = async (bill: Bill) => {
    setActing(bill.id);
    try {
      const res = await api.post<BillDetail>(
        `/bills/${bill.id}/reverse`,
        {},
        { headers: { 'Idempotency-Key': newIdemKey() } },
      );
      message.success(
        `已红冲：原单转“已红冲”，生成红冲单（${fmtCent(res.data.totalAmount)}）`,
      );
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setActing(null);
      await load(page, pageSize);
      if (detail?.id === bill.id) void openDetail(bill);
    }
  };

  const openReplace = (bill: Bill) => {
    replaceForm.resetFields();
    setReplaceIdemKey(newIdemKey());
    setReplaceFor(bill);
  };

  const submitReplace = async () => {
    let values: ReplaceFormValues;
    try {
      values = await replaceForm.validateFields();
    } catch {
      return;
    }
    if (!replaceFor) return;
    setSaving(true);
    try {
      const res = await api.post<BillDetail>(
        `/bills/${replaceFor.id}/replace`,
        { usageQty: values.usageQty.trim() },
        { headers: { 'Idempotency-Key': replaceIdemKey } },
      );
      message.success(
        `已换票重开：原单红冲，新单金额 ${fmtCent(res.data.totalAmount)}（沿用原资费版本计价）`,
      );
      setReplaceFor(null);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
      if (detail?.id === replaceFor.id) void openDetail(replaceFor);
    }
  };

  const columns: ColumnsType<Bill> = [
    { title: '账期', dataIndex: 'period', key: 'period', width: 90, render: fmtPeriod },
    {
      title: '水表户',
      dataIndex: 'waterAccountId',
      key: 'waterAccountId',
      width: 140,
      render: (id: string) => (
        <Tooltip title={id}>
          <span>{accountLabel(id)}</span>
        </Tooltip>
      ),
    },
    {
      title: '结算户',
      dataIndex: 'settleAccountId',
      key: 'settleAccountId',
      width: 110,
      render: shortId,
    },
    {
      title: '类型',
      dataIndex: 'billKind',
      key: 'billKind',
      width: 95,
      render: (k: Bill['billKind']) => (
        <Tag color={BILL_KIND_COLORS[k]}>{BILL_KIND_LABELS[k]}</Tag>
      ),
    },
    {
      title: '金额',
      dataIndex: 'totalAmount',
      key: 'totalAmount',
      width: 110,
      align: 'right',
      render: (v: string) => fmtCent(v),
    },
    {
      title: '口径',
      dataIndex: 'isEstimated',
      key: 'isEstimated',
      width: 60,
      render: (e: boolean) => (e ? <Tag color="orange">估</Tag> : '—'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 95,
      render: (s: BillStatus) => (
        <Tag color={BILL_STATUS_COLORS[s]}>{BILL_STATUS_LABELS[s]}</Tag>
      ),
    },
    {
      title: '到期日',
      dataIndex: 'dueDate',
      key: 'dueDate',
      width: 105,
      render: fmtDate,
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
      width: 210,
      render: (_: unknown, record: Bill) => (
        <Space size={4} wrap>
          <Button size="small" icon={<SearchOutlined />} onClick={() => void openDetail(record)}>
            详情
          </Button>
          {canWrite && correctable(record) && (
            <>
              <Popconfirm
                title={`红冲账单 ${fmtCent(record.totalAmount)}？`}
                description="原单转“已红冲”，同时生成一张 POSTED 红冲负单冲抵 —— 财务事实追加不改写。"
                okText="红冲"
                okButtonProps={{ danger: true, loading: acting === record.id }}
                cancelText="取消"
                onConfirm={() => void reverse(record)}
              >
                <Button size="small" danger loading={acting === record.id}>
                  红冲
                </Button>
              </Popconfirm>
              <Button
                size="small"
                icon={<SwapOutlined />}
                onClick={() => openReplace(record)}
              >
                换票
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ];

  const itemColumns: ColumnsType<BillItem> = [
    {
      title: '类型',
      dataIndex: 'itemType',
      key: 'itemType',
      width: 80,
      render: (t: BillItem['itemType']) => (
        <Tag color={t === 'NORMAL' ? 'blue' : 'orange'}>{BILL_ITEM_TYPE_LABELS[t]}</Tag>
      ),
    },
    {
      title: '费用项',
      dataIndex: 'feeItemId',
      key: 'feeItemId',
      width: 100,
      render: shortId,
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '数量',
      dataIndex: 'qty',
      key: 'qty',
      width: 90,
      align: 'right',
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '单价',
      dataIndex: 'unitPrice',
      key: 'unitPrice',
      width: 100,
      align: 'right',
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      width: 110,
      align: 'right',
      render: (v: string) => fmtCent(v),
    },
  ];

  return (
    <Card
      title="账单"
      extra={
        <Space wrap>
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
            style={{ width: 110 }}
            options={(['DRAFT', 'POSTED', 'PARTIAL_PAID', 'PAID', 'REVERSED'] as const).map(
              (s) => ({ value: s, label: BILL_STATUS_LABELS[s] }),
            )}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          {canCustomerRead ? (
            <>
              <span style={{ width: 170, display: 'inline-block' }}>
                <CustomerSelect
                  value={filterCustomerId}
                  onChange={(v) => {
                    setFilterCustomerId(v);
                    setWaterAccountId(undefined);
                    setPage(1);
                  }}
                  placeholder="先选客户（联动水表户）"
                />
              </span>
              <span style={{ width: 200, display: 'inline-block' }}>
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
              <span style={{ width: 200, display: 'inline-block' }}>
                <SettleAccountSelect
                  value={settleAccountId}
                  onChange={(v) => {
                    setSettleAccountId(v);
                    setPage(1);
                  }}
                  placeholder="按结算户过滤"
                />
              </span>
            </>
          ) : (
            <>
              <Input.Search
                allowClear
                placeholder="按水表户 ID 过滤"
                style={{ width: 220 }}
                value={accountIdInput}
                onChange={(e) => setAccountIdInput(e.target.value)}
                onSearch={() => setPage(1)}
              />
              <Input.Search
                allowClear
                placeholder="按结算户 ID 过滤"
                style={{ width: 220 }}
                value={settleIdInput}
                onChange={(e) => setSettleIdInput(e.target.value)}
                onSearch={() => setPage(1)}
              />
            </>
          )}
          <Input.Search
            allowClear
            placeholder="按批次 ID 过滤"
            style={{ width: 220 }}
            value={runIdInput}
            onChange={(e) => setRunIdInput(e.target.value)}
            onSearch={(v) => {
              setBillingRunId(v);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(page, pageSize)}>
            刷新
          </Button>
        </Space>
      }
    >
      <Table<Bill>
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 1400 }}
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

      {/* 换票重开 */}
      <Modal
        open={replaceFor !== null}
        title={
          replaceFor
            ? `换票重开 — ${fmtPeriod(replaceFor.period)} 账单（${fmtCent(replaceFor.totalAmount)}）`
            : ''
        }
        okText="重开"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitReplace()}
        onCancel={() => setReplaceFor(null)}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="换票 = 原单红冲 + 按原资费版本以新用量重开一张 POSTED 换票单；原结算记录不变。"
        />
        <Form form={replaceForm} layout="vertical">
          <Form.Item
            name="usageQty"
            label="更正后用量（m³）"
            rules={[{ required: true, message: '请输入用量' }, DECIMAL_RULE]}
          >
            <Input placeholder="如 48" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 账单详情抽屉 */}
      <Drawer
        open={detail !== null || detailLoading}
        width={760}
        title={
          detail
            ? `账单详情 — ${fmtPeriod(detail.period)} ${accountLabel(detail.waterAccountId)}`
            : '账单详情'
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
                    <Tag color={BILL_STATUS_COLORS[detail.status]}>
                      {BILL_STATUS_LABELS[detail.status]}
                    </Tag>
                  ),
                },
                {
                  key: 'kind',
                  label: '类型',
                  children: (
                    <Tag color={BILL_KIND_COLORS[detail.billKind]}>
                      {BILL_KIND_LABELS[detail.billKind]}
                    </Tag>
                  ),
                },
                {
                  key: 'amount',
                  label: '金额',
                  children: <b>{fmtCent(detail.totalAmount)}</b>,
                },
                {
                  key: 'wa',
                  label: '水表户',
                  children: accountLabel(detail.waterAccountId),
                },
                { key: 'sa', label: '结算户', children: shortId(detail.settleAccountId) },
                {
                  key: 'est',
                  label: '口径',
                  children: detail.isEstimated ? (
                    <Tag color="orange">预估结算</Tag>
                  ) : (
                    '实读'
                  ),
                },
                {
                  key: 'src',
                  label: '来源',
                  children: (
                    <Space size={4}>
                      {BILL_SOURCE_TYPE_LABELS[detail.sourceType]}
                      {shortId(detail.sourceId)}
                    </Space>
                  ),
                },
                {
                  key: 'run',
                  label: '开账批次',
                  children: shortId(detail.billingRunId),
                },
                {
                  key: 'tariff',
                  label: '资费版本',
                  children: shortId(detail.tariffPlanId),
                },
                {
                  key: 'issued',
                  label: '出账时间',
                  children: detail.issuedAt ? fmtTime(detail.issuedAt) : '—',
                },
                {
                  key: 'due',
                  label: '到期日',
                  children: fmtDate(detail.dueDate),
                },
              ]}
            />
            <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>账单明细</div>
            <Table<BillItem>
              rowKey="id"
              size="small"
              columns={itemColumns}
              dataSource={detail.items}
              pagination={false}
            />
            {canWrite && correctable(detail) && (
              <Space style={{ marginTop: 16 }}>
                <Popconfirm
                  title="红冲该账单？"
                  description="原单转“已红冲”，生成 POSTED 红冲负单冲抵。"
                  okText="红冲"
                  okButtonProps={{ danger: true, loading: acting === detail.id }}
                  cancelText="取消"
                  onConfirm={() => void reverse(detail)}
                >
                  <Button danger loading={acting === detail.id}>红冲</Button>
                </Popconfirm>
                <Button icon={<SwapOutlined />} onClick={() => openReplace(detail)}>
                  换票重开
                </Button>
              </Space>
            )}
          </>
        )}
      </Drawer>
    </Card>
  );
}
