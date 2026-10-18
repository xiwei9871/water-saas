import { useCallback, useEffect, useState } from 'react';
import {
  App as AntdApp,
  Card,
  Descriptions,
  Drawer,
  Input,
  List,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { api, apiErrorText } from '../../api/client';
import TrendChart from '../../components/TrendChart';

interface MetricDef {
  code: string;
  name: string;
  formula: string;
  source: string;
  unit: string;
  direction: string;
  available: boolean;
  unavailableReason?: string;
}

interface TrendPoint { period: string; value: number | null }

const UNIT_LABELS: Record<string, string> = {
  m3: 'm³', cent: '元', ratio: '%', count: '个/户/笔', cent_per_m3: '元/m³',
};
const DIRECTION_LABELS: Record<string, string> = {
  'higher-better': '越高越好', 'lower-better': '越低越好', info: '参考值',
};

const fmt = (v: number | null | undefined, unit: string) => {
  if (v === null || v === undefined) return '—';
  return unit === 'ratio'
    ? `${v.toFixed(2)}%`
    : v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
};

/**
 * 指标查询（修订稿 Q2）—— KPI 指标作为报表/查询/驾驶舱共用公共资源：
 * 按名/编码搜索，展示定义、公式、统计周期口径、当前值与近 N 期趋势。
 */
export default function MetricQuery() {
  const { message } = AntdApp.useApp();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MetricDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<{
    def: MetricDef; periods: TrendPoint[]; current: number | null;
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [periods, setPeriods] = useState(12);

  const search = useCallback(async (term: string) => {
    setLoading(true);
    try {
      const res = await api.get('/reports/metric-search', { params: { q: term } });
      setItems(res.data.items);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { void search(''); }, [search]);

  const openDetail = async (def: MetricDef, n = periods) => {
    setDetailLoading(true);
    try {
      const res = await api.get(`/reports/metrics/${def.code}/detail`, {
        params: { periods: n },
      });
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div>
      <Card size="small" style={{ marginBottom: 8 }}>
        <Space wrap>
          <Input
            allowClear prefix={<SearchOutlined />} placeholder="按名称 / 编码 / 公式搜索，如：回收率"
            style={{ width: 320 }} value={q}
            onChange={(e) => { setQ(e.target.value); void search(e.target.value); }}
          />
          <Typography.Text type="secondary">
            共 {items.length} 项 · 与报表、驾驶舱同一口径
          </Typography.Text>
        </Space>
      </Card>

      <Card size="small">
        <Table<MetricDef>
          size="small" rowKey="code" loading={loading}
          dataSource={items} pagination={{ pageSize: 20 }}
          columns={[
            { title: '指标', dataIndex: 'name', width: 170,
              render: (v: string, r) => (
                <a onClick={() => void openDetail(r)}>{v}</a>
              ) },
            { title: '编码', dataIndex: 'code', width: 200 },
            { title: '单位', dataIndex: 'unit', width: 90,
              render: (v: string) => UNIT_LABELS[v] ?? v },
            { title: '方向', dataIndex: 'direction', width: 100,
              render: (v: string) => DIRECTION_LABELS[v] ?? v },
            { title: '口径公式', dataIndex: 'formula', ellipsis: true },
            { title: '可用性', dataIndex: 'available', width: 90,
              render: (v: boolean, r) =>
                v ? <Tag color="green">可用</Tag> : (
                  <Tag color="orange" title={r.unavailableReason}>待接入</Tag>
                ) },
          ]}
        />
      </Card>

      <Drawer
        title={detail ? `${detail.def.name}（${detail.def.code}）` : ''}
        open={!!detail || detailLoading}
        onClose={() => setDetail(null)}
        width={520}
      >
        <Spin spinning={detailLoading}>
          {detail && (
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="定义">{detail.def.name}</Descriptions.Item>
                <Descriptions.Item label="计算公式">{detail.def.formula}</Descriptions.Item>
                <Descriptions.Item label="数据来源">{detail.def.source}</Descriptions.Item>
                <Descriptions.Item label="单位">{UNIT_LABELS[detail.def.unit] ?? detail.def.unit}</Descriptions.Item>
                <Descriptions.Item label="当前值">
                  <Typography.Text strong style={{ fontSize: 20 }}>
                    {fmt(detail.current, detail.def.unit)}
                  </Typography.Text>
                </Descriptions.Item>
              </Descriptions>
              <Space>
                <Typography.Text type="secondary">趋势期数</Typography.Text>
                <Select
                  size="small" style={{ width: 110 }} value={periods}
                  options={[6, 12, 24, 36].map((n) => ({ value: n, label: `近 ${n} 期` }))}
                  onChange={(v) => { setPeriods(v); void openDetail(detail.def, v); }}
                />
              </Space>
              <TrendChart
                x={detail.periods.map((p) => p.period)}
                series={[{ name: detail.def.name, data: detail.periods.map((p) => p.value) }]}
                height={260}
              />
              <List
                size="small" header="近几期数值" bordered
                dataSource={[...detail.periods].reverse().slice(0, 6)}
                renderItem={(p) => (
                  <List.Item>
                    <Typography.Text>{p.period}</Typography.Text>
                    <Typography.Text strong>{fmt(p.value, detail.def.unit)}</Typography.Text>
                  </List.Item>
                )}
              />
            </Space>
          )}
        </Spin>
      </Drawer>
    </div>
  );
}
