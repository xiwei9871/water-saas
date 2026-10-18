import { Alert } from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { TASK_STATUS_LABELS, TASK_TYPE_LABELS, type TaskItem } from '../api/types';
import { enumLabel, taskContextText } from '../pages/common';

/**
 * 任务书 T8：待办直达操作页后，页顶展示任务上下文。
 * 用法：目标页读取 ?taskId=，本组件负责拉取并渲染；无 taskId 或拉取失败不渲染。
 */
export function TaskContextBanner() {
  const [task, setTask] = useState<TaskItem | null>(null);
  const taskId = new URLSearchParams(window.location.search).get('taskId');

  useEffect(() => {
    if (!taskId) return;
    let stopped = false;
    api
      .get<TaskItem>(`/tasks/${taskId}`)
      .then((r) => {
        if (!stopped) setTask(r.data);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [taskId]);

  if (!task) return null;
  return (
    <Alert
      type={task.status === 'DONE' || task.status === 'CANCELLED' ? 'info' : 'warning'}
      showIcon
      style={{ marginBottom: 12 }}
      message={
        <>
          来自待办任务【{enumLabel(TASK_TYPE_LABELS, task.type)} ·{' '}
          {enumLabel(TASK_STATUS_LABELS, task.status)}】：{task.title}
        </>
      }
      description={
        <>
          <div>触发原因：{task.reason}</div>
          {task.context && taskContextText(task.type, task.context) && (
            <div style={{ margin: '4px 0 0' }}>
              {taskContextText(task.type, task.context)}
            </div>
          )}
          <div style={{ marginTop: 4 }}>
            <Link to="/tasks">返回待办中心</Link>
          </div>
        </>
      }
    />
  );
}
