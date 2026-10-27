import { ReloadOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Card, DatePicker, Space, Statistic, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { enumLabel, SERVICE_TYPE_LABELS } from '../common';

interface TypeStat {
  serviceType: string;
  total: number;
  done: number;
  open: number;
  avgHours: number | null;
  onTimeRate: number | null;
}

interface StatsResp {
  slaHours: number;
  byTypeStatus: { service_type: string; status: string; n: string | number }[];
  durations: {
    service_type: string;
    avg_hours: number | null;
    on_time: string | number;
    done: string | number;
  }[];
  /** 20261021 整改 任务G：文档口径 6 表务指标 */
  metrics?: {
    replaceRate: number | null;
    faultReplaceRate: number | null;
    checkDoneRate: number | null;
    checkPassRate: number | null;
    resumeOnTimeRate: number | null;
    svcOnTimeRate: number | null;
  };
}

const KPI_DEFS: { key: keyof NonNullable<StatsResp['metrics']>; name: string }[] = [
  { key: 'replaceRate', name: '换表率' },
  { key: 'faultReplaceRate', name: '故障换表率' },
  { key: 'checkDoneRate', name: '周期检定完成率' },
  { key: 'checkPassRate', name: '检定合格率' },
  { key: 'resumeOnTimeRate', name: '复水及时率' },
  { key: 'svcOnTimeRate', name: '表务处置及时率' },
];

const OPEN_STATUSES = new Set(['PENDING_APPROVAL', 'APPROVED', 'DISPATCHED']);

/** T11 表务处置统计 — 类型×状态分布 + 平均处置时长 + SLA 按期率。 */
export default function ServiceOrderStats() {
  const { message } = AntdApp.useApp();
  const [range, setRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [rows, setRows] = useState<TypeStat[]>([]);
  const [metrics, setMetrics] = useState<StatsResp['metrics']>();
  const [slaHours, setSlaHours] = useState(72);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<StatsResp>('/service-orders/stats', {
        params: {
          ...(range?.[0] ? { from: range[0].format('YYYY-MM-DD') } : {}),
          ...(range?.[1] ? { to: range[1].format('YYYY-MM-DD') } : {}),
        },
      });
      setSlaHours(res.data.slaHours);
      const byType = new Map<string, TypeStat>();
      for (const r of res.data.byTypeStatus) {
        const t =
          byType.get(r.service_type) ??
          ({ serviceType: r.service_type, total: 0, done: 0, open: 0 } as TypeStat);
        const n = Number(r.n);
        t.total += n;
        if (OPEN_STATUSES.has(r.status)) t.open += n;
        if (r.status === 'EXECUTED' || r.status === 'ARCHIVED') t.done += n;
        byType.set(r.service_type, t);
      }
      for (const d of res.data.durations) {
        const t = byType.get(d.service_type);
        if (!t) continue;
        t.avgHours = d.avg_hours === null ? null : Number(d.avg_hours);
        const done = Number(d.done);
        t.onTimeRate = done > 0 ? Number(d.on_time) / done : null;
      }
      setRows([...byType.values()]);
      setMetrics(res.data.metrics);
    } catch (e) {
      message.error(apiErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [range, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<TypeStat> = [
    {
      title: '服务类型',
      dataIndex: 'serviceType',
      render: (v: string) => enumLabel(SERVICE_TYPE_LABELS, v),
    },
    { title: '工单总数', dataIndex: 'total', width: 110 },
    { title: '已处置', dataIndex: 'done', width: 100 },
    { title: '在办', dataIndex: 'open', width: 90 },
    {
      title: '平均处置时长(h)',
      dataIndex: 'avgHours',
      width: 140,
      render: (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1)),
    },
    {
      title: `按期完成率(≤${slaHours}h)`,
      dataIndex: 'onTimeRate',
      width: 160,
      render: (v: number | null | undefined) =>
        v == null ? '—' : `${(v * 100).toFixed(1)}%`,
    },
  ];

  return (
    <Card
      title="表务处置统计"
      extra={
        <Space>
          <DatePicker.RangePicker value={range as never} onChange={(v) => setRange(v)} />
          <Button icon={<ReloadOutlined />} onClick={() => void load()} />
        </Space>
      }
    >
      {metrics && (
        <Space wrap size="middle" style={{ marginBottom: 16 }}>
          {KPI_DEFS.map((d) => {
            const v = metrics[d.key];
            return (
              <Card key={d.key} size="small" style={{ minWidth: 140 }}>
                <Statistic
                  title={d.name}
                  value={v === null || v === undefined ? '—' : (v * 100).toFixed(1)}
                  suffix={v === null || v === undefined ? undefined : '%'}
                />
              </Card>
            );
          })}
        </Space>
      )}
      <Table<TypeStat> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        rowKey="serviceType"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
      />
    </Card>
  );
}
