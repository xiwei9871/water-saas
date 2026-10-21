import { PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { MeterSelect } from '../pickers';

interface MeterRelation {
  id: string;
  master_meter_id: string;
  sub_meter_id: string;
  billing_mode: string;
  effective_date: string;
  expired_date: string | null;
  master_no: string;
  sub_no: string;
  master_role: string;
  sub_role: string;
}

interface LossResult {
  masterMeterId: string;
  masterUsage: number;
  subTotal: number;
  lossQty: number;
  lossRate: number | null;
  subs: { meterId: string; usage: number }[];
}

const MODE_LABEL: Record<string, string> = {
  MASTER: '按总表计费',
  SUB: '按分表计费',
};

/** 20261021 整改 任务C：总分表关系维护 + 漏损差额分析。 */
export default function MeterRelations() {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<MeterRelation[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();
  const [loss, setLoss] = useState<LossResult | null>(null);
  const [lossForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<MeterRelation[]>('/meter-relations');
      setRows(res.data);
    } catch (e) {
      message.error(apiErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async () => {
    const v = await form.validateFields();
    try {
      await api.post('/meter-relations', {
        masterMeterId: v.masterMeterId,
        subMeterId: v.subMeterId,
        billingMode: v.billingMode,
        effectiveDate: v.effectiveDate.format('YYYY-MM-DD'),
      });
      message.success('已建立总分表关系');
      setCreating(false);
      form.resetFields();
      void load();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const switchMode = async (r: MeterRelation, mode: string) => {
    try {
      await api.patch(`/meter-relations/${r.id}`, { billingMode: mode });
      message.success('计费模式已切换（同总表下全部在挂关系同步）');
      void load();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const expire = async (r: MeterRelation) => {
    try {
      await api.patch(`/meter-relations/${r.id}`, {
        expiredDate: dayjs().format('YYYY-MM-DD'),
      });
      message.success('关系已失效，表具角色回 NORMAL');
      void load();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const runLoss = async () => {
    const v = await lossForm.validateFields();
    try {
      const res = await api.get<LossResult>('/meter-relations/loss', {
        params: {
          masterMeterId: v.masterMeterId,
          ...(v.range?.[0] ? { from: v.range[0].format('YYYYMM') } : {}),
          ...(v.range?.[1] ? { to: v.range[1].format('YYYYMM') } : {}),
        },
      });
      setLoss(res.data);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const columns: ColumnsType<MeterRelation> = [
    { title: '总表', dataIndex: 'master_no' },
    { title: '分表', dataIndex: 'sub_no' },
    {
      title: '计费模式',
      dataIndex: 'billing_mode',
      width: 130,
      render: (v: string) => <Tag color={v === 'MASTER' ? 'blue' : 'green'}>{MODE_LABEL[v] ?? v}</Tag>,
    },
    { title: '生效日期', dataIndex: 'effective_date', width: 120, render: (v: string) => v?.slice(0, 10) },
    {
      title: '状态',
      dataIndex: 'expired_date',
      width: 110,
      render: (v: string | null) =>
        v ? <Tag>已失效 {v.slice(0, 10)}</Tag> : <Tag color="success">在挂</Tag>,
    },
    {
      title: '操作',
      width: 230,
      render: (_, r) =>
        r.expired_date ? null : (
          <Space>
            <Button
              size="small"
              onClick={() => void switchMode(r, r.billing_mode === 'MASTER' ? 'SUB' : 'MASTER')}
            >
              切换为{MODE_LABEL[r.billing_mode === 'MASTER' ? 'SUB' : 'MASTER']}
            </Button>
            <Button size="small" danger onClick={() => void expire(r)}>
              失效
            </Button>
          </Space>
        ),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Card
        title="总分表关系"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              新建关系
            </Button>
          </Space>
        }
      >
        <Table<MeterRelation>
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={false}
        />
      </Card>

      <Card title="漏损分析（总表用量 − 分表合计）" size="small">
        <Form form={lossForm} layout="inline">
          <Form.Item name="masterMeterId" label="总表" rules={[{ required: true }]}>
            <MeterSelect placeholder="选择总表" />
          </Form.Item>
          <Form.Item name="range" label="期间">
            <DatePicker.RangePicker picker="month" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" icon={<SearchOutlined />} onClick={() => void runLoss()}>
              分析
            </Button>
          </Form.Item>
        </Form>
        {loss && (
          <Descriptions style={{ marginTop: 16 }} size="small" column={4}>
            <Descriptions.Item label="总表用量">{loss.masterUsage.toFixed(2)} m³</Descriptions.Item>
            <Descriptions.Item label="分表合计">{loss.subTotal.toFixed(2)} m³</Descriptions.Item>
            <Descriptions.Item label="差额（漏损）">
              <Statistic
                value={loss.lossQty.toFixed(2)}
                suffix="m³"
                valueStyle={{ color: loss.lossQty > 0 ? '#cf1322' : undefined, fontSize: 16 }}
              />
            </Descriptions.Item>
            <Descriptions.Item label="漏损率">
              {loss.lossRate == null ? '—' : `${(loss.lossRate * 100).toFixed(1)}%`}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>

      <Modal
        title="新建总分表关系"
        open={creating}
        onOk={() => void onCreate()}
        onCancel={() => setCreating(false)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ billingMode: 'SUB' }}>
          <Form.Item name="masterMeterId" label="总表" rules={[{ required: true }]}>
            <MeterSelect placeholder="选择总表" />
          </Form.Item>
          <Form.Item name="subMeterId" label="分表" rules={[{ required: true }]}>
            <MeterSelect placeholder="选择分表" />
          </Form.Item>
          <Form.Item name="billingMode" label="计费模式" rules={[{ required: true }]}>
            <Radio.Group
              options={[
                { value: 'MASTER', label: '按总表计费（分表户不计费）' },
                { value: 'SUB', label: '按分表计费（总表户不计费）' },
              ]}
            />
          </Form.Item>
          <Form.Item name="effectiveDate" label="生效日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
