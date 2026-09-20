import {
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  FeeItem,
  TariffPlan,
  TariffPlanDetail,
  TariffStatus,
  TariffTier,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  cleanBody,
  fmtDate,
  fmtTime,
  newIdemKey,
  USAGE_CATEGORY_LABELS,
  USAGE_CATEGORY_OPTIONS,
} from '../common';
import { CALC_TYPE_LABELS, TARIFF_STATUS_COLORS, TARIFF_STATUS_LABELS } from './common';

interface TierRow {
  fromQty?: string;
  toQty?: string;
  unitPrice?: string;
}

interface TierGroup {
  feeItemId?: string;
  tiers?: TierRow[];
}

interface TariffFormValues {
  code?: string;
  name: string;
  usageCategory?: string;
  effectiveFrom: dayjs.Dayjs;
  effectiveTo?: dayjs.Dayjs | null;
  groups?: TierGroup[];
}

interface ActiveFormValues {
  effectiveTo: dayjs.Dayjs;
}

/** qty 最多 4 位小数；单价最多 6 位小数（与服务端 assertDecimal/列精度对齐）。 */
const DEC4 = /^\d+(\.\d{1,4})?$/;
const DEC6 = /^\d+(\.\d{1,6})?$/;

/** ≤4 位小数的精确比较：先乘 10000 取整再比，避免浮点尾差。 */
const micro = (s: string) => Math.round(Number(s) * 10000);

type ModalState =
  | { kind: 'create' }
  | { kind: 'edit'; plan: TariffPlanDetail }
  | { kind: 'editActive'; plan: TariffPlan }
  | { kind: 'newVersion'; plan: TariffPlanDetail }
  | null;

/**
 * 资费计划（TariffPlan）：版本化价目表 —— 列表 + 新建（阶梯编辑器）+
 * 详情抽屉 + 状态驱动操作：草稿全量编辑 / 生效中仅可提前结束 /
 * 已停用不可编辑；调价永远走“新版本”复制，不改已发布版本。
 */
export default function Tariffs() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('billing:write');

  const [rows, setRows] = useState<TariffPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [usageInput, setUsageInput] = useState('');
  const [usageCategory, setUsageCategory] = useState('');
  const [status, setStatus] = useState<TariffStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [feeItems, setFeeItems] = useState<FeeItem[]>([]);

  const [detail, setDetail] = useState<TariffPlanDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [modal, setModal] = useState<ModalState>(null);
  const [idemKey, setIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [form] = Form.useForm<TariffFormValues>();
  const [activeForm] = Form.useForm<ActiveFormValues>();

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<TariffPlan[]>('/tariff-plans', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(usageCategory.trim() ? { usageCategory: usageCategory.trim() } : {}),
            ...(status ? { status } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [message, status, usageCategory],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  // 费用项一次拉全（租户级配置，量级小）——阶梯选择器与详情名称共用。
  useEffect(() => {
    api
      .get<FeeItem[]>('/fee-items', { params: { take: 200 } })
      .then((res) => setFeeItems(res.data))
      .catch((err) => message.error(apiErrorText(err)));
  }, [message]);

  const feeItemLabel = useCallback(
    (id: string) => {
      const f = feeItems.find((x) => x.id === id);
      return f ? `${f.name}（${f.code}）` : `${id.slice(0, 8)}…`;
    },
    [feeItems],
  );

  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const detailSeq = useRef(0);

  const openDetail = async (row: TariffPlan) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api.get<TariffPlanDetail>(`/tariff-plans/${row.id}`);
      if (seq === detailSeq.current) setDetail(res.data);
    } catch (err) {
      if (seq === detailSeq.current) message.error(apiErrorText(err));
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  };

  /** tiers → 按费用项分组的表单初值（服务端按 feeItemId,tierNo 排序返回）。 */
  const tiersToGroups = (tiers: TariffTier[]): TierGroup[] => {
    const order: string[] = [];
    const map = new Map<string, TierRow[]>();
    for (const t of tiers) {
      if (!map.has(t.feeItemId)) {
        map.set(t.feeItemId, []);
        order.push(t.feeItemId);
      }
      map.get(t.feeItemId)!.push({
        fromQty: t.fromQty,
        toQty: t.toQty ?? '',
        unitPrice: t.unitPrice,
      });
    }
    return order.map((feeItemId) => ({ feeItemId, tiers: map.get(feeItemId)! }));
  };

  const openEdit = async (row: TariffPlan) => {
    if (row.status === 'ACTIVE') {
      // 长期有效的方案不预填日期（默认今天没有意义），让用户主动选择关账日。
      activeForm.setFieldsValue({
        effectiveTo: row.effectiveTo ? dayjs(row.effectiveTo) : undefined,
      });
      setModal({ kind: 'editActive', plan: row });
      return;
    }
    // DRAFT 全量编辑需要 tiers —— 先取详情。
    try {
      const res = await api.get<TariffPlanDetail>(`/tariff-plans/${row.id}`);
      const plan = res.data;
      form.setFieldsValue({
        name: plan.name,
        effectiveFrom: dayjs(plan.effectiveFrom),
        effectiveTo: plan.effectiveTo ? dayjs(plan.effectiveTo) : null,
        groups: tiersToGroups(plan.tiers),
      });
      setModal({ kind: 'edit', plan });
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const openNewVersion = async (row: TariffPlan) => {
    try {
      const res = await api.get<TariffPlanDetail>(`/tariff-plans/${row.id}`);
      const plan = res.data;
      form.setFieldsValue({
        name: plan.name,
        effectiveFrom: undefined,
        effectiveTo: plan.effectiveTo ? dayjs(plan.effectiveTo) : null,
        groups: tiersToGroups(plan.tiers),
      });
      setIdemKey(newIdemKey());
      setModal({ kind: 'newVersion', plan });
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({ groups: [{ tiers: [{ fromQty: '0' }] }] });
    setIdemKey(newIdemKey());
    setModal({ kind: 'create' });
  };

  /**
   * 客户端阶梯校验（服务端仍以 TIER_* 为准）：每个费用项独立成梯 ——
   * 第一档从 0 开始、区间首尾相接、最后一档开放（toQty 留空）、
   * from<to、单价 ≥0。
   */
  const validateGroups = (groups: TierGroup[] | undefined): string | null => {
    if (!groups || groups.length === 0) return null; // 草稿允许空阶梯
    const seen = new Set<string>();
    for (const g of groups) {
      if (!g.feeItemId) return '每个阶梯组必须选择费用项';
      if (seen.has(g.feeItemId)) return '同一费用项只能有一组阶梯';
      seen.add(g.feeItemId);
      const tiers = g.tiers ?? [];
      if (tiers.length === 0) return `「${feeItemLabel(g.feeItemId)}」至少需要一档`;
      for (let i = 0; i < tiers.length; i++) {
        const t = tiers[i];
        const tag = `「${feeItemLabel(g.feeItemId)}」第 ${i + 1} 档`;
        if (!DEC4.test((t.fromQty ?? '').trim())) {
          return `${tag}起始量需为非负数（最多 4 位小数）`;
        }
        if (!DEC6.test((t.unitPrice ?? '').trim())) {
          return `${tag}单价需为非负数（最多 6 位小数）`;
        }
        const toQty = (t.toQty ?? '').trim();
        if (i === tiers.length - 1) {
          if (toQty !== '') return `${tag}为最后一档，结束量必须留空（∞）`;
        } else if (!DEC4.test(toQty)) {
          return `${tag}结束量需为非负数（最多 4 位小数）`;
        }
      }
      if (micro(tiers[0].fromQty!.trim()) !== 0) {
        return `「${feeItemLabel(g.feeItemId)}」第一档起始量必须为 0`;
      }
      for (let i = 0; i < tiers.length - 1; i++) {
        const cur = tiers[i];
        const next = tiers[i + 1];
        if (micro(cur.toQty!.trim()) <= micro(cur.fromQty!.trim())) {
          return `「${feeItemLabel(g.feeItemId)}」第 ${i + 1} 档结束量需大于起始量`;
        }
        if (micro(cur.toQty!.trim()) !== micro(next.fromQty!.trim())) {
          return `「${feeItemLabel(g.feeItemId)}」第 ${i + 1} 档结束量需等于第 ${i + 2} 档起始量（阶梯需连续）`;
        }
      }
    }
    return null;
  };

  const flattenTiers = (groups: TierGroup[] | undefined) =>
    (groups ?? []).flatMap((g) =>
      (g.tiers ?? []).map((t, i) => ({
        feeItemId: g.feeItemId!,
        tierNo: i + 1,
        fromQty: t.fromQty!.trim(),
        toQty: (t.toQty ?? '').trim() === '' ? null : t.toQty!.trim(),
        unitPrice: t.unitPrice!.trim(),
      })),
    );

  const submit = async () => {
    let values: TariffFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const tierErr = validateGroups(values.groups);
    if (tierErr) {
      message.error(tierErr);
      return;
    }
    // 服务端 effectiveTo 缺省会“继承源方案截止日”，所以清空必须显式发 null，
    // 且客户端先挡住“截止日 ≤ 生效日”（否则继承值可能撞 TARIFF_WINDOW_INVALID）。
    if (
      modal?.kind === 'newVersion' &&
      values.effectiveTo &&
      !values.effectiveTo.isAfter(values.effectiveFrom, 'day')
    ) {
      message.error('新版本的失效日期必须晚于生效日期');
      return;
    }
    setSaving(true);
    try {
      if (modal?.kind === 'create') {
        await api.post(
          '/tariff-plans',
          cleanBody({
            code: values.code,
            name: values.name,
            usageCategory: values.usageCategory,
            effectiveFrom: values.effectiveFrom.format('YYYY-MM-DD'),
            effectiveTo: values.effectiveTo ? values.effectiveTo.format('YYYY-MM-DD') : undefined,
            tiers: flattenTiers(values.groups),
          }),
          { headers: { 'Idempotency-Key': idemKey } },
        );
        message.success('资费方案已创建（草稿），激活后生效');
      } else if (modal?.kind === 'edit') {
        await api.patch(`/tariff-plans/${modal.plan.id}`, {
          name: values.name.trim(),
          effectiveFrom: values.effectiveFrom.format('YYYY-MM-DD'),
          // PATCH 语义：null = 清除生效截止（开放区间）。
          effectiveTo: values.effectiveTo ? values.effectiveTo.format('YYYY-MM-DD') : null,
          tiers: flattenTiers(values.groups),
        });
        message.success('资费方案已更新');
      } else if (modal?.kind === 'newVersion') {
        await api.post(
          `/tariff-plans/${modal.plan.id}/new-version`,
          cleanBody({
            name: values.name,
            effectiveFrom: values.effectiveFrom.format('YYYY-MM-DD'),
            // null = 长期有效；undefined 会被服务端解释为“继承源方案截止日”。
            effectiveTo: values.effectiveTo ? values.effectiveTo.format('YYYY-MM-DD') : null,
            tiers: flattenTiers(values.groups),
          }),
          { headers: { 'Idempotency-Key': idemKey } },
        );
        message.success('已生成新版本（草稿），激活后生效');
      }
      setModal(null);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const submitActiveEdit = async () => {
    let values: ActiveFormValues;
    try {
      values = await activeForm.validateFields();
    } catch {
      return;
    }
    if (modal?.kind !== 'editActive') return;
    const plan = modal.plan;
    const to = values.effectiveTo.format('YYYY-MM-DD');
    // 生效中只允许把窗口提前关小：≥ effectiveFrom 且 ≤ 原 effectiveTo。
    if (values.effectiveTo.isBefore(dayjs(plan.effectiveFrom), 'day')) {
      message.error('结束日期不能早于生效日期');
      return;
    }
    if (
      plan.effectiveTo &&
      values.effectiveTo.isAfter(dayjs(plan.effectiveTo), 'day')
    ) {
      message.error('已生效方案的结束日期只能提前，不能延后');
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/tariff-plans/${plan.id}`, { effectiveTo: to });
      message.success('生效区间已提前结束');
      setModal(null);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const transition = async (
    plan: TariffPlan,
    action: 'activate' | 'retire',
    okText: string,
  ) => {
    setActing(plan.id);
    try {
      // activate/retire 是幂等包装的 POST —— 每次操作生成新键。
      await api.post(
        `/tariff-plans/${plan.id}/${action}`,
        {},
        { headers: { 'Idempotency-Key': newIdemKey() } },
      );
      message.success(`${plan.name}（${plan.code}）${okText}`);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setActing(null);
      await load(page, pageSize); // 失败也刷新 —— 状态可能已变
    }
  };

  const tierColumns: ColumnsType<TariffTier> = [
    {
      title: '费用项',
      dataIndex: 'feeItemId',
      key: 'feeItemId',
      render: feeItemLabel,
    },
    { title: '档号', dataIndex: 'tierNo', key: 'tierNo', width: 60, align: 'center' },
    {
      title: '起始量(m³)',
      dataIndex: 'fromQty',
      key: 'fromQty',
      width: 100,
      align: 'right',
    },
    {
      title: '结束量(m³)',
      dataIndex: 'toQty',
      key: 'toQty',
      width: 100,
      align: 'right',
      render: (v: string | null) => v ?? '∞',
    },
    {
      title: '单价(元/m³)',
      dataIndex: 'unitPrice',
      key: 'unitPrice',
      width: 110,
      align: 'right',
    },
  ];

  const columns: ColumnsType<TariffPlan> = [
    { title: '编码', dataIndex: 'code', key: 'code', width: 120 },
    { title: '名称', dataIndex: 'name', key: 'name', width: 200, minWidth: 200 },
    {
      title: '用水类别',
      dataIndex: 'usageCategory',
      key: 'usageCategory',
      width: 110,
      render: (v: string) => USAGE_CATEGORY_LABELS[v] ?? v,
    },
    {
      title: '生效区间',
      key: 'window',
      width: 200,
      minWidth: 200,
      render: (_: unknown, r: TariffPlan) =>
        `${fmtDate(r.effectiveFrom)} ~ ${r.effectiveTo ? fmtDate(r.effectiveTo) : '长期'}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (s: TariffStatus) => (
        <Tag color={TARIFF_STATUS_COLORS[s]}>{TARIFF_STATUS_LABELS[s]}</Tag>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 165,
      minWidth: 165,
      render: fmtTime,
    },
    {
      title: '操作',
      key: 'actions',
      width: 300,
      render: (_: unknown, record: TariffPlan) => (
        <Space size={4} wrap>
          <Button size="small" icon={<SearchOutlined />} onClick={() => void openDetail(record)}>
            详情
          </Button>
          {canWrite && record.status !== 'RETIRED' && (
            <Button size="small" icon={<EditOutlined />} onClick={() => void openEdit(record)}>
              编辑
            </Button>
          )}
          {canWrite && record.status === 'DRAFT' && (
            <Popconfirm
              title={`激活 ${record.name}？`}
              description="同用水类别下生效区间重叠会激活失败；无阶梯的草稿不能激活。"
              okText="激活"
              okButtonProps={{ loading: acting === record.id }}
              cancelText="取消"
              onConfirm={() => void transition(record, 'activate', '已激活')}
            >
              <Button
                size="small"
                type="primary"
                ghost
                icon={<CheckCircleOutlined />}
                loading={acting === record.id}
              >
                激活
              </Button>
            </Popconfirm>
          )}
          {canWrite && record.status === 'ACTIVE' && (
            <Popconfirm
              title={`停用 ${record.name}？`}
              description="停用后该账期起不再按此方案开账；已出账单不受影响。"
              okText="停用"
              okButtonProps={{ danger: true, loading: acting === record.id }}
              cancelText="取消"
              onConfirm={() => void transition(record, 'retire', '已停用')}
            >
              <Button size="small" danger icon={<StopOutlined />} loading={acting === record.id}>
                停用
              </Button>
            </Popconfirm>
          )}
          {canWrite && (
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => void openNewVersion(record)}
            >
              新版本
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const feeItemOptions = feeItems.map((f) => ({
    value: f.id,
    label: `${f.name}（${f.code} · ${CALC_TYPE_LABELS[f.calcType]}）`,
  }));

  /** 阶梯编辑器 —— create/edit/newVersion 共用（groups Form.List）。 */
  const tierEditor = (
    <Form.List name="groups">
      {(groupFields, { add: addGroup, remove: removeGroup }) => (
        <Space direction="vertical" style={{ width: '100%' }}>
          {groupFields.map((gf) => (
            <Card
              key={gf.key}
              size="small"
              type="inner"
              title={
                <Form.Item
                  name={[gf.name, 'feeItemId']}
                  rules={[{ required: true, message: '请选择费用项' }]}
                  style={{ margin: 0, minWidth: 280 }}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={feeItemOptions}
                    placeholder="选择费用项（每组一套阶梯）"
                  />
                </Form.Item>
              }
              extra={
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<MinusCircleOutlined />}
                  onClick={() => removeGroup(gf.name)}
                >
                  移除
                </Button>
              }
            >
              <Form.List name={[gf.name, 'tiers']}>
                {(tierFields, { add: addTier, remove: removeTier }) => (
                  <>
                    {tierFields.map((tf, i) => (
                      <Space key={tf.key} align="baseline" wrap style={{ display: 'flex' }}>
                        <Tag color="blue">第 {i + 1} 档</Tag>
                        <Form.Item
                          name={[tf.name, 'fromQty']}
                          rules={[
                            { required: true, message: '必填' },
                            { pattern: DEC4, message: '≤4 位小数' },
                          ]}
                          style={{ marginBottom: 8 }}
                        >
                          <Input placeholder="起始量" style={{ width: 110 }} />
                        </Form.Item>
                        <span>~</span>
                        <Form.Item
                          name={[tf.name, 'toQty']}
                          rules={[{ pattern: DEC4, message: '≤4 位小数' }]}
                          style={{ marginBottom: 8 }}
                        >
                          <Input
                            placeholder={i === tierFields.length - 1 ? '留空=∞' : '结束量'}
                            style={{ width: 110 }}
                          />
                        </Form.Item>
                        <Form.Item
                          name={[tf.name, 'unitPrice']}
                          rules={[
                            { required: true, message: '必填' },
                            { pattern: DEC6, message: '≤6 位小数' },
                          ]}
                          style={{ marginBottom: 8 }}
                        >
                          <Input placeholder="单价(元/m³)" style={{ width: 130 }} />
                        </Form.Item>
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          disabled={tierFields.length <= 1}
                          onClick={() => removeTier(tf.name)}
                        />
                      </Space>
                    ))}
                    <Button
                      size="small"
                      type="dashed"
                      icon={<PlusOutlined />}
                      onClick={() => addTier()}
                    >
                      加一档
                    </Button>
                  </>
                )}
              </Form.List>
            </Card>
          ))}
          <Button
            type="dashed"
            block
            icon={<PlusOutlined />}
            onClick={() => addGroup({ tiers: [{ fromQty: '0' }] })}
          >
            添加费用项阶梯
          </Button>
          <Alert
            type="info"
            showIcon
            message="每个费用项独立一套阶梯：第一档起始量必须为 0，各档区间首尾相接，最后一档结束量留空表示不限量。草稿允许暂不配置阶梯（激活前必须补齐）。"
          />
        </Space>
      )}
    </Form.List>
  );

  const modalTitle =
    modal?.kind === 'create'
      ? '新建资费方案'
      : modal?.kind === 'edit'
        ? `编辑资费方案 — ${modal.plan.name}（草稿）`
        : modal?.kind === 'newVersion'
          ? `新版本 — ${modal.plan.name}（${modal.plan.code}）`
          : '';

  return (
    <Card
      title="资费计划"
      extra={
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="按用水类别过滤"
            style={{ width: 200 }}
            value={usageInput}
            onChange={(e) => setUsageInput(e.target.value)}
            onSearch={(v) => {
              setUsageCategory(v);
              setPage(1);
            }}
          />
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 130 }}
            options={(['DRAFT', 'ACTIVE', 'RETIRED'] as const).map((s) => ({
              value: s,
              label: TARIFF_STATUS_LABELS[s],
            }))}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(page, pageSize)}>
            刷新
          </Button>
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建资费方案
            </Button>
          )}
        </Space>
      }
    >
      <Table<TariffPlan>
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 1400 }}
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

      {/* 新建 / 草稿编辑 / 新版本（阶梯编辑器） */}
      <Modal
        open={
          modal?.kind === 'create' || modal?.kind === 'edit' || modal?.kind === 'newVersion'
        }
        title={modalTitle}
        width={760}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        {modal?.kind === 'newVersion' && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="新版本以复制的形式创建草稿（同编码、新生效日期），原版本不被修改 —— 这是唯一的调价路径。"
          />
        )}
        <Form form={form} layout="vertical">
          {modal?.kind === 'create' && (
            <Space.Compact block>
              <Form.Item
                name="code"
                label="编码"
                rules={[{ required: true, message: '请输入编码' }]}
                style={{ width: '50%', marginRight: 8 }}
              >
                <Input placeholder="如 RESIDENTIAL_WATER" />
              </Form.Item>
              <Form.Item
                name="usageCategory"
                label="用水类别"
                rules={[{ required: true, message: '请选择用水类别' }]}
                style={{ width: '50%' }}
                extra="须与水表户的用水类别一致"
              >
                <Select options={USAGE_CATEGORY_OPTIONS} placeholder="选择用水类别" />
              </Form.Item>
            </Space.Compact>
          )}
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="如 居民生活用水阶梯价" />
          </Form.Item>
          <Space.Compact block>
            <Form.Item
              name="effectiveFrom"
              label="生效日期"
              rules={[{ required: true, message: '请选择生效日期' }]}
              style={{ width: '50%', marginRight: 8 }}
            >
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="effectiveTo"
              label="失效日期（可空）"
              style={{ width: '50%' }}
              extra="留空表示长期有效"
            >
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space.Compact>
          <Form.Item label="阶梯配置">{tierEditor}</Form.Item>
        </Form>
      </Modal>

      {/* 生效中编辑：仅可提前结束窗口 */}
      <Modal
        open={modal?.kind === 'editActive'}
        title={
          modal?.kind === 'editActive'
            ? `编辑生效区间 — ${modal.plan.name}（已生效）`
            : ''
        }
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitActiveEdit()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        {modal?.kind === 'editActive' && (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="已生效方案只允许把生效窗口提前关小（不能延后或重新开放）；其它字段已被版本冻结，调价请走“新版本”。"
            />
            <Form form={activeForm} layout="vertical">
              <Form.Item
                name="effectiveTo"
                label="失效日期"
                rules={[{ required: true, message: '请选择失效日期' }]}
                extra={`当前生效区间 ${fmtDate(modal.plan.effectiveFrom)} ~ ${modal.plan.effectiveTo ? fmtDate(modal.plan.effectiveTo) : '长期'}`}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>

      {/* 详情抽屉 */}
      <Drawer
        open={detail !== null || detailLoading}
        width={720}
        title={detail ? `资费详情 — ${detail.name}（${detail.code}）` : '资费详情'}
        onClose={() => setDetail(null)}
      >
        {detailLoading || !detail ? (
          <Spin />
        ) : (
          <>
            <Descriptions
              bordered
              size="small"
              column={2}
              items={[
                { key: 'code', label: '编码', children: detail.code },
                { key: 'name', label: '名称', children: detail.name },
                {
                  key: 'uc',
                  label: '用水类别',
                  children: detail.usageCategory,
                },
                {
                  key: 'status',
                  label: '状态',
                  children: (
                    <Tag color={TARIFF_STATUS_COLORS[detail.status]}>
                      {TARIFF_STATUS_LABELS[detail.status]}
                    </Tag>
                  ),
                },
                {
                  key: 'window',
                  label: '生效区间',
                  children: `${fmtDate(detail.effectiveFrom)} ~ ${detail.effectiveTo ? fmtDate(detail.effectiveTo) : '长期'}`,
                },
                {
                  key: 'created',
                  label: '创建时间',
                  children: fmtTime(detail.createdAt),
                },
              ]}
            />
            <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>阶梯明细</div>
            <Table<TariffTier>
              rowKey="id"
              size="small"
              columns={tierColumns}
              dataSource={detail.tiers}
              pagination={false}
              locale={{ emptyText: '暂无阶梯（草稿可后续补齐）' }}
            />
          </>
        )}
      </Drawer>
    </Card>
  );
}
