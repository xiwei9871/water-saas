import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiErrorText } from '../../api/client';

interface DmaZone {
  id: string;
  code: string;
  name: string;
  region: string | null;
  orgUnitId: string | null;
  status: string;
  checkMeterCount: number;
  linkedMeterCount: number;
}

interface CheckMeterRow {
  id: string;
  meterId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  meter: { meterNo: string; meterRole: string; status: string } | null;
  linkedMeters: {
    id: string;
    meterId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    meter: { meterNo: string; status: string } | null;
  }[];
}

interface DashRow {
  dma: { id: string; code: string; name: string; region: string | null };
  checkMeterCount: number;
  linkedMeterCount: number;
  checkQty: string;
  linkedQty: string;
  unmeasuredQty: string;
  leakageRate: string | null;
  unreadCheckMeters: number;
}

interface UsageDetail {
  checkMeters: { meterId: string; meterNo: string | null; usageQty: string; measured: boolean }[];
  linkedMeters: { meterId: string; meterNo: string | null; usageQty: string; measured: boolean }[];
}

interface MeterOption {
  id: string;
  meterNo: string;
  meterRole: string;
  status: string;
  warehouse: { name: string } | null;
}

const RATE_COLOR = (v: number) => (v < 0 ? 'red' : v > 15 ? 'volcano' : 'green');

/** 20261023 C1/C2：DMA 管理（分区/考核表/挂接）+ 产销差看板。 */
export default function Dma() {
  const { message } = AntdApp.useApp();
  const [zones, setZones] = useState<DmaZone[]>([]);
  const [loading, setLoading] = useState(false);
  const [zoneModal, setZoneModal] = useState<'create' | DmaZone | null>(null);
  const [zoneForm] = Form.useForm();
  const [detail, setDetail] = useState<(DmaZone & { checkMeters: CheckMeterRow[] }) | null>(null);
  const [addCheckFor, setAddCheckFor] = useState<DmaZone | null>(null);
  const [linkFor, setLinkFor] = useState<CheckMeterRow | null>(null);
  const [checkOptions, setCheckOptions] = useState<MeterOption[]>([]);
  const [linkOptions, setLinkOptions] = useState<MeterOption[]>([]);
  const [checkForm] = Form.useForm();
  const [linkForm] = Form.useForm();

  // 看板
  const [period, setPeriod] = useState<Dayjs>(dayjs().subtract(1, 'month'));
  const [dashRows, setDashRows] = useState<DashRow[]>([]);
  const [trend, setTrend] = useState<{ period: string; rows: DashRow[] }[]>([]);
  const [drill, setDrill] = useState<{ dmaName: string; period: string; data: UsageDetail } | null>(null);

  const loadZones = useCallback(async () => {
    try {
      const res = await api.get<DmaZone[]>('/dma/zones', { params: { take: 200 } });
      setZones(res.data);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  }, [message]);

  const loadDash = useCallback(async () => {
    setLoading(true);
    try {
      const p = period.format('YYYYMM');
      const prev = period.clone().subtract(1, 'month').format('YYYYMM');
      const prev2 = period.clone().subtract(2, 'month').format('YYYYMM');
      const res = await api.get<{ period: string; rows: DashRow[] }[]>('/dma/dashboard', {
        params: { periods: `${prev2},${prev},${p}` },
      });
      setTrend(res.data);
      setDashRows(res.data.find((d) => d.period === p)?.rows ?? []);
    } catch (e) {
      message.error(apiErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [message, period]);

  useEffect(() => {
    void loadZones();
  }, [loadZones]);
  useEffect(() => {
    void loadDash();
  }, [loadDash]);

  const openDetail = async (id: string) => {
    try {
      const res = await api.get<DmaZone & { checkMeters: CheckMeterRow[] }>(`/dma/zones/${id}`);
      setDetail(res.data);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const saveZone = async () => {
    const v = await zoneForm.validateFields();
    try {
      if (zoneModal === 'create') {
        await api.post('/dma/zones', v);
        message.success('DMA 分区已建');
      } else if (zoneModal) {
        await api.patch(`/dma/zones/${zoneModal.id}`, v);
        message.success('分区已更新');
      }
      setZoneModal(null);
      zoneForm.resetFields();
      void loadZones();
      void loadDash();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  /** 挂考核表：候选 = CHECK 角色表。 */
  const openAddCheck = async (z: DmaZone) => {
    setAddCheckFor(z);
    checkForm.resetFields();
    try {
      const res = await api.get<MeterOption[]>('/meters', { params: { take: 200 } });
      setCheckOptions(res.data.filter((m) => m.meterRole === 'CHECK'));
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };
  const addCheck = async () => {
    const v = await checkForm.validateFields();
    try {
      await api.post(`/dma/zones/${addCheckFor!.id}/check-meters`, v);
      message.success('考核表已挂接');
      setAddCheckFor(null);
      void loadZones();
      if (detail) void openDetail(detail.id);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  /** 挂接水表：候选 = 非 CHECK 的计费侧表。 */
  const openLink = async (c: CheckMeterRow) => {
    setLinkFor(c);
    linkForm.resetFields();
    try {
      const res = await api.get<MeterOption[]>('/meters', { params: { take: 200 } });
      const used = new Set(c.linkedMeters.filter((l) => !l.effectiveTo).map((l) => l.meterId));
      setLinkOptions(res.data.filter((m) => m.meterRole !== 'CHECK' && !used.has(m.id)));
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };
  const addLink = async () => {
    const v = await linkForm.validateFields();
    try {
      const r = await api.post<{ count: number; skipped: number }>(
        `/dma/check-meters/${linkFor!.id}/links`,
        { meterIds: v.meterIds },
      );
      message.success(
        `已挂接 ${r.data.count} 只水表${r.data.skipped ? `，${r.data.skipped} 只已在挂跳过` : ''}`,
      );
      setLinkFor(null);
      void loadZones();
      if (detail) void openDetail(detail.id);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const drillUsage = async (dmaId: string, dmaName: string) => {
    try {
      const p = period.format('YYYYMM');
      const res = await api.get<UsageDetail>(`/dma/zones/${dmaId}/usage`, { params: { period: p } });
      setDrill({ dmaName, period: p, data: res.data });
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const zoneCols: ColumnsType<DmaZone> = [
    { title: '分区编号', dataIndex: 'code', width: 130 },
    { title: '分区名称', dataIndex: 'name', width: 150 },
    { title: '区域', dataIndex: 'region', render: (v) => v ?? '—' },
    {
      title: '考核表 / 挂接表',
      width: 120,
      render: (_, r) => `${r.checkMeterCount} / ${r.linkedMeterCount}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (s: string) => <Tag color={s === 'ACTIVE' ? 'green' : 'default'}>{s === 'ACTIVE' ? '启用' : '停用'}</Tag>,
    },
    {
      title: '操作',
      width: 200,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => void openDetail(r.id)}>
            关系
          </Button>
          <Button size="small" type="link" onClick={() => setZoneModal(r)}>
            编辑
          </Button>
          <Button size="small" type="link" onClick={() => void openAddCheck(r)}>
            挂考核表
          </Button>
        </Space>
      ),
    },
  ];

  const dashCols: ColumnsType<DashRow> = [
    { title: 'DMA 分区', render: (_, r) => `${r.dma.name}（${r.dma.code}）`, width: 190 },
    { title: '区域', render: (_, r) => r.dma.region ?? '—', width: 110 },
    { title: '考核表数', dataIndex: 'checkMeterCount', width: 90, align: 'right' },
    { title: '挂接表数', dataIndex: 'linkedMeterCount', width: 90, align: 'right' },
    {
      title: '考核表总水量 (m³)',
      dataIndex: 'checkQty',
      align: 'right',
      width: 140,
      render: (v: string, r) => (
        <span>
          {v}
          {r.unreadCheckMeters > 0 && (
            <Typography.Text type="warning" style={{ fontSize: 11 }}>
              {' '}
              ({r.unreadCheckMeters}表未抄)
            </Typography.Text>
          )}
        </span>
      ),
    },
    { title: '挂接总水量 (m³)', dataIndex: 'linkedQty', align: 'right', width: 140 },
    { title: '未计量水量 (m³)', dataIndex: 'unmeasuredQty', align: 'right', width: 140 },
    {
      title: '漏损率',
      dataIndex: 'leakageRate',
      align: 'right',
      width: 100,
      render: (v: string | null) =>
        v === null ? '—' : <Tag color={RATE_COLOR(Number(v))}>{v}%</Tag>,
    },
    {
      title: '明细',
      width: 70,
      render: (_, r) => (
        <Button size="small" type="link" onClick={() => void drillUsage(r.dma.id, r.dma.name)}>
          下钻
        </Button>
      ),
    },
  ];

  // 趋势：近 3 期漏损率对比（列=期，行=DMA）
  const trendCols = useMemo(() => {
    const periods = trend.map((t) => t.period);
    const byDma = new Map<string, { name: string; rates: (string | null)[] }>();
    for (const t of trend) {
      for (const r of t.rows) {
        const e = byDma.get(r.dma.id) ?? { name: `${r.dma.name}（${r.dma.code}）`, rates: [] };
        while (e.rates.length < periods.indexOf(t.period)) e.rates.push(null);
        e.rates.push(r.leakageRate);
        byDma.set(r.dma.id, e);
      }
    }
    const rows = [...byDma.entries()].map(([id, e]) => ({
      key: id,
      name: e.name,
      ...Object.fromEntries(periods.map((p, i) => [`p${p}`, e.rates[i] ?? null])),
    }));
    const cols: ColumnsType<(typeof rows)[number]> = [
      { title: 'DMA 分区', dataIndex: 'name', width: 200 },
      ...periods.map((p) => ({
        title: `${p.slice(0, 4)}-${p.slice(4)} 漏损率`,
        dataIndex: `p${p}`,
        align: 'right' as const,
        render: (v: string | null) =>
          v === null ? '—' : <Tag color={RATE_COLOR(Number(v))}>{v}%</Tag>,
      })),
    ];
    return { cols, rows };
  }, [trend]);

  const usageCols = (title: string) =>
    [
      { title, dataIndex: 'meterNo', render: (v: string | null) => v ?? '—' },
      {
        title: '本期水量 (m³)',
        dataIndex: 'usageQty',
        align: 'right' as const,
      },
      {
        title: '计量状态',
        dataIndex: 'measured',
        width: 100,
        render: (m: boolean) =>
          m ? <Tag color="green">已计量</Tag> : <Tag color="orange">本期未抄到</Tag>,
      },
    ] satisfies ColumnsType<UsageDetail['checkMeters'][number]>;

  return (
    <Card
      title="DMA 分区计量（产销差）"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => { void loadZones(); void loadDash(); }} loading={loading} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setZoneModal('create')}>
            建分区
          </Button>
        </Space>
      }
    >
      <Tabs
        items={[
          {
            key: 'dash',
            label: '产销差看板',
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Typography.Text>账期：</Typography.Text>
                  <DatePicker
                    picker="month"
                    value={period}
                    onChange={(d) => d && setPeriod(d)}
                    allowClear={false}
                  />
                </Space>
                <Table<DashRow>
                  rowKey={(r) => r.dma.id}
                  size="small"
                  loading={loading}
                  columns={dashCols}
                  dataSource={dashRows}
                  pagination={false}
                />
                <Typography.Title level={5} style={{ marginTop: 20 }}>
                  漏损率趋势（近 3 期）
                </Typography.Title>
                <Table
                  size="small"
                  columns={trendCols.cols}
                  dataSource={trendCols.rows}
                  pagination={false}
                />
              </>
            ),
          },
          {
            key: 'zones',
            label: 'DMA 分区',
            children: (
              <Table<DmaZone>
                rowKey="id"
                size="small"
                columns={zoneCols}
                dataSource={zones}
                pagination={{ pageSize: 20 }}
              />
            ),
          },
        ]}
      />

      {/* 建/编分区 */}
      <Modal
        title={zoneModal === 'create' ? '建 DMA 分区' : `编辑分区：${zoneModal?.name ?? ''}`}
        open={!!zoneModal}
        onOk={() => void saveZone()}
        onCancel={() => setZoneModal(null)}
        destroyOnHidden
      >
        <Form
          form={zoneForm}
          layout="vertical"
          initialValues={zoneModal && zoneModal !== 'create' ? zoneModal : {}}
          preserve={false}
        >
          <Form.Item name="code" label="分区编号" rules={[{ required: true }]}>
            <Input disabled={zoneModal !== 'create'} placeholder="DMA-01" />
          </Form.Item>
          <Form.Item name="name" label="分区名称" rules={[{ required: true }]}>
            <Input placeholder="城东DMA" />
          </Form.Item>
          <Form.Item name="region" label="区域">
            <Input placeholder="城东片区" />
          </Form.Item>
          {zoneModal !== 'create' && (
            <Form.Item name="status" label="状态">
              <Select
                options={[
                  { value: 'ACTIVE', label: '启用' },
                  { value: 'DISABLED', label: '停用' },
                ]}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 挂考核表 */}
      <Modal
        title={`挂考核表：${addCheckFor?.name ?? ''}`}
        open={!!addCheckFor}
        onOk={() => void addCheck()}
        onCancel={() => setAddCheckFor(null)}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          仅可挂「考核表（CHECK）」角色的监控表；考核表只做区域水量计量，不参与计费。
        </Typography.Paragraph>
        <Form form={checkForm} layout="vertical">
          <Form.Item name="meterId" label="考核表" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={checkOptions.map((m) => ({
                value: m.id,
                label: `${m.meterNo}（${m.status}）`,
              }))}
              notFoundContent="无 CHECK 角色表——先在表具档案建考核表"
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 挂接水表 */}
      <Modal
        title={`挂接水表 → ${linkFor?.meter?.meterNo ?? ''}`}
        open={!!linkFor}
        onOk={() => void addLink()}
        onCancel={() => setLinkFor(null)}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          挂接对象为计费侧水表（普通/总/分表），同一分表可同时挂接多只考核表。
        </Typography.Paragraph>
        <Form form={linkForm} layout="vertical">
          <Form.Item name="meterIds" label="水表（可多选）" rules={[{ required: true }]}>
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              options={linkOptions.map((m) => ({ value: m.id, label: m.meterNo }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 分区关系抽屉 */}
      <Drawer
        title={detail ? `DMA 关系：${detail.name}` : ''}
        open={!!detail}
        onClose={() => setDetail(null)}
        width={640}
      >
        {detail && (
          <>
            <Descriptions size="small" column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="编号">{detail.code}</Descriptions.Item>
              <Descriptions.Item label="区域">{detail.region ?? '—'}</Descriptions.Item>
            </Descriptions>
            <Button size="small" type="primary" onClick={() => void openAddCheck(detail)} style={{ marginBottom: 12 }}>
              挂考核表
            </Button>
            {detail.checkMeters.length === 0 && (
              <Typography.Text type="secondary">尚未挂接考核表。</Typography.Text>
            )}
            {detail.checkMeters.map((c) => (
              <Card
                key={c.id}
                size="small"
                style={{ marginBottom: 10, opacity: c.effectiveTo ? 0.55 : 1 }}
                title={
                  <Space>
                    <span>考核表 {c.meter?.meterNo ?? c.meterId}</span>
                    {c.effectiveTo ? (
                      <Tag>已摘除 {c.effectiveTo.slice(0, 10)}</Tag>
                    ) : (
                      <Tag color="green">有效</Tag>
                    )}
                  </Space>
                }
                extra={
                  !c.effectiveTo && (
                    <Space>
                      <Button size="small" type="link" onClick={() => void openLink(c)}>
                        挂接水表
                      </Button>
                      <Button
                        size="small"
                        type="link"
                        danger
                        onClick={() =>
                          void api
                            .delete(`/dma/check-meters/${c.id}`)
                            .then(() => openDetail(detail.id))
                            .catch((e) => message.error(apiErrorText(e)))
                        }
                      >
                        摘除
                      </Button>
                    </Space>
                  )
                }
              >
                {c.linkedMeters.filter((l) => !l.effectiveTo).length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    无在挂水表
                  </Typography.Text>
                ) : (
                  <Space wrap size={4}>
                    {c.linkedMeters
                      .filter((l) => !l.effectiveTo)
                      .map((l) => (
                        <Tag
                          key={l.id}
                          closable
                          onClose={(e) => {
                            e.preventDefault();
                            void api
                              .delete(`/dma/links/${l.id}`)
                              .then(() => openDetail(detail.id))
                              .catch((err) => message.error(apiErrorText(err)));
                          }}
                        >
                          {l.meter?.meterNo ?? l.meterId}
                        </Tag>
                      ))}
                  </Space>
                )}
              </Card>
            ))}
          </>
        )}
      </Drawer>

      {/* 看板下钻 */}
      <Drawer
        title={drill ? `产销差明细：${drill.dmaName} · ${drill.period.slice(0, 4)}-${drill.period.slice(4)}` : ''}
        open={!!drill}
        onClose={() => setDrill(null)}
        width={560}
      >
        {drill && (
          <>
            <Row gutter={16} style={{ marginBottom: 12 }}>
              <Col span={8}>
                <Statistic
                  title="考核表总水量 (m³)"
                  value={drill.data.checkMeters.reduce((a, c) => a + Number(c.usageQty), 0).toFixed(2)}
                />
              </Col>
              <Col span={8}>
                <Statistic
                  title="挂接总水量 (m³)"
                  value={drill.data.linkedMeters.reduce((a, c) => a + Number(c.usageQty), 0).toFixed(2)}
                />
              </Col>
            </Row>
            <Typography.Title level={5}>考核表</Typography.Title>
            <Table
              size="small"
              rowKey="meterId"
              columns={usageCols('考核表号')}
              dataSource={drill.data.checkMeters}
              pagination={false}
            />
            <Typography.Title level={5} style={{ marginTop: 16 }}>
              挂接水表
            </Typography.Title>
            <Table
              size="small"
              rowKey="meterId"
              columns={usageCols('水表号')}
              dataSource={drill.data.linkedMeters}
              pagination={false}
            />
          </>
        )}
      </Drawer>
    </Card>
  );
}
