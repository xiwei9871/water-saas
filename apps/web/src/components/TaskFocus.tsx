import { Alert, Button, Segmented, Space, Tag, Tabs, Typography } from 'antd';
import { AimOutlined, CloseOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { TASK_BIZ_ROUTES } from '../api/types';

/**
 * 任务直达 URL（任务中心/驾驶舱/告警共用同一套聚焦参数）：
 * focusId=业务记录 id + taskId + wa=用水户/结算户 uuid + period=账期。
 */
export function taskBizUrl(t: {
  id: string;
  type: string;
  bizId: string;
  bizType: string;
  context?: unknown;
}): string | null {
  const tpl = TASK_BIZ_ROUTES[t.type];
  if (!tpl) return null;
  const ctx = (t.context ?? {}) as Record<string, unknown>;
  const route = tpl.replace(/\{(\w+)\}/g, (_m, k) => {
    if (k === 'bizId') return t.bizId;
    if (k === 'taskId') return t.id;
    const v = ctx[k];
    return v == null ? '' : String(v);
  });
  const extra = new URLSearchParams();
  const wa =
    ctx.waterAccountId ??
    ctx.settleAccountId ??
    (t.bizType === 'waterAccount' || t.bizType === 'settleAccount' ? t.bizId : null);
  if (wa != null && wa !== '') extra.set('wa', String(wa));
  if (ctx.period != null && ctx.period !== '') extra.set('period', String(ctx.period));
  const sep = route.includes('?') ? '&' : '?';
  return extra.size ? `${route}${sep}${extra.toString()}` : route;
}

/**
 * 任务「去处理」精准聚焦 + 业务页任务分组——共享件。
 *
 * FocusTaskBar：?focusId= 定位到的"本次拟处理记录"置顶警示条，
 *   附「打开详情」「显示全部记录」开关与「退出聚焦」。
 * useFocusParams：读取/清除定位参数（focusId/taskId/wa/period）。
 * useFocusList：「只显示该条」——聚焦时数据源只含目标记录，
 *   切换「显示全部」时回调 onShowAll（页面用来重置页码）。
 * useTaskGroup：未完成/已完成分组（三态：有未完成任务→未完成；
 *   任务全了结或无任务→已完成），已完成组内可再筛「有任务已完成/无任务」。
 */

export function useFocusParams() {
  const [params, setParams] = useSearchParams();
  const focusId = params.get('focusId');
  const clear = useCallback(() => {
    const next = new URLSearchParams(params);
    for (const k of ['focusId', 'taskId', 'wa', 'period']) next.delete(k);
    setParams(next, { replace: true });
  }, [params, setParams]);
  return {
    focusId,
    taskId: params.get('taskId'),
    /** 用水户 id / 账期——缺失类异常（无可定位记录）按户聚焦时用。 */
    wa: params.get('wa'),
    period: params.get('period'),
    clear,
  };
}

export function FocusTaskBar(props: {
  focusId: string;
  summary: ReactNode;
  extra?: ReactNode;
  /** 「只显示该条 / 显示全部记录」开关状态与回调（不传则页面恒为全列表）。 */
  showAll?: boolean;
  onToggleAll?: (showAll: boolean) => void;
  onOpenDetail?: () => void;
  onClose: () => void;
}) {
  return (
    <Alert
      type="warning"
      showIcon
      icon={<AimOutlined />}
      style={{ marginBottom: 12, border: '1px solid #faad14' }}
      message={
        <Space size="small" wrap>
          <Tag color="orange">待处理</Tag>
          <Typography.Text strong>本次拟处理记录已定位</Typography.Text>
          {props.summary}
          {props.showAll === false && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              （只显示该条，已忽略筛选条件）
            </Typography.Text>
          )}
          {props.extra}
        </Space>
      }
      action={
        <Space size={4}>
          {props.onToggleAll && (
            <Button
              size="small"
              icon={<UnorderedListOutlined />}
              onClick={() => props.onToggleAll!(!props.showAll)}
            >
              {props.showAll ? '只看该条' : '显示全部记录'}
            </Button>
          )}
          {props.onOpenDetail && (
            <Button size="small" type="primary" ghost onClick={props.onOpenDetail}>
              打开详情
            </Button>
          )}
          <Button size="small" type="text" icon={<CloseOutlined />} onClick={props.onClose}>
            退出聚焦
          </Button>
        </Space>
      }
    />
  );
}

/** 高亮样式：聚焦行 + scrollIntoView 由页面 rowClassName/回调使用。 */
export const FOCUS_ROW_CLASS = 'task-focus-row';

/**
 * 「只显示该条」行集控制：
 * - match 命中行时（聚焦中且未展开全部）→ 只返回命中行；
 * - 命中行不在当前页数据内但 extraRecord 已取到 → 显示该记录；
 * - showAll=true 或未聚焦 → 原行集。
 */
export function useFocusList<T>(
  /** 定位标识（focusId / wa / 组合键）——变化时回到「只显示该条」。 */
  focusKey: string | null,
  rows: T[],
  match: ((r: T) => boolean) | null,
  opts?: { extraRecord?: T | null; onShowAll?: () => void },
) {
  const [showAll, setShowAll] = useState(false);
  const matched = useMemo(() => (match ? rows.filter(match) : rows), [rows, match]);
  const focused = useMemo(() => (match && matched.length === 0 ? (opts?.extraRecord ?? null) : null), [match, matched, opts]);
  const shown = useMemo(() => {
    if (!match || showAll) return rows;
    if (matched.length) return matched;
    return focused ? [focused] : [];
  }, [match, showAll, rows, matched, focused]);
  const toggleAll = useCallback(
    (v: boolean) => {
      setShowAll(v);
      if (v) opts?.onShowAll?.();
    },
    [opts],
  );
  // 换一个聚焦目标时回到「只显示该条」。
  useEffect(() => setShowAll(false), [focusKey]);
  return { shown, showAll, toggleAll, focusing: !!match && !showAll };
}

interface BizFlags {
  openIds: string[];
  doneIds: string[];
}

export function useTaskFlags(bizType: string | undefined) {
  const [flags, setFlags] = useState<BizFlags>({ openIds: [], doneIds: [] });
  const load = useCallback(() => {
    if (!bizType) {
      setFlags({ openIds: [], doneIds: [] });
      return;
    }
    api
      .get<BizFlags>('/tasks/biz-flags', { params: { bizType } })
      .then((r) => setFlags(r.data))
      .catch(() => setFlags({ openIds: [], doneIds: [] }));
  }, [bizType]);
  useEffect(() => load(), [load]);
  const openSet = useMemo(() => new Set(flags.openIds), [flags]);
  const doneSet = useMemo(() => new Set(flags.doneIds), [flags]);
  return { openSet, doneSet, reload: load };
}

type GroupKey = 'open' | 'done';
type DoneSub = 'all' | 'tasked' | 'none';

/**
 * 任务三态分组（A3）：
 * - 未完成：记录 id ∈ openSet（仍有 PENDING/CLAIMED/ASSIGNED 任务）；
 * - 已完成：其余全部（有任务全了结 → 子标识「有任务已完成」；无任务 → 「无任务」）；
 * - CANCELLED 不阻塞（后端 openIds 已不含）。
 * 分组粒度 = 页面行 id（getId 必须返回该条记录的 id）。
 */
export function useTaskGroup<T>(bizType: string | undefined, rows: T[], getId: (r: T) => string) {
  const [group, setGroup] = useState<GroupKey>('open');
  const [doneSub, setDoneSub] = useState<DoneSub>('all');
  const { openSet, doneSet, reload } = useTaskFlags(bizType);
  const isOpen = useCallback((r: T) => openSet.has(getId(r)), [openSet, getId]);
  const isTaskedDone = useCallback((r: T) => doneSet.has(getId(r)), [doneSet, getId]);
  const openRows = useMemo(() => rows.filter(isOpen), [rows, isOpen]);
  const doneRows = useMemo(() => rows.filter((r) => !isOpen(r)), [rows, isOpen]);
  const filtered = useMemo(() => {
    if (group === 'open') return openRows;
    if (doneSub === 'tasked') return doneRows.filter(isTaskedDone);
    if (doneSub === 'none') return doneRows.filter((r) => !isTaskedDone(r));
    return doneRows;
  }, [group, doneSub, openRows, doneRows, isTaskedDone]);
  const tabs = (
    <Space size="middle" wrap style={{ marginBottom: 4, width: '100%' }}>
      <Tabs
        size="small"
        activeKey={group}
        onChange={(k) => setGroup(k as GroupKey)}
        items={[
          { key: 'open', label: `未完成（${openRows.length}）` },
          { key: 'done', label: `已完成（${doneRows.length}）` },
        ]}
        style={{ marginBottom: 0 }}
      />
      {group === 'done' && (
        <Segmented
          size="small"
          value={doneSub}
          onChange={(v) => setDoneSub(v as DoneSub)}
          options={[
            { label: '全部', value: 'all' },
            { label: `有任务已完成（${doneRows.filter(isTaskedDone).length}）`, value: 'tasked' },
            { label: `无任务（${doneRows.filter((r) => !isTaskedDone(r)).length}）`, value: 'none' },
          ]}
        />
      )}
    </Space>
  );
  return { group, setGroup, filtered, tabs, reloadFlags: reload };
}
