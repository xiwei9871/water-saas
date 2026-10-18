import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  Drawer,
  Progress,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AlertOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api, apiErrorText } from '../api/client';
import TrendChart from '../components/TrendChart';
import { abbrevParts, columnScale, fmtFull, fmtSignedPct } from '../utils/numfmt';

interface OrgRow { id: string; name: string }

interface CardVal { value: number | null; momPct: number | null; yoyPct: number | null }
interface CockpitData {
  meta: { companyName: string; orgLabel: string; periodLabel: string };
  period: string;
  cards: Record<string, CardVal>;
  realtime: {
    todayCollected: number; todayPaymentCount: number; todayReadings: number;
    planRead: number; planTotal: number;
  };
  alerts: { arrearsTotal: number; openTasks: number; abnormalReadings: number };
  trend: { period: string; soldQty: number; revenue: number; collected: number; recoveryRate: number | null; compositePrice: number | null }[];
  orgRanking: { orgUnitId: string; name: string; collected: number }[];
}

const CARD_DEFS: { key: string; name: string; unit: string }[] = [
  { key: 'SOLD_QTY', name: '本月售水量', unit: 'm³' },
  { key: 'REVENUE', name: '本月营收', unit: '元' },
  { key: 'RECOVERY_RATE', name: '水费回收率', unit: '%' },
  { key: 'COMPOSITE_PRICE', name: '综合单价', unit: '元/m³' },
  { key: 'READ_ACCURACY', name: '抄表准确率', unit: '%' },
];

const TREND_METRICS = [
  { key: 'revenue', name: '营收(元)' },
  { key: 'soldQty', name: '售水量(m³)' },
  { key: 'collected', name: '实收(元)' },
  { key: 'recoveryRate', name: '回收率(%)' },
] as const;

interface ViewPref {
  cards?: string[];
  trendMetric?: string;
  periods?: number;
  orgUnitId?: string;
}

const pctTag = fmtSignedPct;

/**
 * 经营驾驶舱（修订稿 H1/H2）—— 登录首页五区：
 * 顶部 KPI 卡 / 左侧实时 / 中部趋势 / 右侧预警 / 底部片区排名。
 * 视图（卡片勾选、趋势维度与期数、组织过滤）按人保存 staff_pref。
 */
export default function Cockpit() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<CockpitData | null>(null);
  const [loading, setLoading] = useState(false);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [prefOpen, setPrefOpen] = useState(false);

  const [cards, setCards] = useState<string[]>(CARD_DEFS.map((c) => c.key));
  const [trendMetric, setTrendMetric] = useState<string>('revenue');
  const [periods, setPeriods] = useState(12);
  const [orgUnitId, setOrgUnitId] = useState<string>();

  // H2：载入个人视图
  useEffect(() => {
    api.get<ViewPref | null>('/iam/my-prefs/dashboard.view').then((r) => {
      const v = r.data;
      if (v?.cards?.length) setCards(v.cards.filter((c) => CARD_DEFS.some((d) => d.key === c)));
      if (v?.trendMetric) setTrendMetric(v.trendMetric);
      if (v?.periods) setPeriods(v.periods);
      if (v?.orgUnitId) setOrgUnitId(v.orgUnitId);
    }).catch(() => {});
    api.get<OrgRow[]>('/iam/orgs').then((r) => setOrgs(r.data)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<CockpitData>('/reports/cockpit', {
        params: { periods, orgUnitId },
      });
      setData(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [periods, orgUnitId, message]);

  useEffect(() => { void load(); }, [load]);

  const savePref = async () => {
    try {
      await api.put('/iam/my-prefs/dashboard.view', {
        value: { cards, trendMetric, periods, orgUnitId },
      });
      message.success('个人视图已保存');
      setPrefOpen(false);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const trendLabel = useMemo(
    () => TREND_METRICS.find((m) => m.key === trendMetric)?.name ?? '',
    [trendMetric],
  );

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 8 }}>
        经营驾驶舱
      </Typography.Title>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          allowClear showSearch optionFilterProp="label" style={{ width: 200 }}
          placeholder="组织范围：全公司" value={orgUnitId}
          options={orgs.map((o) => ({ value: o.id, label: o.name }))}
          onChange={(v) => setOrgUnitId(v || undefined)}
        />
        <Button icon={<SettingOutlined />} onClick={() => setPrefOpen(true)}>
          自定义视图
        </Button>
        {data && (
          <Typography.Text type="secondary">
            {data.meta.companyName} · {data.meta.orgLabel} · {data.meta.periodLabel}
          </Typography.Text>
        )}
      </Space>

      <Spin spinning={loading}>
        {data && (
          <>
            {/* ① 顶部 KPI 卡 */}
            <Row gutter={[8, 8]}>
              {CARD_DEFS.filter((c) => cards.includes(c.key)).map((c) => {
                const v = data.cards[c.key];
                const ab = abbrevParts(v?.value);
                return (
                  <Col key={c.key} flex="1 1 180px">
                    <Card size="small">
                      <Tooltip title={`${ab.full} ${c.unit}`}>
                        <Statistic
                          title={c.name}
                          value={ab.text === '—' ? undefined : ab.text}
                          suffix={`${ab.unit}${c.unit}`}
                          valueStyle={{ fontSize: 22 }}
                        />
                      </Tooltip>
                      <Space size={12} style={{ fontSize: 12 }}>
                        <Typography.Text type={v?.yoyPct != null && v.yoyPct < 0 ? 'danger' : 'success'}>
                          同比 {pctTag(v?.yoyPct ?? null)}
                          {v?.yoyPct != null && (v.yoyPct >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />)}
                        </Typography.Text>
                        <Typography.Text type={v?.momPct != null && v.momPct < 0 ? 'danger' : 'secondary'}>
                          环比 {pctTag(v?.momPct ?? null)}
                        </Typography.Text>
                      </Space>
                    </Card>
                  </Col>
                );
              })}
            </Row>

            <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
              {/* ② 左侧实时 */}
              <Col xs={24} lg={6}>
                <Card size="small" title="当日 / 本月实时">
                  <Space direction="vertical" style={{ width: '100%' }} size={12}>
                    {(() => {
                      const ab = abbrevParts(data.realtime.todayCollected);
                      return (
                        <Tooltip title={`${ab.full} 元`}>
                          <Statistic
                            title="当日实收"
                            value={ab.text === '—' ? undefined : ab.text}
                            suffix={`${ab.unit}元`}
                          />
                        </Tooltip>
                      );
                    })()}
                    <div>当日收款 <b>{data.realtime.todayPaymentCount}</b> 笔</div>
                    <div>当日抄录 <b>{data.realtime.todayReadings}</b> 条</div>
                    <div>
                      本月抄表进度 {data.realtime.planRead}/{data.realtime.planTotal}
                      <Progress
                        percent={
                          data.realtime.planTotal
                            ? Math.round((data.realtime.planRead / data.realtime.planTotal) * 100)
                            : 0
                        }
                        size="small"
                      />
                    </div>
                  </Space>
                </Card>
              </Col>

              {/* ③ 中部趋势 */}
              <Col xs={24} lg={12}>
                <Card
                  size="small"
                  title={`近 ${periods} 个月趋势`}
                  extra={
                    <Select
                      size="small" style={{ width: 130 }} value={trendMetric}
                      options={TREND_METRICS.map((m) => ({ value: m.key, label: m.name }))}
                      onChange={setTrendMetric}
                    />
                  }
                >
                  <TrendChart
                    x={data.trend.map((t) => t.period)}
                    series={[
                      {
                        name: trendLabel,
                        data: data.trend.map(
                          (t) => t[trendMetric as keyof typeof t] as number | null,
                        ),
                      },
                    ]}
                    height={300}
                  />
                </Card>
              </Col>

              {/* ④ 右侧预警 */}
              <Col xs={24} lg={6}>
                <Card size="small" title={<Space><AlertOutlined />预警</Space>}>
                  <Space direction="vertical" style={{ width: '100%' }} size={12}>
                    <div>
                      期末欠费
                      <Tooltip title={`${fmtFull(data.alerts.arrearsTotal)} 元`}>
                        <Typography.Text strong style={{ fontSize: 20, marginLeft: 8 }}>
                          {abbrevParts(data.alerts.arrearsTotal).text}
                          {abbrevParts(data.alerts.arrearsTotal).unit} 元
                        </Typography.Text>
                      </Tooltip>
                    </div>
                    <div>
                      待办任务 <Tag color="orange">{data.alerts.openTasks}</Tag>
                      <a onClick={() => navigate('/tasks')}>去处理</a>
                    </div>
                    <div>
                      本月异常读数 <Tag color="red">{data.alerts.abnormalReadings}</Tag>
                      <a onClick={() => navigate('/metering/readings')}>查看</a>
                    </div>
                  </Space>
                </Card>
              </Col>
            </Row>

            {/* ⑤ 底部片区排名 */}
            <Card size="small" title="片区 / 营业所本月实收排名" style={{ marginTop: 8 }}>
              {(() => {
                const ranking = data.orgRanking.slice(0, 10);
                // N6 整列统一单位：按列最大值选 元/万元/亿元，表头标注。
                const col = columnScale(ranking.map((r) => r.collected));
                return (
                  <Table
                    size="small" rowKey="orgUnitId" pagination={false}
                    dataSource={ranking}
                    columns={[
                      { title: '排名', width: 60, render: (_v, _r, i) => i + 1 },
                      { title: '组织', dataIndex: 'name' },
                      { title: `本月实收（${col.label}）`, dataIndex: 'collected', align: 'right',
                        render: (v: number) => col.cell(v) },
                    ]}
                  />
                );
              })()}
            </Card>
          </>
        )}
      </Spin>

      <Drawer title="自定义驾驶舱视图" open={prefOpen} onClose={() => setPrefOpen(false)} width={360}>
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          <div>
            <Typography.Text strong>指标卡片</Typography.Text>
            <Space direction="vertical" style={{ marginTop: 8 }}>
              {CARD_DEFS.map((c) => (
                <Checkbox
                  key={c.key}
                  checked={cards.includes(c.key)}
                  onChange={(e) =>
                    setCards(e.target.checked ? [...cards, c.key] : cards.filter((x) => x !== c.key))
                  }
                >
                  {c.name}
                </Checkbox>
              ))}
            </Space>
          </div>
          <div>
            <Typography.Text strong>趋势维度</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 8 }} value={trendMetric}
              options={TREND_METRICS.map((m) => ({ value: m.key, label: m.name }))}
              onChange={setTrendMetric}
            />
          </div>
          <div>
            <Typography.Text strong>趋势时间范围</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 8 }} value={periods}
              options={[6, 12, 24, 36].map((n) => ({ value: n, label: `近 ${n} 个月` }))}
              onChange={setPeriods}
            />
          </div>
          <div>
            <Typography.Text strong>组织过滤（片区）</Typography.Text>
            <Select
              allowClear showSearch optionFilterProp="label"
              style={{ width: '100%', marginTop: 8 }} value={orgUnitId}
              options={orgs.map((o) => ({ value: o.id, label: o.name }))}
              onChange={(v) => setOrgUnitId(v || undefined)}
            />
          </div>
          <Button type="primary" block onClick={savePref}>保存为我的默认视图</Button>
        </Space>
      </Drawer>
    </div>
  );
}
