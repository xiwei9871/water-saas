import {
  CaretRightOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Radio,
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
  BookMember,
  PlanItemStatus,
  PlanStatus,
  ReadingBook,
  ReadingBookDetail,
  ReadingPlan,
  ReadingPlanDetail,
  ReadingPlanItem,
  ReadingPlanProgress,
  ReadResultType,
  Staff,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { EXCEPTION_CODES, READ_RESULT_TYPES } from '@ws/types';
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
  PLAN_ITEM_STATUS_COLORS,
  PLAN_ITEM_STATUS_LABELS,
  PLAN_STATUS_COLORS,
  PLAN_STATUS_LABELS,
  RESULT_TYPE_LABELS,
} from './common';
import { ReadingBookSelect, StaffSelect } from '../pickers';

interface GenerateFormValues {
  bookId: string;
  period: dayjs.Dayjs;
  planDate?: dayjs.Dayjs;
  readerId?: string;
}

interface EntryFormValues {
  resultType: ReadResultType;
  readingValue?: string;
  exceptionCode?: string;
  readDate?: dayjs.Dayjs;
  remark?: string;
}

interface BatchRowState {
  resultType: ReadResultType;
  readingValue: string;
  exceptionCode?: string;
}

const ITEM_STATUS_OPTIONS = (['PENDING', 'READ', 'NO_READ', 'SKIPPED'] as const).map(
  (s) => ({ value: s, label: PLAN_ITEM_STATUS_LABELS[s] }),
);

/** 可录入的明细状态：待抄 + 未抄见（未抄见允许重抄，服务端同样放行）。 */
const ENTRYABLE: PlanItemStatus[] = ['PENDING', 'NO_READ'];
/** 可继续抄表的计划状态。 */
const WRITABLE_PLAN: PlanStatus[] = ['OPEN', 'IN_PROGRESS'];

/**
 * 抄表计划：册/账期/状态过滤 + 生成 + 开始/取消 + 进度 + 明细抽屉
 * （明细行内抄表录入 + 批量录入）。
 */
export default function ReadingPlans() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('metering:write');
  const canIamRead = hasPerm('iam:read');

  const [rows, setRows] = useState<ReadingPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [bookId, setBookId] = useState<string | undefined>(undefined);
  const [period, setPeriod] = useState<dayjs.Dayjs | null>(null);
  const [status, setStatus] = useState<PlanStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [books, setBooks] = useState<ReadingBook[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [progressMap, setProgressMap] = useState<Map<string, ReadingPlanProgress>>(
    new Map(),
  );
  const [acting, setActing] = useState<string | null>(null); // in-flight plan id

  const [genOpen, setGenOpen] = useState(false);
  const [genIdemKey, setGenIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [genForm] = Form.useForm<GenerateFormValues>();

  // ---- 明细抽屉 ----
  const [drawerPlanId, setDrawerPlanId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReadingPlanDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailProgress, setDetailProgress] = useState<ReadingPlanProgress | null>(null);
  const [itemStatus, setItemStatus] = useState<PlanItemStatus | undefined>(undefined);
  const [memberLabels, setMemberLabels] = useState<Map<string, string>>(new Map());

  // ---- 抄表录入 ----
  const [entryItem, setEntryItem] = useState<ReadingPlanItem | null>(null);
  const [entryIdemKey, setEntryIdemKey] = useState('');
  const [entrySaving, setEntrySaving] = useState(false);
  const [entryForm] = Form.useForm<EntryFormValues>();
  const entryResultType = Form.useWatch('resultType', entryForm);

  // ---- 批量录入 ----
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchIdemKey, setBatchIdemKey] = useState('');
  const [batchRows, setBatchRows] = useState<Map<string, BatchRowState>>(new Map());
  const [batchSaving, setBatchSaving] = useState(false);

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<ReadingPlan[]>('/reading-plans', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(bookId ? { bookId } : {}),
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
    [bookId, message, period, status],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  // 册名/抄表员水合 + 当前页各计划进度。
  useEffect(() => {
    api
      .get<ReadingBook[]>('/reading-books', { params: { take: 200 } })
      .then((res) => setBooks(res.data))
      .catch(() => setBooks([]));
  }, []);

  useEffect(() => {
    if (!canIamRead) return;
    api
      .get<Staff[]>('/iam/staff')
      .then((res) => setStaff(res.data))
      .catch(() => setStaff([]));
  }, [canIamRead]);

  useEffect(() => {
    if (rows.length === 0) return;
    let cancelled = false;
    void Promise.all(
      rows.map((r) =>
        api
          .get<ReadingPlanProgress>(`/reading-plans/${r.id}/progress`)
          .then((res) => res.data)
          .catch(() => null),
      ),
    ).then((res) => {
      if (cancelled) return;
      setProgressMap((prev) => {
        const next = new Map(prev);
        res.forEach((p) => {
          if (p) next.set(p.planId, p);
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const bookLabel = useCallback(
    (id: string) => {
      const b = books.find((x) => x.id === id);
      return b ? `${b.name}（${b.bookNo}）` : `${id.slice(0, 8)}…`;
    },
    [books],
  );
  const staffName = useCallback(
    (id: string | null) => {
      if (!id) return '—';
      const s = staff.find((x) => x.id === id);
      return s ? `${s.name}（${s.login}）` : `${id.slice(0, 8)}…`;
    },
    [staff],
  );

  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  // ---- 计划动作 ----

  const planAction = async (plan: ReadingPlan, action: 'start' | 'cancel') => {
    setActing(plan.id);
    try {
      await api.post(
        `/reading-plans/${plan.id}/${action}`,
        {},
        { headers: { 'Idempotency-Key': newIdemKey() } },
      );
      message.success(action === 'start' ? '计划已开始' : '计划已取消');
      await load(page, pageSize);
      if (drawerPlanId === plan.id) await loadDetail(plan.id);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setActing(null);
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
        '/reading-plans/generate',
        cleanBody({
          bookId: values.bookId,
          period: values.period.format('YYYYMM'),
          planDate: values.planDate?.format('YYYY-MM-DD'),
          readerId: canIamRead ? values.readerId : undefined,
        }),
        { headers: { 'Idempotency-Key': genIdemKey } },
      );
      message.success('抄表计划已生成');
      setGenOpen(false);
      await load(page, pageSize);
    } catch (err) {
      // PLAN_ALREADY_EXISTS / EMPTY_BOOK 等直接透出。
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  // ---- 明细抽屉 ----

  const loadDetail = async (planId: string) => {
    setDetailLoading(true);
    try {
      const res = await api.get<ReadingPlanDetail>(`/reading-plans/${planId}`);
      setDetail(res.data);
      api
        .get<ReadingPlanProgress>(`/reading-plans/${planId}/progress`)
        .then((p) => setDetailProgress(p.data))
        .catch(() => setDetailProgress(null));
      // 册成员 → 户号/地址水合（册可能已删 —— 退化为短 id）。
      api
        .get<ReadingBookDetail>(`/reading-books/${res.data.bookId}`)
        .then((b) => {
          setMemberLabels(
            new Map(
              b.data.members.map((m: BookMember) => [
                m.waterAccountId,
                m.waterAccount
                  ? `${m.waterAccount.accountNo} · ${m.waterAccount.addr}`
                  : `${m.waterAccountId.slice(0, 8)}…`,
              ]),
            ),
          );
        })
        .catch(() => setMemberLabels(new Map()));
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const openDrawer = (plan: ReadingPlan) => {
    setDrawerPlanId(plan.id);
    setDetail(null);
    setDetailProgress(null);
    setItemStatus(undefined);
    setMemberLabels(new Map());
    void loadDetail(plan.id);
  };

  const accountLabel = (item: ReadingPlanItem) =>
    memberLabels.get(item.waterAccountId) ?? `${item.waterAccountId.slice(0, 8)}…`;

  const filteredItems = useMemo(
    () => (detail?.items ?? []).filter((i) => !itemStatus || i.status === itemStatus),
    [detail, itemStatus],
  );

  // ---- 抄表录入 ----

  const openEntry = (item: ReadingPlanItem) => {
    entryForm.resetFields();
    entryForm.setFieldsValue({ resultType: 'ACTUAL' });
    setEntryIdemKey(newIdemKey());
    setEntryItem(item);
  };

  const submitEntry = async () => {
    let values: EntryFormValues;
    try {
      values = await entryForm.validateFields();
    } catch {
      return;
    }
    if (!entryItem || !drawerPlanId) return;
    setEntrySaving(true);
    try {
      await api.post(
        '/meter-readings',
        cleanBody({
          planItemId: entryItem.id,
          resultType: values.resultType,
          // 形状规则：ACTUAL/REMOTE 带 readingValue，NO_READ 带 exceptionCode。
          ...(values.resultType === 'NO_READ'
            ? { exceptionCode: values.exceptionCode }
            : { readingValue: values.readingValue }),
          readDate: values.readDate?.format('YYYY-MM-DD'),
          remark: values.remark,
        }),
        { headers: { 'Idempotency-Key': entryIdemKey } },
      );
      message.success('抄表记录已录入');
      setEntryItem(null);
      await loadDetail(drawerPlanId);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
      // 明细可能已被他人完成 —— 刷新抽屉保持一致。
      await loadDetail(drawerPlanId);
    } finally {
      setEntrySaving(false);
    }
  };

  // ---- 批量录入 ----

  const openBatch = () => {
    const map = new Map<string, BatchRowState>();
    (detail?.items ?? [])
      .filter((i) => ENTRYABLE.includes(i.status))
      .forEach((i) =>
        map.set(i.id, { resultType: 'ACTUAL', readingValue: '', exceptionCode: undefined }),
      );
    setBatchRows(map);
    setBatchIdemKey(newIdemKey()); // 弹窗一次一把键 —— 失败重试沿用，不重复建单
    setBatchOpen(true);
  };

  const setBatchRow = (itemId: string, patch: Partial<BatchRowState>) => {
    setBatchRows((prev) => {
      const next = new Map(prev);
      const cur = next.get(itemId);
      if (cur) next.set(itemId, { ...cur, ...patch });
      return next;
    });
  };

  const submitBatch = async () => {
    if (!drawerPlanId) return;
    const items: Record<string, unknown>[] = [];
    for (const item of detail?.items ?? []) {
      const r = batchRows.get(item.id);
      if (!r) continue;
      if (r.resultType === 'NO_READ') {
        if (r.exceptionCode) {
          items.push({ planItemId: item.id, resultType: 'NO_READ', exceptionCode: r.exceptionCode });
        }
      } else if (r.readingValue.trim()) {
        if (!DECIMAL_RULE.pattern.test(r.readingValue.trim())) {
          message.error(`第 ${item.seqNo} 行读数格式不正确（最多 4 位小数）`);
          return;
        }
        items.push({
          planItemId: item.id,
          resultType: r.resultType,
          readingValue: r.readingValue.trim(),
        });
      }
    }
    if (items.length === 0) {
      message.warning('没有可提交的录入行 —— 请先填写读数或未抄见原因');
      return;
    }
    setBatchSaving(true);
    try {
      const res = await api.post<{ created: number }>(
        '/meter-readings',
        { items },
        { headers: { 'Idempotency-Key': batchIdemKey } },
      );
      message.success(`已批量录入 ${res.data.created} 条抄表记录`);
      setBatchOpen(false);
      await loadDetail(drawerPlanId);
      await load(page, pageSize);
    } catch (err) {
      // 批量为单事务 —— 任一行失败整批回滚，文案直接透出。
      message.error(apiErrorText(err));
      await loadDetail(drawerPlanId);
    } finally {
      setBatchSaving(false);
    }
  };

  // ---- columns ----

  const columns: ColumnsType<ReadingPlan> = [
    {
      title: '账期',
      dataIndex: 'period',
      key: 'period',
      width: 100,
      render: fmtPeriod,
    },
    {
      title: '抄表册',
      dataIndex: 'bookId',
      key: 'bookId',
      render: bookLabel,
    },
    {
      title: '计划抄表日',
      dataIndex: 'planDate',
      key: 'planDate',
      width: 110,
      render: (v: string) => fmtDate(v),
    },
    {
      title: '抄表员',
      dataIndex: 'readerId',
      key: 'readerId',
      width: 150,
      render: staffName,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: PlanStatus) => (
        <Tag color={PLAN_STATUS_COLORS[s]}>{PLAN_STATUS_LABELS[s]}</Tag>
      ),
    },
    {
      title: '进度',
      key: 'progress',
      width: 190,
      render: (_: unknown, r: ReadingPlan) => {
        const p = progressMap.get(r.id);
        if (!p) return '—';
        const done = p.READ + p.NO_READ + p.SKIPPED;
        return (
          <Tooltip
            title={`已抄 ${p.READ} · 未抄见 ${p.NO_READ} · 待抄 ${p.PENDING} · 跳过 ${p.SKIPPED} / 共 ${p.total}`}
          >
            <Progress
              percent={p.total ? Math.round((done / p.total) * 100) : 0}
              size="small"
              format={() => `${done}/${p.total}`}
            />
          </Tooltip>
        );
      },
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
      width: 210,
      render: (_: unknown, record: ReadingPlan) => (
        <Space size={4} wrap>
          <Button
            size="small"
            icon={<UnorderedListOutlined />}
            onClick={() => openDrawer(record)}
          >
            明细
          </Button>
          {canWrite && record.status === 'OPEN' && (
            <Button
              size="small"
              type="primary"
              ghost
              icon={<CaretRightOutlined />}
              loading={acting === record.id}
              onClick={() => void planAction(record, 'start')}
            >
              开始
            </Button>
          )}
          {canWrite && WRITABLE_PLAN.includes(record.status) && (
            <Popconfirm
              title="取消该抄表计划？"
              description="计划将关闭；已抄明细保留为历史记录。"
              okText="取消计划"
              okButtonProps={{ danger: true }}
              cancelText="返回"
              onConfirm={() => void planAction(record, 'cancel')}
            >
              <Button size="small" danger icon={<StopOutlined />} loading={acting === record.id}>
                取消
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const itemColumns: ColumnsType<ReadingPlanItem> = [
    { title: '顺序', dataIndex: 'seqNo', key: 'seqNo', width: 60 },
    {
      title: '水表户',
      key: 'waterAccount',
      ellipsis: true,
      render: (_: unknown, item: ReadingPlanItem) => accountLabel(item),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: PlanItemStatus) => (
        <Tag color={PLAN_ITEM_STATUS_COLORS[s]}>{PLAN_ITEM_STATUS_LABELS[s]}</Tag>
      ),
    },
    {
      title: '完成读数',
      dataIndex: 'completedReadingId',
      key: 'completedReadingId',
      width: 100,
      render: (id: string | null) =>
        id ? (
          <Tooltip title={id}>
            <span style={{ fontFamily: 'monospace' }}>{id.slice(0, 8)}…</span>
          </Tooltip>
        ) : (
          '—'
        ),
    },
    ...(canWrite && detail && WRITABLE_PLAN.includes(detail.status)
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 80,
            render: (_: unknown, item: ReadingPlanItem) =>
              ENTRYABLE.includes(item.status) ? (
                <Button size="small" type="primary" ghost onClick={() => openEntry(item)}>
                  录入
                </Button>
              ) : null,
          } satisfies ColumnsType<ReadingPlanItem>[number],
        ]
      : []),
  ];

  const pendingCount = detailProgress
    ? detailProgress.PENDING + detailProgress.NO_READ
    : 0;

  return (
    <Card
      title="抄表计划"
      extra={
        <Space wrap>
          <span style={{ width: 220, display: 'inline-block' }}>
            <ReadingBookSelect
              value={bookId}
              onChange={(v) => {
                setBookId(v);
                setPage(1);
              }}
              placeholder="按抄表册过滤"
            />
          </span>
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
            options={(['OPEN', 'IN_PROGRESS', 'DONE', 'CLOSED'] as const).map((s) => ({
              value: s,
              label: PLAN_STATUS_LABELS[s],
            }))}
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
                genForm.resetFields();
                setGenIdemKey(newIdemKey());
                setGenOpen(true);
              }}
            >
              生成计划
            </Button>
          )}
        </Space>
      }
    >
      <Table<ReadingPlan>
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

      {/* 生成计划 */}
      <Modal
        open={genOpen}
        title="生成抄表计划"
        okText="生成"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitGenerate()}
        onCancel={() => setGenOpen(false)}
        destroyOnHidden
      >
        <Form form={genForm} layout="vertical">
          <Form.Item
            name="bookId"
            label="抄表册"
            rules={[{ required: true, message: '请选择抄表册' }]}
          >
            <ReadingBookSelect />
          </Form.Item>
          <Form.Item
            name="period"
            label="账期"
            rules={[{ required: true, message: '请选择账期' }]}
          >
            <DatePicker picker="month" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="planDate" label="计划抄表日期" extra="留空取生成当日">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          {canIamRead && (
            <Form.Item name="readerId" label="抄表员" extra="留空取抄表册默认抄表员">
              <StaffSelect placeholder="选择抄表员（可空）" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 计划明细抽屉 */}
      <Drawer
        open={drawerPlanId !== null}
        width={760}
        title={
          detail
            ? `计划明细 — ${bookLabel(detail.bookId)} · ${fmtPeriod(detail.period)}`
            : '计划明细'
        }
        onClose={() => setDrawerPlanId(null)}
      >
        {detailLoading || !detail ? (
          <Spin />
        ) : (
          <>
            <Space wrap style={{ marginBottom: 12 }}>
              <Tag color={PLAN_STATUS_COLORS[detail.status]}>
                {PLAN_STATUS_LABELS[detail.status]}
              </Tag>
              {detailProgress && (
                <>
                  <Tag color="blue">待抄 {detailProgress.PENDING}</Tag>
                  <Tag color="green">已抄 {detailProgress.READ}</Tag>
                  <Tag color="orange">未抄见 {detailProgress.NO_READ}</Tag>
                  <Tag>跳过 {detailProgress.SKIPPED}</Tag>
                  <Tag>共 {detailProgress.total}</Tag>
                </>
              )}
              <span style={{ color: '#888' }}>
                计划日 {fmtDate(detail.planDate)} · 抄表员 {staffName(detail.readerId)}
              </span>
            </Space>
            <Space wrap style={{ marginBottom: 12 }}>
              <Select
                allowClear
                placeholder="按明细状态过滤"
                style={{ width: 160 }}
                options={ITEM_STATUS_OPTIONS}
                value={itemStatus}
                onChange={setItemStatus}
              />
              {canWrite &&
                WRITABLE_PLAN.includes(detail.status) &&
                pendingCount > 0 && (
                  <Button icon={<PlusOutlined />} onClick={openBatch}>
                    批量录入（剩余 {pendingCount}）
                  </Button>
                )}
              <Button
                icon={<ReloadOutlined />}
                onClick={() => void loadDetail(detail.id)}
              >
                刷新
              </Button>
            </Space>
            <Table<ReadingPlanItem>
              rowKey="id"
              size="small"
              columns={itemColumns}
              dataSource={filteredItems}
              pagination={{ pageSize: 50, hideOnSinglePage: true }}
              locale={{ emptyText: '无明细' }}
            />
          </>
        )}
      </Drawer>

      {/* 单条抄表录入 */}
      <Modal
        open={entryItem !== null}
        title={entryItem ? `抄表录入 — ${accountLabel(entryItem)}` : ''}
        okText="提交"
        cancelText="取消"
        confirmLoading={entrySaving}
        onOk={() => void submitEntry()}
        onCancel={() => setEntryItem(null)}
        destroyOnHidden
      >
        <Form form={entryForm} layout="vertical">
          <Form.Item name="resultType" label="抄表结果" rules={[{ required: true }]}>
            <Radio.Group
              options={READ_RESULT_TYPES.map((t) => ({
                value: t,
                label: RESULT_TYPE_LABELS[t],
              }))}
              optionType="button"
            />
          </Form.Item>
          {entryResultType !== 'NO_READ' ? (
            <Form.Item
              name="readingValue"
              label="表码读数"
              rules={[{ required: true, message: '请输入表码读数' }, DECIMAL_RULE]}
            >
              <Input placeholder="如 123.5" />
            </Form.Item>
          ) : (
            <Form.Item
              name="exceptionCode"
              label="未抄见原因"
              rules={[{ required: true, message: '请选择未抄见原因' }]}
            >
              <Select
                options={EXCEPTION_CODES.map((c) => ({
                  value: c,
                  label: EXCEPTION_CODE_LABELS[c],
                }))}
                placeholder="选择原因"
              />
            </Form.Item>
          )}
          <Form.Item name="readDate" label="抄表日期" extra="留空取当前时间">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      {/* 批量抄表录入 */}
      <Modal
        open={batchOpen}
        title="批量抄表录入（单事务，任一行失败整批回滚）"
        okText={`提交（${[...batchRows.values()].filter((r) => (r.resultType === 'NO_READ' ? !!r.exceptionCode : !!r.readingValue.trim())).length} 行）`}
        cancelText="取消"
        width={860}
        confirmLoading={batchSaving}
        onOk={() => void submitBatch()}
        onCancel={() => setBatchOpen(false)}
        destroyOnHidden
      >
        <Table<ReadingPlanItem>
          rowKey="id"
          size="small"
          dataSource={(detail?.items ?? []).filter((i) => batchRows.has(i.id))}
          pagination={{ pageSize: 50, hideOnSinglePage: true }}
          columns={[
            { title: '顺序', dataIndex: 'seqNo', width: 60 },
            {
              title: '水表户',
              key: 'wa',
              ellipsis: true,
              render: (_: unknown, item: ReadingPlanItem) => accountLabel(item),
            },
            {
              title: '结果',
              key: 'resultType',
              width: 110,
              render: (_: unknown, item: ReadingPlanItem) => (
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  value={batchRows.get(item.id)?.resultType}
                  options={READ_RESULT_TYPES.map((t) => ({
                    value: t,
                    label: RESULT_TYPE_LABELS[t],
                  }))}
                  onChange={(v: ReadResultType) => setBatchRow(item.id, { resultType: v })}
                />
              ),
            },
            {
              title: '读数 / 未抄见原因',
              key: 'value',
              width: 200,
              render: (_: unknown, item: ReadingPlanItem) => {
                const r = batchRows.get(item.id);
                if (!r) return null;
                return r.resultType === 'NO_READ' ? (
                  <Select
                    size="small"
                    style={{ width: '100%' }}
                    allowClear
                    placeholder="未抄见原因"
                    value={r.exceptionCode}
                    options={EXCEPTION_CODES.map((c) => ({
                      value: c,
                      label: EXCEPTION_CODE_LABELS[c],
                    }))}
                    onChange={(v) => setBatchRow(item.id, { exceptionCode: v })}
                  />
                ) : (
                  <Input
                    size="small"
                    placeholder="表码读数（留空跳过该行）"
                    value={r.readingValue}
                    onChange={(e) => setBatchRow(item.id, { readingValue: e.target.value })}
                  />
                );
              },
            },
          ]}
        />
      </Modal>
    </Card>
  );
}
