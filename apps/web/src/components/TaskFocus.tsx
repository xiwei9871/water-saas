import { Alert, Button, Space, Tag, Tabs, Typography } from 'antd';
import { AimOutlined, CloseOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';

/**
 * U1 任务「去处理」精准聚焦 + U2 业务页任务分组——共享件。
 *
 * FocusTaskBar：?focusId= 定位到的"本次拟处理记录"置顶警示条，
 *   不管该记录排在第几页都能看到，附「打开详情」与「退出聚焦」。
 * useFocusParams：读取/清除定位参数（focusId/taskId/wa/period）。
 * useTaskGroup：U2 未完成/已完成分组——按 bizType 拉取任务旗标后
 *   过滤行集；无任务的普通记录归入「未完成」组默认显示。
 */

export function useFocusParams() {
  const [params, setParams] = useSearchParams();
  const focusId = params.get('focusId');
  const clear = useCallback(() => {
    const next = new URLSearchParams(params);
    for (const k of ['focusId', 'taskId', 'wa', 'period']) next.delete(k);
    setParams(next, { replace: true });
  }, [params, setParams]);
  return { focusId, taskId: params.get('taskId'), clear };
}

export function FocusTaskBar(props: {
  focusId: string;
  summary: ReactNode;
  extra?: ReactNode;
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
          {props.extra}
        </Space>
      }
      action={
        <Space size={4}>
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

/** U2：未完成/已完成分组。返回 Tab 控件与过滤后的行集。 */
export function useTaskGroup<T>(bizType: string | undefined, rows: T[], getId: (r: T) => string) {
  const [group, setGroup] = useState<GroupKey>('open');
  const { doneSet, reload } = useTaskFlags(bizType);
  const isDone = useCallback((r: T) => doneSet.has(getId(r)), [doneSet, getId]);
  const openRows = useMemo(() => rows.filter((r) => !isDone(r)), [rows, isDone]);
  const doneRows = useMemo(() => rows.filter(isDone), [rows, isDone]);
  const filtered = group === 'open' ? openRows : doneRows;
  const tabs = (
    <Tabs
      size="small"
      activeKey={group}
      onChange={(k) => setGroup(k as GroupKey)}
      items={[
        { key: 'open', label: `未完成（${openRows.length}）` },
        { key: 'done', label: `已完成（${doneRows.length}）` },
      ]}
      style={{ marginBottom: 4 }}
    />
  );
  return { group, setGroup, filtered, tabs, reloadFlags: reload };
}
