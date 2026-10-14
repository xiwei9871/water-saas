import {
  CheckOutlined,
  EyeOutlined,
  LinkOutlined,
  ReloadOutlined,
  StopOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Drawer,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiErrorText } from '../../api/client';
import {
  TASK_BIZ_ROUTES,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TASK_TYPE_LABELS,
  type TaskItem,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { enumLabel, fmtTime } from '../common';

const PRIORITY_COLOR: Record<string, string> = {
  LOW: 'default',
  NORMAL: 'blue',
  HIGH: 'orange',
  URGENT: 'red',
};

type Box = 'todo' | 'done' | 'alert';

/** 任务中心（任务书 §1.7）：待办/已办/告警三箱，领取式处理 + bizType 直达。 */
export default function Tasks() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const navigate = useNavigate();
  const [box, setBox] = useState<Box>('todo');
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<TaskItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [detail, setDetail] = useState<TaskItem | null>(null);

  const canAlert = hasPerm('iam:write');

  const load = useCallback(
    async (b: Box, p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<{ items: TaskItem[]; total: number }>('/tasks', {
          params: { box: b, take: size, skip: (p - 1) * size, ...(typeFilter ? { type: typeFilter } : {}) },
        });
        setRows(res.data.items);
        setTotal(res.data.total);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [message, typeFilter],
  );

  useEffect(() => {
    void load(box, page, pageSize);
  }, [load, box, page, pageSize]);

  const openDetail = async (id: string) => {
    try {
      const res = await api.get<TaskItem>(`/tasks/${id}`);
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const claim = async (id: string) => {
    try {
      await api.post(`/tasks/${id}/claim`);
      message.success('已领取，开始处理');
      setDetail(null);
      void load(box, page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
      void load(box, page, pageSize);
    }
  };

  const complete = async (id: string) => {
    try {
      await api.post(`/tasks/${id}/complete`, {});
      message.success('已完成');
      setDetail(null);
      void load(box, page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const cancel = async (id: string) => {
    try {
      await api.post(`/tasks/${id}/cancel`, { reason: '管理员取消' });
      message.success('已取消');
      setDetail(null);
      void load(box, page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const gotoBiz = (t: TaskItem) => {
    const tpl = TASK_BIZ_ROUTES[t.type];
    if (!tpl) {
      message.warning('该任务类型暂无直达页面');
      return;
    }
    navigate(tpl.replace('{bizId}', t.bizId));
  };

  const columns: ColumnsType<TaskItem> = [
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 130,
      render: (v: string, r) => (
        <Tag color={r.escalatedAt ? 'red' : 'default'}>{enumLabel(TASK_TYPE_LABELS, v)}</Tag>
      ),
    },
    { title: '标题', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: '业务对象',
      dataIndex: 'bizLabel',
      key: 'bizLabel',
      width: 180,
      render: (v: string | null) => v ?? '—',
    },
    { title: '触发原因', dataIndex: 'reason', key: 'reason', ellipsis: true },
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 90,
      render: (v: TaskItem['priority']) => (
        <Tag color={PRIORITY_COLOR[v]}>{enumLabel(TASK_PRIORITY_LABELS, v)}</Tag>
      ),
    },
    {
      title: '期限',
      dataIndex: 'dueAt',
      key: 'dueAt',
      width: 130,
      render: (v: string | null, r) =>
        v ? (
          <span style={{ color: dayjs(v).isBefore(dayjs()) && r.status !== 'DONE' ? '#cf1322' : undefined }}>
            {dayjs(v).format('MM-DD HH:mm')}
          </span>
        ) : (
          '—'
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (v: TaskItem['status'], r) => (
        <Badge
          status={v === 'DONE' ? 'success' : v === 'CLAIMED' ? 'processing' : 'default'}
          text={
            <>
              {enumLabel(TASK_STATUS_LABELS, v)}
              {v === 'CLAIMED' && r.assigneeName ? `（${r.assigneeName}）` : ''}
            </>
          }
        />
      ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 200,
      render: (_, r) => (
        <Space size="small">
          <Button size="small" icon={<EyeOutlined />} onClick={() => void openDetail(r.id)}>
            详情
          </Button>
          {box === 'todo' && r.status === 'PENDING' && (
            <Button size="small" type="primary" icon={<UserAddOutlined />} onClick={() => void claim(r.id)}>
              领取
            </Button>
          )}
          {box === 'todo' && r.status === 'CLAIMED' && (
            <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => void complete(r.id)}>
              完成
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="待办中心"
      extra={
        <Space>
          <Tabs
            size="small"
            activeKey={box}
            onChange={(k) => {
              setBox(k as Box);
              setPage(1);
            }}
            items={[
              { key: 'todo', label: '我的待办' },
              { key: 'done', label: '已办' },
              ...(canAlert ? [{ key: 'alert', label: '待指派告警' }] : []),
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(box, page, pageSize)}>
            刷新
          </Button>
        </Space>
      }
    >
      {box === 'alert' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="以下任务无任何具备所需权限的账号可承接，请调整权限或为账号授权。"
        />
      )}
      <Space style={{ marginBottom: 12 }} wrap>
        <span>类型：</span>
        <Button
          size="small"
          type={typeFilter === undefined ? 'primary' : 'default'}
          onClick={() => setTypeFilter(undefined)}
        >
          全部
        </Button>
        {Object.entries(TASK_TYPE_LABELS).map(([k, v]) => (
          <Button
            key={k}
            size="small"
            type={typeFilter === k ? 'primary' : 'default'}
            onClick={() => setTypeFilter(k)}
          >
            {v}
          </Button>
        ))}
      </Space>
      <Table<TaskItem>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          onChange: (p, s) => {
            setPage(p);
            setPageSize(s);
          },
        }}
      />
      <Drawer
        title={detail ? `任务详情 · ${enumLabel(TASK_TYPE_LABELS, detail.type)}` : '任务详情'}
        open={detail !== null}
        width={520}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            {detail.escalatedAt && (
              <Alert type="error" showIcon message="已超期升级" description={`于 ${fmtTime(detail.escalatedAt)} 标记为紧急并抄送上级。`} />
            )}
            {detail.candidateCount === 0 && detail.status === 'PENDING' && (
              <Alert
                type="warning"
                showIcon
                message="暂无具备权限的账号"
                description={`该任务需要权限 ${detail.requiredPerm}，当前无任何账号持有。请系统管理员调整权限。`}
              />
            )}
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="标题">{detail.title}</Descriptions.Item>
              <Descriptions.Item label="业务对象">{detail.bizLabel ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="触发原因">{detail.reason}</Descriptions.Item>
              <Descriptions.Item label="状态">
                {enumLabel(TASK_STATUS_LABELS, detail.status)}
                {detail.assigneeName ? `（${detail.assigneeName}）` : ''}
              </Descriptions.Item>
              <Descriptions.Item label="候选责任人">
                {detail.candidates?.length
                  ? detail.candidates.map((c) => c.name).join('、')
                  : '—'}
              </Descriptions.Item>
              {detail.context && (
                <Descriptions.Item label="业务上下文">
                  <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                    {JSON.stringify(detail.context, null, 2)}
                  </pre>
                </Descriptions.Item>
              )}
              <Descriptions.Item label="创建时间">{fmtTime(detail.createdAt)}</Descriptions.Item>
              {detail.dueAt && (
                <Descriptions.Item label="期限">{fmtTime(detail.dueAt)}</Descriptions.Item>
              )}
            </Descriptions>
            <Space wrap>
              <Button icon={<LinkOutlined />} onClick={() => gotoBiz(detail)}>
                前往业务页处理
              </Button>
              {detail.canClaim && (
                <Button type="primary" icon={<UserAddOutlined />} onClick={() => void claim(detail.id)}>
                  领取任务
                </Button>
              )}
              {detail.status === 'CLAIMED' && (
                <Button type="primary" icon={<CheckOutlined />} onClick={() => void complete(detail.id)}>
                  标记完成
                </Button>
              )}
              {canAlert && (detail.status === 'PENDING' || detail.status === 'CLAIMED') && (
                <Button danger icon={<StopOutlined />} onClick={() => void cancel(detail.id)}>
                  取消任务
                </Button>
              )}
            </Space>
          </Space>
        )}
      </Drawer>
    </Card>
  );
}
