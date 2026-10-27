import {
  CheckOutlined,
  EyeOutlined,
  ReloadOutlined,
  StopOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import { App as AntdApp, Alert, Button, Card, Collapse, Descriptions, Drawer, Input, Modal, Select, Space, Statistic, Tabs, Tag, Timeline, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiErrorText } from '../../api/client';
import type {
  ExceptionDetail,
  ExceptionItem,
  ExceptionList,
  ExceptionSummary,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { enumLabel, fmtTime } from '../common';
import { WaterAccount360 } from '../customer/WaterAccount360';
import Table from '../../components/PageTable';


const TYPE_LABELS: Record<string, string> = {
  NO_ACTIVE_METER: '无在装表',
  MULTI_ACTIVE_METER: '多重在装表',
  NO_BOOK: '未入册',
  MULTI_BOOK: '多重入册',
  READING_QC_REVIEW: '抄表复核',
  READING_QC_REJECTED: '抄表驳回',
  ESTIMATE_STREAK: '连续估抄',
  REMOTE_EVENT_UNBOUND: '远传未绑定',
  REMOTE_EVENT_WAITING_PLAN: '远传待计划',
  REMOTE_EVENT_FAILED: '远传处理失败',
  REMOTE_EVENT_CONFLICT: '远传读数冲突',
  REMOTE_EVENT_KEY_CONFLICT: '事件键冲突',
  UNPAID_BILL_OVERDUE: '账单逾期',
  READING_QC_PENDING: '读数待质检',
  SETTLEMENT_DRIFT: '待补差',
  PLANNED_NO_READING: '计划缺读数',
  PLANNED_NO_SETTLEMENT: '计划缺结算',
  SETTLEMENT_UNFINALIZED: '结算未终审',
  CLOSED_BALANCE_LEFT: '销户余额残留',
};

/** T1 工单去向：按异常类型直达处理页（覆盖 anchorRef 默认跳转）。 */
const TARGET_PAGE: Record<string, string> = {
  READING_QC_PENDING: '/metering/readings',
  READING_QC_REVIEW: '/metering/readings',
  READING_QC_REJECTED: '/metering/readings',
  ESTIMATE_STREAK: '/metering/readings',
  PLANNED_NO_READING: '/metering/readings',
  NO_ACTIVE_METER: '/customer/meters',
  MULTI_ACTIVE_METER: '/customer/meters',
  NO_BOOK: '/metering/books',
  MULTI_BOOK: '/metering/books',
  REMOTE_EVENT_UNBOUND: '/metering/remote-events',
  REMOTE_EVENT_WAITING_PLAN: '/metering/remote-events',
  REMOTE_EVENT_FAILED: '/metering/remote-events',
  REMOTE_EVENT_CONFLICT: '/metering/remote-events',
  REMOTE_EVENT_KEY_CONFLICT: '/metering/remote-events',
  SETTLEMENT_DRIFT: '/settlement/reconciliations',
  PLANNED_NO_SETTLEMENT: '/settlement/list',
  SETTLEMENT_UNFINALIZED: '/settlement/list',
  CLOSED_BALANCE_LEFT: '/customer/settle-accounts',
  UNPAID_BILL_OVERDUE: '/billing/bills',
};

/**
 * A2 异常直达与任务直达共用同一套聚焦参数（focusId / wa / period）：
 * - 有可定位记录的类型 → focusId=记录 id（读数/远传事件/账单）；
 * - 缺失类异常（无表/多表/未入册/多册/估算连期/计划漏抄）→ wa=用水户 id 定位到户；
 * - 带账期的类型附 period。
 */
function targetUrl(f: { type: string; anchorRef: { kind: string; id: string }; waterAccountId: string | null; period: string | null }): string | null {
  const base = TARGET_PAGE[f.type];
  if (!base) return null;
  const q = new URLSearchParams();
  const readingTypes = ['READING_QC_PENDING', 'READING_QC_REVIEW', 'READING_QC_REJECTED'];
  const remoteTypes = [
    'REMOTE_EVENT_UNBOUND',
    'REMOTE_EVENT_WAITING_PLAN',
    'REMOTE_EVENT_FAILED',
    'REMOTE_EVENT_CONFLICT',
    'REMOTE_EVENT_KEY_CONFLICT',
  ];
  if (readingTypes.includes(f.type)) {
    if (f.anchorRef.id) q.set('focusId', f.anchorRef.id);
    if (f.waterAccountId) q.set('wa', f.waterAccountId);
    if (f.period) q.set('period', f.period);
  } else if (remoteTypes.includes(f.type) || f.type === 'UNPAID_BILL_OVERDUE') {
    if (f.anchorRef.id) q.set('focusId', f.anchorRef.id);
    if (f.waterAccountId) q.set('wa', f.waterAccountId);
  } else if (f.type === 'SETTLEMENT_DRIFT' || f.type === 'PLANNED_NO_SETTLEMENT' || f.type === 'SETTLEMENT_UNFINALIZED') {
    if (f.waterAccountId) q.set('focusId', f.waterAccountId);
    if (f.period) q.set('period', f.period);
  } else {
    // 缺失类（NO_ACTIVE_METER / MULTI_ACTIVE_METER / NO_BOOK / MULTI_BOOK /
    // ESTIMATE_STREAK / PLANNED_NO_READING / CLOSED_BALANCE_LEFT）：定位到户。
    if (f.waterAccountId) q.set('wa', f.waterAccountId);
    if (f.period && (f.type === 'ESTIMATE_STREAK' || f.type === 'PLANNED_NO_READING')) {
      q.set('period', f.period);
    }
  }
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/**
 * 3.1 可处置权限映射：异常类型 → 处理该异常所需权限。
 * 默认 Tab 只展示当前账号可处置的异常；「全部异常」Tab 只读可见。
 */
const TYPE_PERM: Record<string, string> = {
  READING_QC_PENDING: 'metering:qc',
  READING_QC_REVIEW: 'metering:qc',
  READING_QC_REJECTED: 'metering:qc',
  ESTIMATE_STREAK: 'metering:qc',
  PLANNED_NO_READING: 'metering:qc',
  NO_ACTIVE_METER: 'metering:service',
  MULTI_ACTIVE_METER: 'metering:service',
  NO_BOOK: 'metering:write',
  MULTI_BOOK: 'metering:write',
  REMOTE_EVENT_UNBOUND: 'metering:remote:manage',
  REMOTE_EVENT_WAITING_PLAN: 'metering:remote:manage',
  REMOTE_EVENT_FAILED: 'metering:remote:manage',
  REMOTE_EVENT_CONFLICT: 'metering:remote:manage',
  REMOTE_EVENT_KEY_CONFLICT: 'metering:remote:manage',
  SETTLEMENT_DRIFT: 'billing:write',
  PLANNED_NO_SETTLEMENT: 'billing:write',
  SETTLEMENT_UNFINALIZED: 'billing:write',
  CLOSED_BALANCE_LEFT: 'customer:write',
  UNPAID_BILL_OVERDUE: 'payment:write',
};

const SEV_COLORS = { BLOCKING: 'red', WARNING: 'orange', INFO: 'blue' } as const;
const SEV_LABELS = { BLOCKING: '阻断', WARNING: '警告', INFO: '提示' } as const;
const STATUS_LABELS: Record<string, string> = {
  OPEN: '待处理',
  ACK: '已确认',
  IGNORED: '已忽略',
  RESOLVED: '已解决',
};
const STATUS_COLORS: Record<string, string> = {
  OPEN: 'red',
  ACK: 'blue',
  IGNORED: 'default',
  RESOLVED: 'green',
};
const ANCHOR_LABELS: Record<string, string> = {
  ACCOUNT: '用水户',
  TENANT: '租户级',
  REMOTE_SOURCE: '远传源',
};

/** drill 目标 —— 进入原域页面（原域权限由目标页/API 再校验）。 */
const DRILL_PATHS: Record<string, string> = {
  'water-account': '/customer/water-accounts',
  reading: '/metering/readings',
  bill: '/billing/bills',
  'remote-event': '/metering/remote-events',
  'remote-source': '/metering/remote-sources',
};

type StaffOption = { id: string; name: string };

/**
 * E9 异常中心 — 跨域异常事实投影 + episode 处理状态。
 * 列表/详情是纯读（服务端 D1）；「刷新队列」显式触发 reconcile。
 */
export default function Exceptions() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canManage = hasPerm('exception:manage');
  const navigate = useNavigate();

  const [summary, setSummary] = useState<ExceptionSummary | null>(null);
  const [items, setItems] = useState<ExceptionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [type, setType] = useState<string | undefined>();
  const [severity, setSeverity] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [period, setPeriod] = useState<string>('');
  const [orgUnitId, setOrgUnitId] = useState<string | undefined>();
  const [bookId, setBookId] = useState<string | undefined>();
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [books, setBooks] = useState<{ id: string; name: string }[]>([]);

  /** 3.1：我可处置 / 全部异常 双视角。 */
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const canAct = (t: string) => {
    const perm = TYPE_PERM[t];
    return !perm || hasPerm(perm);
  };
  const shownItems = scope === 'mine' ? items.filter((i) => canAct(i.type)) : items;

  const [detail, setDetail] = useState<ExceptionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [ignoreOpen, setIgnoreOpen] = useState(false);
  const [ignoreNote, setIgnoreNote] = useState('');
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveNote, setResolveNote] = useState('');
  const [assignOpen, setAssignOpen] = useState(false);
  const [assigneeId, setAssigneeId] = useState<string>();
  const [acting, setActing] = useState(false);
  const [drill360, setDrill360] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<ExceptionList>('/exceptions', {
        params: {
          page,
          take: pageSize,
          ...(type ? { type } : {}),
          ...(severity ? { severity } : {}),
          ...(status ? { status } : {}),
          ...(period.trim() ? { period: period.trim() } : {}),
          ...(orgUnitId ? { orgUnitId } : {}),
          ...(bookId ? { bookId } : {}),
        },
      });
      setItems(res.data.items);
      setTotal(res.data.total);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, type, severity, status, period, orgUnitId, bookId, message]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await api.get<ExceptionSummary>('/exceptions/summary');
      setSummary(res.data);
    } catch {
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);
  useEffect(() => {
    queueMicrotask(() => void loadSummary());
  }, [loadSummary]);

  useEffect(() => {
    // exception:read 也可获取（显示处理人姓名用，非管理操作）。
    api
      .get<{ id: string; name: string }[]>('/exceptions/options/assignees')
      .then((r) => setStaff(r.data.map((s) => ({ id: s.id, name: s.name }))))
      .catch(() => setStaff([]));
  }, []);

  useEffect(() => {
    // exception:read-gated projections — no iam/metering permission needed.
    api
      .get<{ id: string; name: string }[]>('/exceptions/options/orgs')
      .then((r) => setOrgs(r.data.map((o) => ({ id: o.id, name: o.name }))))
      .catch(() => setOrgs([]));
    api
      .get<{ id: string; name: string }[]>('/exceptions/options/books')
      .then((r) => setBooks(r.data.map((b) => ({ id: b.id, name: b.name }))))
      .catch(() => setBooks([]));
  }, []);

  const openDetail = async (key: string) => {
    setDetailLoading(true);
    try {
      const res = await api.get<ExceptionDetail>(`/exceptions/${encodeURIComponent(key)}`);
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await api.post<{ detected: number; created: number; resolved: number; cleared: number }>(
        '/exceptions/refresh',
      );
      message.success(
        `队列已刷新：检出 ${res.data.detected}，新建 ${res.data.created}，自动解决 ${res.data.resolved}`,
      );
      void load();
      void loadSummary();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setRefreshing(false);
    }
  };

  /** 所有 episode 写操作共用一个壳：成功后重开详情 + 重载列表。 */
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    if (!detail) return;
    setActing(true);
    try {
      await fn();
      message.success(ok);
      setIgnoreOpen(false);
      setResolveOpen(false);
      setAssignOpen(false);
      await openDetail(detail.fact.key);
      void load();
      void loadSummary();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setActing(false);
    }
  };

  const ep = detail?.episode ?? null;
  const live = ep && ep.status !== 'RESOLVED';

  const drill = () => {
    if (!detail) return;
    const target = targetUrl(detail.fact);
    if (target) {
      navigate(target);
      return;
    }
    const ref = detail.fact.anchorRef;
    if (ref.kind === 'water-account') {
      setDrill360(ref.id);
      return;
    }
    const path = DRILL_PATHS[ref.kind];
    if (path) navigate(path);
  };

  const columns: ColumnsType<ExceptionItem> = [
    {
      title: '级别',
      dataIndex: 'severity',
      width: 80,
      render: (s: ExceptionItem['severity']) => (
        <Tag color={SEV_COLORS[s]}>{enumLabel(SEV_LABELS, s)}</Tag>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 130,
      render: (t: string) => enumLabel(TYPE_LABELS, t),
    },
    { title: '摘要', dataIndex: 'summary', ellipsis: true },
    {
      title: '锚点',
      dataIndex: 'anchor',
      width: 90,
      render: (a: string) => enumLabel(ANCHOR_LABELS, a),
    },
    { title: '账期', dataIndex: 'period', width: 80, render: (p: string | null) => p ?? '—' },
    {
      title: '状态',
      width: 90,
      render: (_, r) => (
        <Tag color={STATUS_COLORS[r.episode.status]}>{enumLabel(STATUS_LABELS, r.episode.status)}</Tag>
      ),
    },
    {
      title: '操作',
      width: 150,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" icon={<EyeOutlined />} onClick={() => void openDetail(r.key)}>
            详情
          </Button>
          {TARGET_PAGE[r.type] &&
            (canAct(r.type) ? (
              <Button size="small" type="link" onClick={() => navigate(targetUrl(r) ?? TARGET_PAGE[r.type])}>
                去处理
              </Button>
            ) : (
              <Tag style={{ marginInlineEnd: 0 }}>无处置权限</Tag>
            ))}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Space size="large" wrap>
          <Statistic title="待处理" value={summary?.open ?? '—'} valueStyle={{ color: '#cf1322' }} />
          <Statistic title="已确认" value={summary?.acknowledged ?? '—'} />
          <Statistic title="今日新增" value={summary?.todayAdded ?? '—'} />
          <Statistic title="今日清除" value={summary?.todayCleared ?? '—'} />
          <Statistic title="已忽略(活跃)" value={summary?.suppressedIgnored ?? '—'} />
          <Statistic title="活跃异常" value={summary?.activeFacts ?? '—'} />
          {canManage && (
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={refreshing}
              onClick={() => void refresh()}
            >
              刷新队列
            </Button>
          )}
        </Space>
      </Card>

      <Card
        size="small"
        title="异常队列"
        extra={
          <Space wrap>
            <Select
              allowClear
              placeholder="类型"
              style={{ width: 150 }}
              value={type}
              onChange={(v) => {
                setType(v);
                setPage(1);
              }}
              options={Object.entries(TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))}
            />
            <Select
              allowClear
              placeholder="级别"
              style={{ width: 100 }}
              value={severity}
              onChange={(v) => {
                setSeverity(v);
                setPage(1);
              }}
              options={Object.entries(SEV_LABELS).map(([v, l]) => ({ value: v, label: l }))}
            />
            <Select
              allowClear
              placeholder="状态"
              style={{ width: 100 }}
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              options={Object.entries(STATUS_LABELS).map(([v, l]) => ({ value: v, label: l }))}
            />
            <Input
              allowClear
              placeholder="期间 YYYYMM"
              style={{ width: 120 }}
              value={period}
              onChange={(e) => {
                setPeriod(e.target.value);
                setPage(1);
              }}
            />
            {orgs.length > 0 && (
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="营业所"
                style={{ width: 150 }}
                value={orgUnitId}
                onChange={(v) => {
                  setOrgUnitId(v);
                  setPage(1);
                }}
                options={orgs.map((o) => ({ value: o.id, label: o.name }))}
              />
            )}
            {books.length > 0 && (
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="抄表册"
                style={{ width: 150 }}
                value={bookId}
                onChange={(v) => {
                  setBookId(v);
                  setPage(1);
                }}
                options={books.map((b) => ({ value: b.id, label: b.name }))}
              />
            )}
          </Space>
        }
      >
        <Tabs
          activeKey={scope}
          onChange={(k) => setScope(k as 'mine' | 'all')}
          items={[
            {
              key: 'mine',
              label: `我可处置（${items.filter((i) => canAct(i.type)).length}）`,
            },
            { key: 'all', label: `全部异常（${items.length}）` },
          ]}
        />
        <Table<ExceptionItem> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
          rowKey="key"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={shownItems}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
        />
      </Card>

      <Drawer
        title={detail ? `${enumLabel(TYPE_LABELS, detail.fact.type)}` : '异常详情'}
        open={!!detail || detailLoading}
        loading={detailLoading}
        width={560}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {detail.fact.severity === 'BLOCKING' && (
              <Alert type="error" message="阻断级异常 —— 相关业务可能被拦截" showIcon />
            )}
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="摘要">{detail.fact.summary}</Descriptions.Item>
              <Descriptions.Item label="业务标识">
                {enumLabel(TYPE_LABELS, detail.fact.type)} · {detail.fact.summary}
                <Collapse
                  ghost
                  style={{ marginTop: 4 }}
                  items={[
                    {
                      key: 'tech',
                      label: '技术标识',
                      children: (
                        <Typography.Text code copyable style={{ fontSize: 12 }}>
                          {detail.fact.key}
                        </Typography.Text>
                      ),
                    },
                  ]}
                />
              </Descriptions.Item>
              <Descriptions.Item label="锚点">
                {enumLabel(ANCHOR_LABELS, detail.fact.anchor)}
                {detail.fact.anchor === 'TENANT' && (
                  <Typography.Text type="secondary">（无册归属，仅租户级可处理）</Typography.Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="处理状态">
                {ep ? (
                  <Tag color={STATUS_COLORS[ep.status]}>{enumLabel(STATUS_LABELS, ep.status)}</Tag>
                ) : (
                  <Tag>待同步</Tag>
                )}
                {ep?.assigneeId && (
                  <Typography.Text type="secondary">
                    处理人 {staff.find((s) => s.id === ep.assigneeId)?.name ?? '—'}
                  </Typography.Text>
                )}
              </Descriptions.Item>
              {ep?.note && <Descriptions.Item label="备注">{ep.note}</Descriptions.Item>}
            </Descriptions>

            <Space wrap>
              {canManage && live && (
                <>
                  {ep!.status === 'OPEN' && (
                    <Button
                      icon={<CheckOutlined />}
                      loading={acting}
                      onClick={() =>
                        void act(
                          () => api.post(`/exceptions/${encodeURIComponent(detail.fact.key)}/ack`),
                          '已确认',
                        )
                      }
                    >
                      确认
                    </Button>
                  )}
                  <Button
                    icon={<UserAddOutlined />}
                    onClick={() => setAssignOpen(true)}
                  >
                    指派
                  </Button>
                  {ep!.status !== 'IGNORED' ? (
                    <Button icon={<StopOutlined />} onClick={() => setIgnoreOpen(true)}>
                      忽略
                    </Button>
                  ) : (
                    <Button
                      loading={acting}
                      onClick={() =>
                        void act(
                          () => api.post(`/exceptions/${encodeURIComponent(detail.fact.key)}/unignore`),
                          '已取消忽略',
                        )
                      }
                    >
                      取消忽略
                    </Button>
                  )}
                  <Button type="primary" ghost onClick={() => setResolveOpen(true)}>
                    标记已解决
                  </Button>
                </>
              )}
              <Button onClick={drill}>查看业务对象</Button>
            </Space>

            {detail.history.length > 0 && (
              <Card size="small" title="历史 episode">
                <Timeline
                  items={detail.history.map((h) => ({
                    children: (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {fmtTime(h.createdAt)} — {enumLabel(STATUS_LABELS, h.status)}
                        {h.resolutionSource ? `（${h.resolutionSource === 'AUTO' ? '自动' : '人工'}）` : ''}
                        {h.note ? ` ${h.note}` : ''}
                      </Typography.Text>
                    ),
                  }))}
                />
              </Card>
            )}
          </Space>
        )}
      </Drawer>

      <Modal maskClosable={false}
        title="忽略异常"
        open={ignoreOpen}
        confirmLoading={acting}
        onOk={() =>
          void act(
            () =>
              api.post(`/exceptions/${encodeURIComponent(detail!.fact.key)}/ignore`, {
                note: ignoreNote,
              }),
            '已忽略',
          )
        }
        onCancel={() => setIgnoreOpen(false)}
      >
        <Input.TextArea
          rows={3}
          placeholder="忽略原因（必填）"
          value={ignoreNote}
          onChange={(e) => setIgnoreNote(e.target.value)}
        />
      </Modal>

      <Modal maskClosable={false}
        title="标记已解决"
        open={resolveOpen}
        confirmLoading={acting}
        onOk={() =>
          void act(
            () =>
              api.post(`/exceptions/${encodeURIComponent(detail!.fact.key)}/resolve`, {
                note: resolveNote || undefined,
              }),
            '已解决',
          )
        }
        onCancel={() => setResolveOpen(false)}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="服务端会重新校验异常事实；若仍存在将返回 409。"
        />
        <Input.TextArea
          rows={3}
          placeholder="处理说明（可选）"
          value={resolveNote}
          onChange={(e) => setResolveNote(e.target.value)}
        />
      </Modal>

      <Modal maskClosable={false}
        title="指派处理人"
        open={assignOpen}
        confirmLoading={acting}
        onOk={() =>
          void act(
            () =>
              api.post(`/exceptions/${encodeURIComponent(detail!.fact.key)}/assign`, {
                assigneeId,
              }),
            '已指派',
          )
        }
        onCancel={() => setAssignOpen(false)}
      >
        <Select
          style={{ width: '100%' }}
          placeholder="选择处理人"
          value={assigneeId}
          onChange={setAssigneeId}
          options={staff.map((s) => ({ value: s.id, label: s.name }))}
          showSearch
          optionFilterProp="label"
        />
      </Modal>

      <WaterAccount360
        accountId={drill360}
        onClose={() => setDrill360(null)}
        onOpenMeterOps={() => setDrill360(null)}
      />
    </Space>
  );
}
