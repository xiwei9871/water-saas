import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DownloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Tabs,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import SummaryPanel from './SummaryPanel';
import { BILL_STATUS_LABELS } from '../billing/common';
import { READ_SOURCE_LABELS } from '../metering/common';
import { PAY_CHANNEL_LABELS } from '../payment/common';
import {
  ACCOUNT_STATUS_LABELS,
  fmtCent,
  fmtDate,
  fmtPeriod,
  USAGE_CATEGORY_LABELS,
  USAGE_CATEGORY_OPTIONS,
} from '../common';
import { columnScale } from '../../utils/numfmt';
import {
  CustomerSelect,
  OrgUnitTreeSelect,
  ReadingBookSelect,
  SettleAccountLookupSelect,
  useDebounced,
} from '../pickers';

/**
 * 统一数据查询（2026-10-15 设计方案）—— 三区域布局：
 * ① 查询条件：对象（指定户/结算户/客户/抄表册/组织）+ 起止账期 + 档案筛选
 * ② 字段勾选：按主题分组，勾选才联查
 * ③ 结果：行=户，账期级字段×账期横向展开，欠费累计为右侧固定列，可导出
 */

interface FieldMeta { key: string; label: string; grain: 'account' | 'period' | 'cumulative' }
interface FieldTheme { theme: string; label: string; fields: FieldMeta[] }
interface UnifiedRow {
  waterAccountId: string;
  fixed: Record<string, unknown>;
  periods: Record<string, Record<string, unknown>>;
  cumulative: Record<string, unknown>;
}
interface UnifiedResp {
  rows: UnifiedRow[];
  total: number;
  periods: string[];
  fields: { key: string; label: string; grain: FieldMeta['grain'] }[];
  deniedFields: string[];
}
interface WaOption { id: string; accountNo: string; customer: { name: string }; addr: string }
/** 个人查询模板（阶段三）——payload 存「表单值+objectKind+fields顺序」。 */
interface QueryTemplate {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  updatedAt: string;
}

const BILL_KIND_LABELS: Record<string, string> = {
  NORMAL: '正常账单', ADJUSTMENT: '调账', REPLACEMENT: '换单',
};

type ObjectKind = 'all' | 'accounts' | 'settle' | 'customer' | 'book' | 'org';

/** 用水户多选（对象筛选用）——搜索分页拉候选。 */
function WaterAccountMultiSelect({
  value,
  onChange,
}: { value?: string[]; onChange?: (v: string[]) => void }) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [fetching, setFetching] = useState(false);
  const fetch = async (kw: string) => {
    setFetching(true);
    try {
      const res = await api.get<WaOption[]>('/water-accounts', {
        params: { take: 50, ...(kw.trim() ? { q: kw.trim() } : {}) },
      });
      setOptions((prev) => {
        const merged = new Map(prev.map((o) => [o.value, o]));
        for (const a of res.data) {
          merged.set(a.id, {
            value: a.id,
            label: `${a.accountNo} · ${a.customer.name} · ${a.addr}`,
          });
        }
        return [...merged.values()];
      });
    } finally {
      setFetching(false);
    }
  };
  useEffect(() => {
    queueMicrotask(() => void fetch(''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onSearch = useDebounced((kw) => void fetch(kw));
  return (
    <Select
      mode="multiple"
      showSearch
      filterOption={false}
      placeholder="户号 / 客户 / 地址"
      loading={fetching}
      options={options}
      value={value}
      onChange={onChange}
      onSearch={onSearch}
      style={{ minWidth: 360 }}
      maxTagCount={4}
    />
  );
}

const MONEY_KEYS = new Set([
  'totalAmount', 'allocated', 'remaining',
  'collectedAmount', 'arrearsAmount', 'writtenOff',
]);
const DATE_KEYS = new Set(['openedAt', 'closedAt', 'lastPaidAt']);

const renderCell = (key: string, v: unknown): React.ReactNode => {
  if (v === null || v === undefined || v === '') return '—';
  if (MONEY_KEYS.has(key)) return fmtCent(v as string | number);
  if (DATE_KEYS.has(key)) return fmtDate(v as string);
  switch (key) {
    case 'usageCategory':
      return USAGE_CATEGORY_LABELS[String(v)] ?? String(v);
    case 'accountStatus':
      return ACCOUNT_STATUS_LABELS[String(v) as keyof typeof ACCOUNT_STATUS_LABELS] ?? String(v);
    case 'billStatus':
      return String(v).split('、').map((s) => BILL_STATUS_LABELS[s as keyof typeof BILL_STATUS_LABELS] ?? s).join('、');
    case 'billKind':
      return String(v).split('、').map((s) => BILL_KIND_LABELS[s] ?? s).join('、');
    case 'channels':
      return String(v).split('、').map((s) => (s === 'PREPAY' ? '预存抵扣' : PAY_CHANNEL_LABELS[s as keyof typeof PAY_CHANNEL_LABELS] ?? s)).join('、');
    case 'readSource':
      return String(v).split(',').map((s) => READ_SOURCE_LABELS[s as keyof typeof READ_SOURCE_LABELS] ?? s).join('、');
    case 'isEstimated':
      return v === true || v === 'true' ? '估抄' : '实抄';
    case 'oldestPeriod':
      return fmtPeriod(String(v));
    default:
      return String(v);
  }
};

function DetailQuery() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [themes, setThemes] = useState<FieldTheme[]>([]);
  const [spanMax, setSpanMax] = useState(12);
  const [checked, setChecked] = useState<string[]>(['usageQty', 'totalAmount']);
  const [objectKind, setObjectKind] = useState<ObjectKind>('all');
  const [rows, setRows] = useState<UnifiedRow[]>([]);
  const [respFields, setRespFields] = useState<UnifiedResp['fields']>([]);
  const [respPeriods, setRespPeriods] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [queried, setQueried] = useState(false);
  const [templates, setTemplates] = useState<QueryTemplate[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [innerKw, setInnerKw] = useState('');

  const loadTemplates = async () => {
    try {
      const res = await api.get<QueryTemplate[]>('/reports/query/unified/templates');
      setTemplates(res.data);
    } catch {
      /* 模板加载失败不阻断查询 */
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ themes: FieldTheme[]; periodSpanMax: number }>(
          '/reports/query/unified/fields',
        );
        setThemes(res.data.themes);
        setSpanMax(res.data.periodSpanMax);
      } catch (err) {
        message.error(apiErrorText(err));
      }
      void loadTemplates();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  const allKeys = useMemo(() => themes.flatMap((t) => t.fields.map((f) => f.key)), [themes]);
  const labelOf = useMemo(() => {
    const m = new Map(themes.flatMap((t) => t.fields.map((f) => [f.key, f.label] as const)));
    return (k: string) => m.get(k) ?? k;
  }, [themes]);

  /** 主题内勾选变化：保留其它主题既有顺序，本主题仍勾选的按原序、新勾的追加尾部。 */
  const mergeThemeChecked = (themeKeys: string[], next: string[]) =>
    setChecked((prev) => [
      ...prev.filter((k) => !themeKeys.includes(k) || next.includes(k)),
      ...next.filter((k) => !prev.includes(k)),
    ]);

  const moveField = (i: number, d: -1 | 1) =>
    setChecked((prev) => {
      const j = i + d;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  /** 当前表单状态 → 模板 payload（账期存 YYYYMM 字符串）。 */
  const buildTemplatePayload = (): Record<string, unknown> => {
    const v = form.getFieldsValue() as Record<string, unknown>;
    return {
      objectKind,
      waterAccountIds: v.waterAccountIds,
      settleAccountId: v.settleAccountId,
      customerId: v.customerId,
      bookId: v.bookId,
      orgUnitId: v.orgUnitId,
      periodFrom: (v.periodFrom as Dayjs | undefined)?.format('YYYYMM'),
      periodTo: (v.periodTo as Dayjs | undefined)?.format('YYYYMM'),
      usageCategories: v.usageCategories,
      statuses: v.statuses,
      estimated: v.estimated,
      arrearsMin: v.arrearsMin,
      agingMin: v.agingMin,
      fields: checked,
    };
  };

  const applyTemplate = (t: QueryTemplate) => {
    const p = t.payload;
    setObjectKind((p.objectKind as ObjectKind) ?? 'all');
    form.setFieldsValue({
      waterAccountIds: p.waterAccountIds,
      settleAccountId: p.settleAccountId,
      customerId: p.customerId,
      bookId: p.bookId,
      orgUnitId: p.orgUnitId,
      periodFrom: typeof p.periodFrom === 'string' ? dayjs(`${p.periodFrom}01`) : null,
      periodTo: typeof p.periodTo === 'string' ? dayjs(`${p.periodTo}01`) : null,
      usageCategories: p.usageCategories,
      statuses: p.statuses,
      estimated: p.estimated,
      arrearsMin: p.arrearsMin,
      agingMin: p.agingMin,
    });
    // 模板里已下线/无权限的字段按键池剔除
    setChecked(((p.fields as string[]) ?? []).filter((k) => allKeys.includes(k)));
    message.success(`已应用模板「${t.name}」，点击查询执行`);
  };

  const saveTemplate = async () => {
    const name = saveName.trim();
    if (!name) {
      message.warning('请输入模板名称');
      return;
    }
    try {
      await api.post('/reports/query/unified/templates', {
        name,
        payload: buildTemplatePayload(),
      });
      message.success(`模板「${name}」已保存`);
      setSaveOpen(false);
      setSaveName('');
      void loadTemplates();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const deleteTemplate = async (t: QueryTemplate) => {
    try {
      await api.delete(`/reports/query/unified/templates/${t.id}`);
      message.success(`模板「${t.name}」已删除`);
      void loadTemplates();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const buildBody = (skip = 0, take?: number) => {
    const v = form.getFieldsValue() as Record<string, unknown>;
    const from = v.periodFrom as Dayjs | undefined;
    const to = v.periodTo as Dayjs | undefined;
    return {
      periodFrom: from!.format('YYYYMM'),
      periodTo: to!.format('YYYYMM'),
      fields: checked,
      waterAccountIds: objectKind === 'accounts' ? (v.waterAccountIds as string[]) : undefined,
      settleAccountIds: objectKind === 'settle' && v.settleAccountId ? [v.settleAccountId as string] : undefined,
      customerIds: objectKind === 'customer' && v.customerId ? [v.customerId as string] : undefined,
      bookIds: objectKind === 'book' && v.bookId ? [v.bookId as string] : undefined,
      bookNo: (v.bookNo as string | undefined)?.trim() || undefined,
      orgUnitId: objectKind === 'org' ? (v.orgUnitId as string | undefined) : undefined,
      usageCategories: (v.usageCategories as string[] | undefined)?.length
        ? (v.usageCategories as string[])
        : undefined,
      statuses: (v.statuses as string[] | undefined)?.length
        ? (v.statuses as string[])
        : undefined,
      estimated: (v.estimated as 'ONLY' | 'EXCLUDE' | undefined) || undefined,
      arrearsMin: v.arrearsMin ? Math.round(Number(v.arrearsMin) * 100) : undefined,
      agingMin: v.agingMin !== undefined && v.agingMin !== null ? Number(v.agingMin) : undefined,
      take: take ?? pageSize,
      skip,
    };
  };

  const runQuery = async (pg = 1, size = pageSize) => {
    if (checked.length === 0) {
      message.warning('请至少勾选一个字段');
      return;
    }
    setLoading(true);
    try {
      const res = await api.post<UnifiedResp>(
        '/reports/query/unified',
        buildBody((pg - 1) * size, size),
      );
      if (res.data.deniedFields?.length) {
        message.warning(`以下字段无权限已剔除：${res.data.deniedFields.join('、')}`);
      }
      setRows(res.data.rows);
      setTotal(res.data.total);
      setRespFields(res.data.fields);
      setRespPeriods(res.data.periods);
      setPage(pg);
      setPageSize(size);
      setQueried(true);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  };

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const res = await api.post('/reports/query/unified/export', buildBody(0, 20000), {
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `统一数据查询-${dayjs().format('YYYYMMDD')}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('导出完成');
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setExporting(false);
    }
  };

  const accountCols = respFields.filter((f) => f.grain === 'account');
  const periodCols = respFields.filter((f) => f.grain === 'period');
  const cumCols = respFields.filter((f) => f.grain === 'cumulative');

  const flatRows = rows.map((r) => {
    const out: Record<string, unknown> = { waterAccountId: r.waterAccountId, ...r.fixed };
    for (const p of respPeriods) {
      for (const [k, v] of Object.entries(r.periods[p] ?? {})) out[`${p}_${k}`] = v;
    }
    Object.assign(out, r.cumulative);
    // 结果内筛选的检索串：按渲染后文本匹配（中文标签/金额格式均可命中）
    const hay = [
      ...accountCols.map((f) => renderCell(f.key, r.fixed[f.key])),
      ...respPeriods.flatMap((p) =>
        periodCols.map((f) => renderCell(f.key, r.periods[p]?.[f.key])),
      ),
      ...cumCols.map((f) => renderCell(f.key, r.cumulative[f.key])),
    ]
      .map((x) => (typeof x === 'string' ? x : ''))
      .join(' ');
    out.__hay = hay;
    return out;
  });

  const kw = innerKw.trim();
  const shownRows = kw
    ? flatRows.filter((r) => (r.__hay as string).includes(kw))
    : flatRows;

  // N6 报表/查询表格整列自适应：金额列按列内最大值统一选 元/万元/亿元，
  // 表头标注单位。行值为分，换算成元后按组内最大绝对值定标。
  const moneyScale = (vals: unknown[]) =>
    columnScale(
      vals.map((v) =>
        v === null || v === undefined || v === '' ? null : Number(v) / 100,
      ),
    );
  /** 金额列包装：标题带单位标注、单元格按列单位换算。 */
  const moneyColumn = (
    f: FieldMeta,
    title: string,
    getVal: (row: Record<string, unknown>) => unknown,
    extra: Record<string, unknown> = {},
  ) => {
    if (!MONEY_KEYS.has(f.key)) {
      return {
        title, key: f.key, width: 110,
        render: (_: unknown, row: Record<string, unknown>) => renderCell(f.key, getVal(row)),
        ...extra,
      };
    }
    const sc = moneyScale(shownRows.map(getVal));
    return {
      title: `${title}${sc.label === '元' ? '' : `（${sc.label}）`}`,
      key: f.key, width: 110,
      render: (_: unknown, row: Record<string, unknown>) => {
        const v = getVal(row);
        return v === null || v === undefined || v === ''
          ? '—'
          : sc.cell(Number(v) / 100);
      },
      ...extra,
    };
  };

  const columns: ColumnsType<Record<string, unknown>> = [
    ...accountCols.map((f, i) => ({
      title: f.label,
      dataIndex: f.key,
      key: f.key,
      fixed: (i < 2 ? 'left' : undefined) as 'left' | undefined,
      width: f.key === 'addr' ? 200 : 110,
      render: (v: unknown) => renderCell(f.key, v),
    })),
    ...respPeriods.flatMap((p) =>
      periodCols.map((f) =>
        moneyColumn(
          f,
          `${fmtPeriod(p)} ${f.label}`,
          (row) => row[`${p}_${f.key}`],
          { key: `${p}_${f.key}`, width: f.key === 'priceText' ? 260 : 110 },
        ),
      ),
    ),
    ...cumCols.map((f) =>
      moneyColumn(f, f.label, (row) => row[f.key], {
        key: `c_${f.key}`,
        fixed: 'right' as const,
      }),
    ),
  ];

  return (
    <>
      <Card
        title="统一数据查询"
        size="small"
        style={{ marginBottom: 12 }}
        extra={
          <Space size={4}>
            <Select
              size="small"
              placeholder="我的模板"
              style={{ minWidth: 140 }}
              options={templates.map((t) => ({ value: t.id, label: t.name }))}
              onChange={(id) => {
                const t = templates.find((x) => x.id === id);
                if (t) applyTemplate(t);
              }}
              allowClear
              onClear={() => undefined}
            />
            <Button size="small" onClick={() => setSaveOpen(true)}>存为模板</Button>
            <Select
              size="small"
              placeholder="删除模板"
              style={{ minWidth: 110 }}
              options={templates.map((t) => ({ value: t.id, label: `✕ ${t.name}` }))}
              onChange={(id) => {
                const t = templates.find((x) => x.id === id);
                if (t) void deleteTemplate(t);
              }}
              value={null as never}
            />
          </Space>
        }
      >
        <Form
          form={form}
          layout="inline"
          style={{ rowGap: 8 }}
          onFinish={() => void runQuery(1)}
          initialValues={{
            periodFrom: dayjs().subtract(5, 'month').startOf('month'),
            periodTo: dayjs().startOf('month'),
          }}
        >
          <Form.Item label="查询对象">
            <Radio.Group
              value={objectKind}
              onChange={(e) => setObjectKind(e.target.value as ObjectKind)}
              optionType="button"
              buttonStyle="solid"
              options={[
                { label: '全部户', value: 'all' },
                { label: '指定用水户', value: 'accounts' },
                { label: '结算户', value: 'settle' },
                { label: '客户', value: 'customer' },
                { label: '抄表册', value: 'book' },
                { label: '所属组织', value: 'org' },
              ]}
            />
          </Form.Item>
          {objectKind === 'accounts' && (
            <Form.Item name="waterAccountIds" noStyle>
              <WaterAccountMultiSelect />
            </Form.Item>
          )}
          {objectKind === 'settle' && (
            <Form.Item name="settleAccountId" noStyle>
              <SettleAccountLookupSelect placeholder="搜索结算户号 / 户名" />
            </Form.Item>
          )}
          {objectKind === 'customer' && (
            <Form.Item name="customerId" noStyle>
              <CustomerSelect placeholder="搜索客户名称" />
            </Form.Item>
          )}
          {objectKind === 'book' && (
            <Form.Item name="bookId" noStyle>
              <ReadingBookSelect />
            </Form.Item>
          )}
          {objectKind === 'org' && (
            <Form.Item name="orgUnitId" noStyle>
              <OrgUnitTreeSelect placeholder="选择组织（含下级）" />
            </Form.Item>
          )}
          <Form.Item name="periodFrom" label="账期起" rules={[{ required: true, message: '必选' }]}>
            <DatePicker picker="month" allowClear={false} />
          </Form.Item>
          <Form.Item name="periodTo" label="账期止" rules={[{ required: true, message: '必选' }]}>
            <DatePicker picker="month" allowClear={false} />
          </Form.Item>
          <Form.Item name="usageCategories" label="用水类别">
            <Select
              mode="multiple"
              allowClear
              options={USAGE_CATEGORY_OPTIONS}
              style={{ minWidth: 180 }}
              placeholder="全部"
              maxTagCount={2}
            />
          </Form.Item>
          <Form.Item name="statuses" label="户状态">
            <Select
              mode="multiple"
              allowClear
              style={{ minWidth: 140 }}
              placeholder="全部"
              maxTagCount={2}
              options={Object.entries(ACCOUNT_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item name="bookNo" label="册号">
            <Input allowClear style={{ width: 140 }} placeholder="按册号模糊筛选" />
          </Form.Item>
          <Form.Item name="estimated" label="估抄">
            <Select
              allowClear
              style={{ width: 120 }}
              placeholder="全部"
              options={[
                { value: 'ONLY', label: '仅估抄' },
                { value: 'EXCLUDE', label: '仅实抄' },
              ]}
            />
          </Form.Item>
          <Form.Item name="arrearsMin" label="欠费>（元）">
            <InputNumber min={0} style={{ width: 110 }} placeholder="不限" />
          </Form.Item>
          <Form.Item name="agingMin" label="账龄>（月）">
            <InputNumber min={0} style={{ width: 90 }} placeholder="不限" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={loading}>
              查询
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card
        title="显示字段"
        size="small"
        style={{ marginBottom: 12 }}
        extra={
          <Space>
            <Button size="small" onClick={() => setChecked(allKeys)}>全选</Button>
            <Button size="small" onClick={() => setChecked([])}>清空</Button>
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size={4}>
          {themes.map((t) => {
            const keys = t.fields
              .filter((f) => !['accountNo', 'customerName'].includes(f.key))
              .map((f) => f.key);
            const checkedIn = keys.filter((k) => checked.includes(k));
            return (
              <div key={t.theme}>
                <Checkbox
                  indeterminate={checkedIn.length > 0 && checkedIn.length < keys.length}
                  checked={keys.length > 0 && checkedIn.length === keys.length}
                  onChange={(e) =>
                    setChecked((prev) =>
                      e.target.checked
                        ? [...new Set([...prev, ...keys])]
                        : prev.filter((k) => !keys.includes(k)),
                    )
                  }
                >
                  <Typography.Text strong>{t.label}</Typography.Text>
                </Checkbox>
                <Checkbox.Group
                  style={{ marginLeft: 16 }}
                  options={t.fields
                    .filter((f) => !['accountNo', 'customerName'].includes(f.key))
                    .map((f) => ({ label: f.label, value: f.key }))}
                  value={checked}
                  onChange={(v) => mergeThemeChecked(keys, v as string[])}
                />
              </div>
            );
          })}
          {checked.length > 0 && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                已选 {checked.length} 项（顺序即列顺序）：
              </Typography.Text>
              <Space wrap size={4} style={{ marginTop: 4 }}>
                {checked.map((k, i) => (
                  <Tag
                    key={k}
                    closable
                    onClose={(e) => {
                      e.preventDefault();
                      setChecked((prev) => prev.filter((x) => x !== k));
                    }}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {labelOf(k)}
                    <Button
                      type="text"
                      size="small"
                      icon={<ArrowUpOutlined />}
                      disabled={i === 0}
                      onClick={() => moveField(i, -1)}
                      style={{ width: 18, height: 18, minWidth: 0 }}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<ArrowDownOutlined />}
                      disabled={i === checked.length - 1}
                      onClick={() => moveField(i, 1)}
                      style={{ width: 18, height: 18, minWidth: 0 }}
                    />
                  </Tag>
                ))}
              </Space>
            </div>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            户号、户名始终显示；账期级字段按账期横向展开（最多 {spanMax} 期）；欠费类为截至「账期止」的累计值。
          </Typography.Text>
        </Space>
      </Card>

      <Card
        title={
          queried
            ? `查询结果（共 ${total} 户${kw ? `，页内筛选命中 ${shownRows.length}` : ''}）`
            : '查询结果'
        }
        size="small"
        extra={
          <Space>
            <Input
              allowClear
              size="small"
              placeholder="页内筛选（当前页）"
              style={{ width: 170 }}
              value={innerKw}
              onChange={(e) => setInnerKw(e.target.value)}
            />
            <Button
              icon={<DownloadOutlined />}
              onClick={() => void exportXlsx()}
              loading={exporting}
              disabled={!queried}
            >
              导出 Excel
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="waterAccountId"
          size="small"
          loading={loading}
          dataSource={shownRows}
          columns={columns}
          scroll={{ x: 'max-content' }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [50, 100, 200],
            onChange: (pg, size) => void runQuery(pg, size),
          }}
          locale={{ emptyText: queried ? '无符合条件的数据' : '设置条件并勾选字段后点击查询' }}
        />
      </Card>

      <Modal
        title="存为查询模板"
        open={saveOpen}
        onOk={() => void saveTemplate()}
        onCancel={() => setSaveOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Input
          placeholder="模板名称（同名覆盖）"
          value={saveName}
          maxLength={50}
          onChange={(e) => setSaveName(e.target.value)}
          onPressEnter={() => void saveTemplate()}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          保存当前查询对象、账期、档案筛选与勾选字段顺序，仅本人可见。
        </Typography.Text>
      </Modal>
    </>
  );
}


/**
 * 统一数据查询（修订稿 Q1）—— 明细 / 汇总双模式同入口切换：
 * 明细 = 户×账期横向透视（≤12 期）；汇总 = 年度聚合 + 同比 + 维度。
 */
export default function UnifiedQuery() {
  return (
    <Tabs
      items={[
        { key: 'detail', label: '明细查询', children: <DetailQuery /> },
        { key: 'summary', label: '汇总趋势', children: <SummaryPanel /> },
      ]}
    />
  );
}
