import { Alert, Button, Space, Tag } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { TASK_TYPE_LABELS, type TaskItem } from '../api/types';
import { enumLabel, taskContextText } from '../pages/common';

/**
 * 任务处置信号条（3.2 层面二）：从待办中心「前往业务页处理」跳转后
 * ?taskId= 常驻提示——正在处理哪条任务、对哪个业务对象做什么，
 * 处理完成（或手动关闭/离开页面）前一直存在。
 */
export function TaskBanner() {
  const [params, setParams] = useSearchParams();
  const taskId = params.get('taskId');
  const [task, setTask] = useState<TaskItem | null>(null);

  useEffect(() => {
    if (!taskId) {
      setTask(null);
      return;
    }
    let alive = true;
    const pull = () => {
      api
        .get<TaskItem>(`/tasks/${taskId}`)
        .then((res) => {
          if (alive) setTask(res.data);
        })
        .catch(() => {
          if (alive) setTask(null);
        });
    };
    pull();
    // U1-4：业务办结可能由业务动作自动触发（不经本页）——轮询同步状态。
    const t = window.setInterval(pull, 15000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [taskId]);

  if (!taskId || !task) return null;
  const summary = taskContextText(task.type, task.context);
  const done = ['DONE', 'CANCELLED'].includes(task.status);

  const dismiss = () => {
    const next = new URLSearchParams(params);
    for (const k of ['taskId', 'focusId', 'wa', 'period']) next.delete(k);
    setParams(next, { replace: true });
  };

  // U1-4：任务办结后自动解除聚焦与筛选——先显「已办结」5 秒再恢复常规列表。
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(dismiss, 5000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  return (
    <Alert
      type={done ? 'success' : 'info'}
      showIcon
      style={{ marginBottom: 12 }}
      message={
        <Space size="small" wrap>
          <Tag color={done ? 'green' : 'processing'}>
            {done ? '任务已办结' : '正在处理任务'}
          </Tag>
          <b>{enumLabel(TASK_TYPE_LABELS, task.type)}</b>
          {task.bizLabel && <span>（{task.bizLabel}）</span>}
          {summary && <span style={{ color: '#555' }}>{summary}</span>}
        </Space>
      }
      description={!done && task.guide ? task.guide : undefined}
      action={
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={dismiss}>
          {done ? '关闭' : '收起'}
        </Button>
      }
    />
  );
}
