import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import {
  FOCUS_ROW_CLASS,
  FocusTaskBar,
  useFocusList,
  useFocusParams,
  useTaskGroup,
} from '../../components/TaskFocus';
import { api, apiErrorText } from '../../api/client';
import { enumLabel, newIdemKey } from '../common';
import { WaterAccountSearchSelect } from '../pickers';
import Table from '../../components/PageTable';


interface Violation {
  id: string;
  waterAccountId: string;
  waterAccount?: { accountNo: string; customer: { customerNo: string; name: string } } | null;
  violationType: string;
  status: string;
  sourceType: string;
  reporterId: string | null;
  occurredDate: string | null;
  description: string | null;
  photoRefs: string[] | null;
  penaltyAmount: string | null;
  backbillAmount: string | null;
  processedAt: string | null;
  serviceOrderId: string | null;
  createdAt: string;
}

export const VIOLATION_TYPE_LABELS: Record<string, string> = {
  THEFT: '盗窃用水',
  PRIVATE_CONN: '私自接水',
  TAMPER: '破坏表计',
  SEAL_BROKEN: '破坏铅封',
  CATEGORY_MISUSE: '擅自改变用水性质',
};
const STATUS_LABEL: Record<string, string> = {
  PENDING_REVIEW: '待核实',
  PROCESSING: '处理中',
  PROCESSED: '已处理',
  ARCHIVED: '已归档',
  DISMISSED: '误报',
};
const STATUS_COLOR: Record<string, string> = {
  PENDING_REVIEW: 'orange',
  PROCESSING: 'blue',
  PROCESSED: 'purple',
  ARCHIVED: 'default',
  DISMISSED: 'default',
};

/** 20261021 整改 任务E：违章用水管理（稽查登记/抄表上报→核实→处理→佐证归档）。 */
export default function Violations() {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<Violation[]>([]);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<'create' | 'verify' | 'process' | 'archive' | null>(null);
  const [cur, setCur] = useState<Violation | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ items: Violation[] }>('/violations', {
        params: { take: 200 },
      });
      setRows(res.data.items);
    } catch (e) {
      message.error(apiErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (a: typeof action, r?: Violation) => {
    setCur(r ?? null);
    setAction(a);
  };

  const submit = async () => {
    const v = await form.validateFields();
    try {
      if (action === 'create') {
        await api.post(
          '/violations',
          {
            waterAccountId: v.waterAccountId,
            violationType: v.violationType,
            occurredDate: v.occurredDate?.format('YYYY-MM-DD'),
            description: v.description,
            photoRefs: String(v.photoRefs ?? '').split(/[\s,，;；]+/).filter(Boolean),
          },
          { headers: { 'Idempotency-Key': newIdemKey() } },
        );
        message.success('违章已登记（任务已派发稽查岗）');
      } else if (action === 'verify' && cur) {
        await api.post(`/violations/${cur.id}/verify`, {
          confirm: v.confirm,
          note: v.note,
        });
        message.success(v.confirm ? '已确认，转正式处理' : '已按误报关闭');
      } else if (action === 'process' && cur) {
        await api.post(`/violations/${cur.id}/process`, {
          penaltyAmount: v.penaltyAmount,
          backbillAmount: v.backbillAmount,
          note: v.note,
          serviceOrderId: v.serviceOrderId || undefined,
        });
        message.success('处理完成');
      } else if (action === 'archive' && cur) {
        await api.post(`/violations/${cur.id}/archive`, {
          evidence: {
            site: String(v.site ?? '').split(/[\s,，;；]+/).filter(Boolean),
            penaltyDoc: String(v.penaltyDoc ?? '').split(/[\s,，;；]+/).filter(Boolean),
          },
        });
        message.success('已归档');
      }
      setAction(null);
      form.resetFields();
      void load();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const { focusId, clear: clearFocus } = useFocusParams();
  // A3 任务三态分组：违章处置任务挂在违章单上。
  const taskGroup = useTaskGroup<Violation>('violation', rows, (r) => r.id);
  const focusList = useFocusList<Violation>(
    focusId,
    taskGroup.filtered,
    focusId ? (r) => r.id === focusId : null,
  );
  const shownRows = focusList.shown;
  const columns: ColumnsType<Violation> = [
    {
      title: '用水户',
      width: 190,
      render: (_, r) =>
        r.waterAccount
          ? `${r.waterAccount.accountNo} ${r.waterAccount.customer.name}`
          : '—',
    },
    {
      title: '类型',
      dataIndex: 'violationType',
      width: 130,
      render: (v: string) => enumLabel(VIOLATION_TYPE_LABELS, v),
    },
    {
      title: '来源',
      dataIndex: 'sourceType',
      width: 100,
      render: (v: string) => (v === 'READING' ? <Tag color="orange">抄表上报</Tag> : <Tag>稽查登记</Tag>),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => <Tag color={STATUS_COLOR[v]}>{STATUS_LABEL[v] ?? v}</Tag>,
    },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    {
      title: '罚款/补缴',
      width: 120,
      render: (_, r) =>
        r.penaltyAmount || r.backbillAmount
          ? `¥${r.penaltyAmount ?? 0} / ¥${r.backbillAmount ?? 0}`
          : '—',
    },
    {
      title: '操作',
      width: 300,
      render: (_, r) => (
        <Space size={4} wrap>
          {r.status === 'PENDING_REVIEW' && (
            <Button size="small" onClick={() => open('verify', r)}>核实</Button>
          )}
          {r.status === 'PROCESSING' && (
            <Button size="small" type="primary" onClick={() => open('process', r)}>处理</Button>
          )}
          {r.status === 'PROCESSED' && (
            <Button size="small" onClick={() => open('archive', r)}>归档</Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="违章用水管理"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => open('create')}>
            稽查登记
          </Button>
        </Space>
      }
    >
      {focusId && (
        <FocusTaskBar
          focusId={focusId}
          summary={<span>该违章单已定位，请核实/处理/归档</span>}
          showAll={focusList.showAll}
          onToggleAll={focusList.toggleAll}
          onClose={clearFocus}
        />
      )}
      {!focusList.focusing && taskGroup.tabs}
      <Table<Violation> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={shownRows}
        pagination={focusList.focusing ? false : { pageSize: 20 }}
        rowClassName={(r) => (r.id === focusId ? FOCUS_ROW_CLASS : '')}
      />

      <Modal
        title={
          action === 'create'
            ? '稽查登记违章'
            : action === 'verify'
              ? '核实疑似违章'
              : action === 'process'
                ? '处理违章'
                : '违章归档（需佐证）'
        }
        open={action !== null}
        onOk={() => void submit()}
        onCancel={() => setAction(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {action === 'create' && (
            <>
              <Form.Item name="waterAccountId" label="用水户" rules={[{ required: true }]}>
                <WaterAccountSearchSelect />
              </Form.Item>
              <Form.Item name="violationType" label="违章类型" rules={[{ required: true }]}>
                <Select
                  options={Object.entries(VIOLATION_TYPE_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </Form.Item>
              <Form.Item name="occurredDate" label="发生日期">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="description" label="描述" rules={[{ required: true }]}>
                <Input.TextArea rows={2} />
              </Form.Item>
              <Form.Item name="photoRefs" label="现场照片引用（空格/逗号分隔）">
                <Input.TextArea rows={2} />
              </Form.Item>
            </>
          )}
          {action === 'verify' && (
            <>
              <Form.Item name="confirm" label="核实结论" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: true, label: '属实 → 转正式处理' },
                    { value: false, label: '误报 → 关闭' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="note" label="核实说明">
                <Input.TextArea rows={2} />
              </Form.Item>
            </>
          )}
          {action === 'process' && (
            <>
              <Form.Item name="penaltyAmount" label="罚款金额(元)">
                <InputNumber style={{ width: '100%' }} min={0} precision={2} />
              </Form.Item>
              <Form.Item name="backbillAmount" label="补缴水费(元)">
                <InputNumber style={{ width: '100%' }} min={0} precision={2} />
              </Form.Item>
              <Form.Item name="serviceOrderId" label="联动工单ID（停水/拆表，可选）">
                <Input placeholder="关联已建表务工单" />
              </Form.Item>
              <Form.Item name="note" label="处理说明" rules={[{ required: true }]}>
                <Input.TextArea rows={2} />
              </Form.Item>
            </>
          )}
          {action === 'archive' && (
            <>
              <Form.Item
                name="site"
                label="现场照片（佐证）"
                rules={[{ required: true, message: '归档须现场照片' }]}
              >
                <Input.TextArea rows={2} placeholder="photo-ref，空格分隔" />
              </Form.Item>
              <Form.Item
                name="penaltyDoc"
                label="处罚文书（佐证）"
                rules={[{ required: true, message: '归档须处罚文书' }]}
              >
                <Input.TextArea rows={2} placeholder="文书照片/扫描件引用" />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </Card>
  );
}
