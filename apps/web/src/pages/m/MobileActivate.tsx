import { useCallback, useEffect, useState } from 'react';
import {
  App as AntdApp,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { EnvironmentOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, apiErrorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { cleanBody, CALIBER_OPTIONS } from '../common';
import type { WaterAccount } from '../../api/types';

/** crypto.randomUUID 仅在安全上下文可用 —— 内网 http 部署需回退。 */
const idemKey = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `m-act-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

interface ActivateFormValues {
  meterNo: string;
  initialReading: string;
  accountNoOk: boolean;
  caliberOk: boolean;
  addrOk: boolean;
  nameOk: boolean;
  segNo?: string;
  cadence?: string;
  serialNo?: string;
  brand?: string;
  model?: string;
  caliber?: string;
  maxDial?: number;
}

/**
 * 1028v2 立户上号（H5）：抄表员现场处理派给自己的「待上号」预占户 ——
 * 四项一致复核 + 录表号挂装 → PENDING_COMPLETE，回厅补录后转正常。
 */
export default function MobileActivate() {
  const { message } = AntdApp.useApp();
  const { user, hasPerm } = useAuth();
  const myId = user?.id ?? '';
  const isManager = hasPerm('iam:write') || hasPerm('*');
  const [rows, setRows] = useState<WaterAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [activateFor, setActivateFor] = useState<WaterAccount | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ActivateFormValues>();
  const [meterCands, setMeterCands] = useState<
    { meterNo: string; caliber?: string | null; brand?: string | null; serialNo?: string | null; maxDial?: number | string | null; source: string }[]
  >([]);
  // P1-1/1103：与桌面端一致——候选水表下拉（出库+本单），选中自动带入要素。
  const openActivate = (r: WaterAccount) => {
    form.resetFields();
    setActivateFor(r);
    setMeterCands([]);
    api
      .get<{ pendingCaliber: string | null; candidates: typeof meterCands }>(
        `/water-accounts/${r.id}/meter-candidates`,
      )
      .then((res) => setMeterCands(res.data.candidates ?? []))
      .catch(() => undefined);
  };
  const onPickMeter = (meterNo: string) => {
    const m = meterCands.find((c) => c.meterNo === meterNo);
    if (m) {
      form.setFieldsValue({
        caliber: m.caliber ?? undefined,
        brand: m.brand ?? undefined,
        serialNo: m.serialNo ?? undefined,
        maxDial: m.maxDial != null ? Number(m.maxDial) : undefined,
      });
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<WaterAccount[]>('/water-accounts', {
        params: { status: 'PENDING_ASSIGN', take: 200 },
      });
      // 服务端按 customer:read 放行；抄表员只见派给自己的，管理岗(iam:write)全量。
      setRows(
        isManager
          ? res.data
          : res.data.filter((r) => !r.assignReaderId || r.assignReaderId === myId),
      );
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [message, myId]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const submit = async () => {
    let values: ActivateFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (!activateFor) return;
    setSaving(true);
    try {
      await api.post(
        `/water-accounts/${activateFor.id}/activate`,
        cleanBody({
          meterNo: values.meterNo,
          initialReading: values.initialReading,
          review: {
            accountNoOk: values.accountNoOk === true,
            caliberOk: values.caliberOk === true,
            addrOk: values.addrOk === true,
            nameOk: values.nameOk === true,
          },
          segNo: values.segNo,
          cadence: values.cadence,
          meterInfo: cleanBody({
            serialNo: values.serialNo,
            brand: values.brand,
            model: values.model,
            caliber: values.caliber,
            maxDial: values.maxDial,
          }),
        }),
        { headers: { 'Idempotency-Key': idemKey() } },
      );
      message.success(`上号完成：${activateFor.accountNo}`);
      setActivateFor(null);
      form.resetFields();
      await load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
        <Typography.Text type="secondary">
          待上号 {rows.length} 户（派给我的上号任务）
        </Typography.Text>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} />
      </Space>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : rows.length === 0 ? (
        <Empty description="暂无待上号户" style={{ padding: '40px 0' }} />
      ) : (
        rows.map((r) => (
          <Card
            key={r.id}
            size="small"
            style={{ marginBottom: 8 }}
            title={
              <Space size={6}>
                <Typography.Text strong>{r.accountNo}</Typography.Text>
                <Tag color="purple">待上号</Tag>
              </Space>
            }
            extra={
              <Button size="small" type="primary" onClick={() => openActivate(r)}>
                上号
              </Button>
            }
          >
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              
              <div>
                <EnvironmentOutlined /> {r.addr}
              </div>
              <div>预占口径：{r.pendingCaliber ?? '—'}</div>
            </div>
          </Card>
        ))
      )}

      <Modal maskClosable={false}
        open={activateFor !== null}
        title={activateFor ? `上号 — ${activateFor.accountNo}` : ''}
        okText="确认上号"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setActivateFor(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
            地址：{activateFor?.addr ?? '—'}
          </Typography.Paragraph>
          <Form.Item
            name="meterNo"
            label="现场安装水表表号"
            rules={[{ required: true, message: '请选择或输入表号' }]}
            extra="下拉为本单/出库候选，选中自动带入要素；也可人工输入"
          >
            <AutoComplete
              placeholder="选择候选水表或输入物理表号"
              size="large"
              options={meterCands.map((c) => ({
                value: c.meterNo,
                label: `${c.meterNo}${c.caliber ? ` · ${c.caliber}` : ''}${c.source === 'APPLY' ? ' · 本单' : ''}`,
              }))}
              filterOption={(v, o) => (o?.value ?? '').toLowerCase().includes(v.toLowerCase())}
              onSelect={onPickMeter}
            />
          </Form.Item>
          <Form.Item
            name="initialReading"
            label="表底初始读数"
            rules={[{ required: true, message: '请输入初始读数' }]}
          >
            <Input placeholder="默认 0" size="large" inputMode="decimal" />
          </Form.Item>
          <Space wrap>
            <Form.Item name="segNo" label="抄表段号(01–16)" style={{ width: 150 }}>
              <Select allowClear showSearch optionFilterProp="label" placeholder="01"
                options={Array.from({ length: 16 }, (_, i) => ({ value: String(i + 1).padStart(2, '0'), label: String(i + 1).padStart(2, '0') }))} />
            </Form.Item>
            <Form.Item name="cadence" label="抄表频次" style={{ width: 140 }} initialValue="MONTHLY">
              <Select options={[
                { value: 'MONTHLY', label: '每月' },
                { value: 'ODD_MONTH', label: '单月' },
                { value: 'EVEN_MONTH', label: '双月' },
                { value: 'QUARTERLY', label: '季度' },
              ]} />
            </Form.Item>
          </Space>
          <Card size="small" title="四项一致复核" style={{ marginBottom: 12 }}>
            {(
              [
                ['accountNoOk', `用户档案号一致（${activateFor?.accountNo ?? '—'}）`],
                ['caliberOk', `水表口径一致（${activateFor?.pendingCaliber ?? '—'}）`],
                ['addrOk', '安装地址一致'],
                ['nameOk', '用户名称一致'],
              ] as const
            ).map(([name, label]) => (
              <Form.Item
                key={name}
                name={name}
                valuePropName="checked"
                style={{ marginBottom: 6 }}
                rules={[
                  {
                    validator: (_r, v) =>
                      v ? Promise.resolve() : Promise.reject(new Error('须确认')),
                  },
                ]}
              >
                <Checkbox>{label}</Checkbox>
              </Form.Item>
            ))}
          </Card>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            表计未建档时补建要素（选填）：
          </Typography.Text>
          <Space wrap style={{ marginTop: 6 }}>
            <Form.Item name="serialNo" label="出厂编号" style={{ marginBottom: 4 }}>
              <Input style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="brand" label="品牌" style={{ marginBottom: 4 }}>
              <Input style={{ width: 100 }} />
            </Form.Item>
            <Form.Item name="model" label="型号" style={{ marginBottom: 4 }}>
              <Input style={{ width: 100 }} />
            </Form.Item>
            <Form.Item name="caliber" label="口径" style={{ marginBottom: 4 }}>
              <Select allowClear showSearch optionFilterProp="label" style={{ width: 110 }}
                placeholder={activateFor?.pendingCaliber ?? 'DN15'} options={CALIBER_OPTIONS} />
            </Form.Item>
            <Form.Item name="maxDial" label="最大读数" style={{ marginBottom: 4 }}>
              <InputNumber min={0} style={{ width: 110 }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
