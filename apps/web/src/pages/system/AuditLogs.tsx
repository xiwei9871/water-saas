import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Input,
  Space,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type { AuditLog, Staff } from '../../api/types';

const fmtTime = (iso: string) => iso.replace('T', ' ').slice(0, 19);

const ACTION_COLORS: Record<string, string> = {
  POST: 'green',
  PUT: 'blue',
  PATCH: 'orange',
  DELETE: 'red',
};

/** 操作日志：append-only audit_log 的只读视图（时间/操作人/动作/对象）。 */
export default function AuditLogs() {
  const { message } = AntdApp.useApp();

  const [rows, setRows] = useState<AuditLog[]>([]);
  const [staffById, setStaffById] = useState<Map<string, Staff>>(new Map());
  const [loading, setLoading] = useState(false);
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<AuditLog[]>('/iam/audit-logs', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(entity.trim() ? { entity: entity.trim() } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [entity, message],
  );

  useEffect(() => {
    // Defer to a microtask — setState must not run synchronously in effects.
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  // staffId → 姓名（越出 orgScope 的员工只显示短 id）。
  useEffect(() => {
    api
      .get<Staff[]>('/iam/staff')
      .then((res) => setStaffById(new Map(res.data.map((s) => [s.id, s]))))
      .catch(() => setStaffById(new Map()));
  }, []);

  const staffName = (id: string | null) => {
    if (!id) return '—';
    const s = staffById.get(id);
    return s ? `${s.name}（${s.login}）` : `${id.slice(0, 8)}…`;
  };

  // The endpoint returns a page, not a total — allow "next page" exactly
  // when the current page came back full.
  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const columns: ColumnsType<AuditLog> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: fmtTime,
    },
    {
      title: '操作人',
      dataIndex: 'staffId',
      key: 'staffId',
      width: 180,
      render: staffName,
    },
    {
      title: '操作',
      dataIndex: 'action',
      key: 'action',
      render: (a: string) => {
        const [method, ...rest] = a.split(' ');
        return (
          <span>
            <Tag color={ACTION_COLORS[method] ?? 'default'}>{method}</Tag>
            {rest.join(' ')}
          </span>
        );
      },
    },
    { title: '对象类型', dataIndex: 'entity', key: 'entity', width: 140 },
    {
      title: '对象 ID',
      dataIndex: 'entityId',
      key: 'entityId',
      render: (id: string | null) =>
        id ? (
          <Tooltip title={id}>
            <span style={{ fontFamily: 'monospace' }}>{id.slice(0, 8)}…</span>
          </Tooltip>
        ) : (
          '—'
        ),
    },
    { title: 'IP', dataIndex: 'ip', key: 'ip', width: 130, render: (v) => v ?? '—' },
  ];

  return (
    <Card
      title="操作日志"
      extra={
        <Space>
          <Input
            allowClear
            placeholder="按对象类型过滤，如 staff"
            prefix={<SearchOutlined />}
            style={{ width: 220 }}
            value={entity}
            onChange={(e) => {
              setEntity(e.target.value);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(page, pageSize)}>
            刷新
          </Button>
        </Space>
      }
    >
      <Table<AuditLog>
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
    </Card>
  );
}
