import { useCallback, useEffect, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { EnvironmentOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, apiErrorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { cleanBody } from '../common';
import type { WaterAccount } from '../../api/types';

/** crypto.randomUUID 仅在安全上下文可用 —— 内网 http 部署需回退。 */
const idemKey = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `m-act-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

interface ActivateFormValues {
  meterNo: string;
  initialReading: string;
  meterNoOk: boolean;
  archiveNoOk: boolean;
  addrOk: boolean;
  nameOk: boolean;
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
  const { user } = useAuth();
  const myId = user?.id ?? '';
  const [rows, setRows] = useState<WaterAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [activateFor, setActivateFor] = useState<WaterAccount | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ActivateFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<WaterAccount[]>('/water-accounts', {
        params: { status: 'PENDING_ASSIGN', take: 200 },
      });
      // 服务端按 customer:read 放行；现场只应看到派给自己的上号任务。
      setRows(res.data.filter((r) => !r.assignReaderId || r.assignReaderId === myId));
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
            meterNoOk: values.meterNoOk === true,
            archiveNoOk: values.archiveNoOk === true,
            addrOk: values.addrOk === true,
            nameOk: values.nameOk === true,
          },
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
                <Typography.Text strong>{r.archiveNo ?? '—'}</Typography.Text>
                <Tag color="purple">待上号</Tag>
              </Space>
            }
            extra={
              <Button size="small" type="primary" onClick={() => { form.resetFields(); setActivateFor(r); }}>
                上号
              </Button>
            }
          >
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              <div>户号：{r.accountNo}</div>
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
        title={activateFor ? `上号 — ${activateFor.archiveNo ?? activateFor.accountNo}` : ''}
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
            rules={[{ required: true, message: '请输入表号' }]}
          >
            <Input placeholder="物理表号" size="large" />
          </Form.Item>
          <Form.Item
            name="initialReading"
            label="表底初始读数"
            rules={[{ required: true, message: '请输入初始读数' }]}
          >
            <Input placeholder="默认 0" size="large" inputMode="decimal" />
          </Form.Item>
          <Card size="small" title="四项一致复核" style={{ marginBottom: 12 }}>
            {(
              [
                ['meterNoOk', '水表号与档案一致'],
                ['archiveNoOk', `档案号一致（${activateFor?.archiveNo ?? '—'}）`],
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
              <Input style={{ width: 80 }} placeholder={activateFor?.pendingCaliber ?? 'DN15'} />
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
