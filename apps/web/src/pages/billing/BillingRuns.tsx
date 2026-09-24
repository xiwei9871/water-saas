import {
  DeleteOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RedoOutlined,
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
  BillingRun,
  BillingRunDetail,
  RunStatus,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { fmtCent, fmtPeriod, fmtTime, newIdemKey, useWaterAccountLabels } from '../common';
import {
  BILL_KIND_COLORS,
  BILL_KIND_LABELS,
  BILL_STATUS_COLORS,
  BILL_STATUS_LABELS,
  RUN_STATUS_COLORS,
  RUN_STATUS_LABELS,
  RUN_TYPE_LABELS,
} from './common';

interface CreateFormValues {
  period: dayjs.Dayjs;
}

/**
 * 开账批次（BillingRun）：POST 创建即同步生成该账期全部 FINAL 结算的
 * DRAFT 账单（试算）；post/retry 同步执行过账；DRAFT 可作废重跑。
 * post/retry/discard 为自幂等设计 —— 不带 Idempotency-Key。
 */
export default function BillingRuns() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('billing:write');

  const [rows, setRows] = useState<BillingRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<dayjs.Dayjs | null>(null);
  const [status, setStatus] = useState<RunStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [detail, setDetail] = useState<BillingRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createIdemKey, setCreateIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [createForm] = Form.useForm<CreateFormValues>();

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<BillingRun[]>('/billing-runs', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(period ? { period: period.format('YYYYMM') } : {}),
            ...(status ? { status } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [message, period, status],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const detailSeq = useRef(0);

  const openDetail = async (row: BillingRun) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api.get<BillingRunDetail>(`/billing-runs/${row.id}`);
      if (seq === detailSeq.current) setDetail(res.data);
    } catch (err) {
      if (seq === detailSeq.current) message.error(apiErrorText(err));
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
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
      const res = await api.post<BillingRunDetail>(
        '/billing-runs',
        { period: values.period.format('YYYYMM') },
        { headers: { 'Idempotency-Key': createIdemKey } },
      );
      const d = res.data;
      message.success(
        `已生成 ${d.bills.length} 张草稿账单（覆盖 ${d.totalCount} 户终审结算${
          d.failedCount > 0 ? `，${d.failedCount} 户失败` : ''
        }），核对后可执行开账`,
      );
      setCreateOpen(false);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 执行/重试/作废：批次级自幂等动作（claim guard + 逐账单事务），
   * 失败也重新加载，避免按钮停在过期状态。
   */
  const runAction = async (
    run: BillingRun,
    action: 'post' | 'retry' | 'discard',
    okText: string,
  ) => {
    setActing(run.id);
    try {
      const res = await api.post<BillingRunDetail & { deletedBillCount?: number }>(
        `/billing-runs/${run.id}/${action}`,
        {},
      );
      if (action === 'discard') {
        message.success(`批次已作废（删除 ${res.data.deletedBillCount ?? 0} 张草稿账单）`);
      } else {
        const d = res.data;
        message.success(
          `${okText}：成功 ${d.successCount}/${d.totalCount}${
            d.failedCount > 0 ? `，失败 ${d.failedCount}（详情见批次明细）` : ''
          }`,
        );
      }
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setActing(null);
      await load(page, pageSize);
      // 若详情抽屉正开着，同步刷新它。
      if (detail?.id === run.id) void openDetail(run);
    }
  };

  const detailAccountIds = useMemo(
    () => (detail?.bills ?? []).map((b) => b.waterAccountId),
    [detail],
  );
  const accountLabel = useWaterAccountLabels(detailAccountIds);

  const billColumns: ColumnsType<Bill> = [
    {
      title: '账单 ID',
      dataIndex: 'id',
      key: 'id',
      width: 100,
      render: (id: string) => (
        <Tooltip title={id}>
          <span style={{ fontFamily: 'monospace' }}>{id.slice(0, 8)}…</span>
        </Tooltip>
      ),
    },
    {
      title: '用水户',
      dataIndex: 'waterAccountId',
      key: 'waterAccountId',
      width: 140,
      render: (id: string) => accountLabel(id),
    },
    {
      title: '类型',
      dataIndex: 'billKind',
      key: 'billKind',
      width: 90,
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
      width: 70,
      render: (e: boolean) => (e ? <Tag color="orange">估</Tag> : '—'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: Bill['status']) => (
        <Tag color={BILL_STATUS_COLORS[s]}>{BILL_STATUS_LABELS[s]}</Tag>
      ),
    },
  ];

  const columns: ColumnsType<BillingRun> = [
    { title: '账期', dataIndex: 'period', key: 'period', width: 95, render: fmtPeriod },
    {
      title: '类型',
      dataIndex: 'runType',
      key: 'runType',
      width: 80,
      render: (t: BillingRun['runType']) => RUN_TYPE_LABELS[t],
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s: RunStatus) => (
        <Tag color={RUN_STATUS_COLORS[s]}>{RUN_STATUS_LABELS[s]}</Tag>
      ),
    },
    {
      title: '户数（成功/失败/总数）',
      key: 'counts',
      width: 170,
      render: (_: unknown, r: BillingRun) => (
        <span>
          <Tag color="green">{r.successCount}</Tag>
          <Tag color={r.failedCount > 0 ? 'red' : 'default'}>{r.failedCount}</Tag>
          <Tag>{r.totalCount}</Tag>
        </span>
      ),
    },
    {
      title: '过账时间',
      dataIndex: 'postedAt',
      key: 'postedAt',
      width: 165,
      render: (v: string | null) => (v ? fmtTime(v) : '—'),
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
      width: 300,
      render: (_: unknown, record: BillingRun) => (
        <Space size={4} wrap>
          <Button size="small" icon={<SearchOutlined />} onClick={() => void openDetail(record)}>
            详情
          </Button>
          {canWrite && (record.status === 'DRAFT' || record.status === 'PARTIAL') && (
            <Popconfirm
              title={`执行 ${fmtPeriod(record.period)} 开账？`}
              description="同步执行：重跑失败户并对所有草稿账单过账（DRAFT→POSTED）。"
              okText="执行"
              okButtonProps={{ loading: acting === record.id }}
              cancelText="取消"
              onConfirm={() => void runAction(record, 'post', '开账完成')}
            >
              <Button
                size="small"
                type="primary"
                ghost
                icon={<PlayCircleOutlined />}
                loading={acting === record.id}
              >
                执行开账
              </Button>
            </Popconfirm>
          )}
          {canWrite &&
            (record.status === 'PARTIAL' ||
              record.status === 'FAILED' ||
              record.status === 'PROCESSING') && (
              <Popconfirm
                title={`重试 ${fmtPeriod(record.period)} 批次？`}
                description="重跑失败明细（资费修正后重试是 PARTIAL→POSTED 的路径）。"
                okText="重试"
                okButtonProps={{ loading: acting === record.id }}
                cancelText="取消"
                onConfirm={() => void runAction(record, 'retry', '重试完成')}
              >
                <Button
                  size="small"
                  icon={<RedoOutlined />}
                  loading={acting === record.id}
                >
                  重试
                </Button>
              </Popconfirm>
            )}
          {canWrite && record.status === 'DRAFT' && (
            <Popconfirm
              title={`作废 ${fmtPeriod(record.period)} 批次？`}
              description="删除该批次及其全部草稿账单，账期可重新开账；已出账数据不会被删除。"
              okText="作废"
              okButtonProps={{ danger: true, loading: acting === record.id }}
              cancelText="取消"
              onConfirm={() => void runAction(record, 'discard', '已作废')}
            >
              <Button size="small" danger icon={<DeleteOutlined />} loading={acting === record.id}>
                作废
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const failures = detail?.failedSettlementIds ?? [];

  return (
    <Card
      title="开账批次"
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
            style={{ width: 140 }}
            options={(['DRAFT', 'PROCESSING', 'PARTIAL', 'POSTED', 'FAILED'] as const).map(
              (s) => ({ value: s, label: RUN_STATUS_LABELS[s] }),
            )}
            value={status}
            onChange={(v) => {
              setStatus(v);
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
              新建开账批次
            </Button>
          )}
        </Space>
      }
    >
      <Table<BillingRun>
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

      {/* 新建批次 */}
      <Modal
        open={createOpen}
        title="新建开账批次"
        okText="生成"
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
          message="创建批次会为该账期每一户已终审（FINAL）结算同步生成一张 DRAFT 草稿账单（试算，不出账）；无法计价的户记入失败明细，核对后可执行开账或作废重跑。"
        />
        <Form form={createForm} layout="vertical">
          <Form.Item
            name="period"
            label="账期"
            rules={[{ required: true, message: '请选择账期' }]}
          >
            <DatePicker picker="month" style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 批次详情抽屉 */}
      <Drawer
        open={detail !== null || detailLoading}
        width={760}
        title={detail ? `批次详情 — ${fmtPeriod(detail.period)}` : '批次详情'}
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
                    <Tag color={RUN_STATUS_COLORS[detail.status]}>
                      {RUN_STATUS_LABELS[detail.status]}
                    </Tag>
                  ),
                },
                { key: 'type', label: '类型', children: RUN_TYPE_LABELS[detail.runType] },
                {
                  key: 'counts',
                  label: '户数（成功/失败/总数）',
                  children: `${detail.successCount} / ${detail.failedCount} / ${detail.totalCount}`,
                },
                {
                  key: 'postedAt',
                  label: '过账时间',
                  children: detail.postedAt ? fmtTime(detail.postedAt) : '—',
                },
                { key: 'created', label: '创建时间', children: fmtTime(detail.createdAt) },
              ]}
            />
            {failures.length > 0 && (
              <>
                <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>失败明细</div>
                <Table
                  rowKey={(f) => `${f.settlementId}-${f.stage}`}
                  size="small"
                  dataSource={failures}
                  pagination={false}
                  columns={[
                    {
                      title: '结算 ID',
                      dataIndex: 'settlementId',
                      key: 'settlementId',
                      render: (id: string) => (
                        <Tooltip title={id}>
                          <span style={{ fontFamily: 'monospace' }}>{id.slice(0, 8)}…</span>
                        </Tooltip>
                      ),
                    },
                    {
                      title: '阶段',
                      dataIndex: 'stage',
                      key: 'stage',
                      width: 90,
                      render: (s: 'generate' | 'post') =>
                        s === 'generate' ? '生成' : '过账',
                    },
                    {
                      title: '错误码',
                      dataIndex: 'code',
                      key: 'code',
                      width: 180,
                      render: (c: string) => <Tag color="red">{c}</Tag>,
                    },
                    {
                      title: '说明',
                      dataIndex: 'message',
                      key: 'message',
                      ellipsis: true,
                      render: (m: string | undefined) => m ?? '—',
                    },
                  ]}
                />
              </>
            )}
            <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>
              批次账单（{detail.bills.length} 张）
            </div>
            <Table<Bill>
              rowKey="id"
              size="small"
              columns={billColumns}
              dataSource={detail.bills}
              pagination={false}
              scroll={{ y: 320 }}
              locale={{ emptyText: '本批次暂无账单' }}
            />
          </>
        )}
      </Drawer>
    </Card>
  );
}
