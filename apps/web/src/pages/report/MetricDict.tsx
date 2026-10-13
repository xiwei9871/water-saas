import { App as AntdApp, Card, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { enumLabel } from '../common';

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

const UNIT_LABELS: Record<string, string> = {
  m3: 'm³',
  cent: '分',
  ratio: '比率',
  count: '个',
  cent_per_m3: '分/m³',
};

const DIR_LABELS: Record<string, string> = {
  'higher-better': '越高越好',
  'lower-better': '越低越好',
  info: '中性指标',
};

/** C1 指标字典 —— 报表口径的唯一来源；版本号与各报表响应内嵌的
 *  metricVersion 对账。不可用指标显示原因而非静默报 0。 */
export default function MetricDict() {
  const { message } = AntdApp.useApp();
  const [data, setData] = useState<{ version: string; metrics: MetricDef[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .get<{ version: string; metrics: MetricDef[] }>('/reports/metric-dictionary')
      .then((res) => setData(res.data))
      .catch((err) => message.error(apiErrorText(err)))
      .finally(() => setLoading(false));
  }, [message]);

  const columns: ColumnsType<MetricDef> = [
    { key: 'name', dataIndex: 'name', title: '指标', width: 140 },
    { key: 'code', dataIndex: 'code', title: '编码', width: 190 },
    { key: 'formula', dataIndex: 'formula', title: '口径公式', ellipsis: true },
    { key: 'source', dataIndex: 'source', title: '数据来源', width: 220, ellipsis: true },
    {
      key: 'unit',
      dataIndex: 'unit',
      title: '单位',
      width: 80,
      render: (v: string) => enumLabel(UNIT_LABELS, v),
    },
    {
      key: 'direction',
      dataIndex: 'direction',
      title: '方向',
      width: 90,
      render: (v: string) => enumLabel(DIR_LABELS, v),
    },
    {
      key: 'available',
      dataIndex: 'available',
      title: '状态',
      width: 140,
      render: (v: boolean, r) =>
        v ? (
          <Tag color="green">可用</Tag>
        ) : (
          <Tag color="default" title={r.unavailableReason}>
            暂无数据源
          </Tag>
        ),
    },
  ];

  return (
    <Card
      title="指标字典"
      extra={
        data ? (
          <span style={{ color: '#999', fontSize: 12 }}>口径版本 {data.version}</span>
        ) : null
      }
    >
      <Table<MetricDef>
        size="small"
        rowKey="code"
        columns={columns}
        dataSource={data?.metrics ?? []}
        loading={loading}
        pagination={false}
      />
    </Card>
  );
}
