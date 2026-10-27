import { ReloadOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Card, Space, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { fmtTime } from '../common';
import { WaterAccountSearchSelect } from '../pickers';
import Table from '../../components/PageTable';


interface ReplaceRecord {
  newInstallationId: string;
  removedInstallationId: string | null;
  waterAccountId: string;
  waterAccountLabel?: string | null;
  reason: string;
  replacedAt: string;
  oldMeter: {
    meterId: string;
    meterNo?: string;
    serialNo?: string | null;
    finalReading: string | null;
    installedAt: string;
    initialReading: string;
  } | null;
  newMeter: {
    meterId: string;
    meterNo?: string;
    serialNo?: string | null;
    initialReading: string;
    status: string;
  };
}

/** T12 换表记录 — 老表止码 / 新表始码 分段水量口径明细。 */
export default function ReplaceRecords() {
  const { message } = AntdApp.useApp();
  const [items, setItems] = useState<ReplaceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [waterAccountId, setWaterAccountId] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (p = page) => {
      setLoading(true);
      try {
        const res = await api.get<{ total: number; items: ReplaceRecord[] }>(
          '/service-orders/replace-records',
          {
            params: {
              take: 20,
              skip: (p - 1) * 20,
              ...(waterAccountId ? { waterAccountId } : {}),
            },
          },
        );
        setItems(res.data.items);
        setTotal(res.data.total);
      } catch (e) {
        message.error(apiErrorText(e));
      } finally {
        setLoading(false);
      }
    },
    [page, waterAccountId, message],
  );

  useEffect(() => {
    void load(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, waterAccountId]);

  const columns: ColumnsType<ReplaceRecord> = [
    {
      title: '换表时间',
      dataIndex: 'replacedAt',
      width: 165,
      render: fmtTime,
    },
    {
      title: '原因',
      dataIndex: 'reason',
      width: 90,
      render: (v: string) => <Tag>{v === 'FAULT' ? '故障' : v === 'REPLACE' ? '周期换装' : v}</Tag>,
    },
    {
      title: '用水户',
      dataIndex: 'waterAccountLabel',
      width: 180,
      render: (v) => v ?? '—',
    },
    {
      title: '老表段',
      key: 'old',
      render: (_, r) =>
        r.oldMeter
          ? `表 ${r.oldMeter.meterNo ?? '—'} · 始码 ${r.oldMeter.initialReading} → 止码 ${r.oldMeter.finalReading ?? '—'}`
          : '—',
    },
    {
      title: '新表段',
      key: 'new',
      render: (_, r) =>
        `表 ${r.newMeter.meterNo ?? '—'} · 始码 ${r.newMeter.initialReading}`,
    },
  ];

  return (
    <Card
      title="换表记录"
      extra={
        <Space>
          <span style={{ display: 'inline-block', width: 240 }}>
            <WaterAccountSearchSelect
              placeholder="按用水户过滤"
              onSelect={(a) => {
                setWaterAccountId(a?.id);
                setPage(1);
              }}
            />
          </span>
          <Button icon={<ReloadOutlined />} onClick={() => void load(page)} />
        </Space>
      }
    >
      <Table<ReplaceRecord> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        rowKey="newInstallationId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={{
          current: page,
          total,
          pageSize: 20,
          onChange: setPage,
          showTotal: (t) => `共 ${t} 条`,
        }}
      />
    </Card>
  );
}
