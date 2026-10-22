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
    api
      .get<TaskItem>(`/tasks/${taskId}`)
      .then((res) => {
        if (alive) setTask(res.data);
      })
      .catch(() => {
        if (alive) setTask(null);
      });
    return () => {
      alive = false;
    };
  }, [taskId]);

  if (!taskId || !task) return null;
  const summary = taskContextText(task.type, task.context);
  const done = ['DONE', 'CANCELLED'].includes(task.status);

  const dismiss = () => {
    const next = new URLSearchParams(params);
    next.delete('taskId');
    setParams(next, { replace: true });
  };

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
