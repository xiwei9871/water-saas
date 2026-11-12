import { useEffect, useState } from 'react';
import { Card, Table, Tag } from 'antd';
import { api } from '../../api/client';

interface Call { id: string; direction: string; bizType: string; bizId: string | null; endpoint: string | null; result: string | null; createdAt: string }
const D: Record<string, string> = { INBOUND: '入站回推', OUTBOUND: '出站推送', OUTBOUND_PENDING: '出站待发' };

/** X5-旧：外部接口调用留痕监控（读 external_call 表）。 */
export default function ExternalCalls() {
  const [rows, setRows] = useState<Call[]>([]);
  useEffect(() => { api.get<Call[]>('/install/applications/external-calls/list').then((r) => setRows(r.data ?? [])); }, []);
  const ok = rows.filter((r) => r.result && !/FAIL|ERROR/.test(r.result)).length;
  return (
    <Card title="外部接口调用留痕" extra={<Tag color="blue">共 {rows.length} 条 · 正常 {ok}</Tag>}>
      <Table<Call> rowKey="id" size="small" dataSource={rows} pagination={{ pageSize: 20 }}
        columns={[
          { title: '方向', dataIndex: 'direction', width: 100, render: (v: string) => <Tag color={v === 'INBOUND' ? 'green' : 'orange'}>{D[v] ?? v}</Tag> },
          { title: '业务', dataIndex: 'bizType', width: 130 },
          { title: '端点', dataIndex: 'endpoint', ellipsis: true, render: (v: string | null) => v ?? '—' },
          { title: '结果', dataIndex: 'result', width: 160, render: (v: string | null) => v ?? '—' },
          { title: '时间', dataIndex: 'createdAt', width: 170, render: (v: string) => v?.replace('T', ' ').slice(0, 19) },
        ]} />
    </Card>
  );
}
