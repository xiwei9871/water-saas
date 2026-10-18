import { PlusOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { CustomerSelect, ReadingBookSelect, MeterSelect } from '../pickers';
import { fmtDate, USAGE_CATEGORY_OPTIONS } from '../common';

type ApplyStatus = 'SUBMITTED' | 'SURVEYED' | 'APPROVED' | 'INSTALLING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';

interface Apply {
  id: string;
  applyNo: string;
  applicantName: string;
  custType: string;
  contactPhone: string | null;
  addr: string;
  usageCategory: string;
  caliberReq: string | null;
  remark: string | null;
  status: ApplyStatus;
  surveyNote: string | null;
  installNote: string | null;
  rejectReason: string | null;
  waterAccountId: string | null;
  waterAccountNo?: string | null;
  createdAt: string;
}

const STATUS_LABELS: Record<ApplyStatus, string> = {
  SUBMITTED: '已提交', SURVEYED: '已勘察', APPROVED: '已审批',
  INSTALLING: '装表中', COMPLETED: '已归档', REJECTED: '已驳回', CANCELLED: '已取消',
};
const STATUS_COLORS: Record<ApplyStatus, string> = {
  SUBMITTED: 'processing', SURVEYED: 'cyan', APPROVED: 'geekblue',
  INSTALLING: 'gold', COMPLETED: 'green', REJECTED: 'red', CANCELLED: 'default',
};
const NEXT_ACTIONS: Partial<Record<ApplyStatus, { to: ApplyStatus; label: string; noteField?: 'survey' | 'install' }[]>> = {
  SUBMITTED: [
    { to: 'SURVEYED', label: '勘察完成', noteField: 'survey' },
    { to: 'REJECTED', label: '驳回' },
  ],
  SURVEYED: [
    { to: 'APPROVED', label: '审批通过' },
    { to: 'REJECTED', label: '驳回' },
  ],
  APPROVED: [
    { to: 'INSTALLING', label: '开始装表', noteField: 'install' },
    { to: 'REJECTED', label: '驳回' },
  ],
  INSTALLING: [{ to: 'CANCELLED', label: '取消' }],
};

/** S1 报装管理（独立域）：申请→勘察→审批→装表→归档立户。 */
export default function InstallApplications() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const [rows, setRows] = useState<Apply[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<Apply | null>(null);
  const [noteFor, setNoteFor] = useState<{ app: Apply; to: ApplyStatus; label: string; noteField?: string } | null>(null);
  const [archiveFor, setArchiveFor] = useState<Apply | null>(null);
  const [form] = Form.useForm();
  const [noteForm] = Form.useForm();
  const [archForm] = Form.useForm();
  const canWrite = hasPerm('install:write');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<Apply[]>('/install/applications', {
        params: status ? { status } : {},
      });
      setRows(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [message, status]);
  useEffect(() => void load(), [load]);

  const create = async () => {
    const v = await form.validateFields();
    try {
      await api.post('/install/applications', v);
      message.success('申请已提交，审批任务已生成');
      setCreateOpen(false);
      form.resetFields();
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const transition = async () => {
    const note = noteForm.getFieldValue('note') as string | undefined;
    try {
      await api.post(`/install/applications/${noteFor!.app.id}/transition`, { to: noteFor!.to, note });
      message.success(`已流转至「${STATUS_LABELS[noteFor!.to]}」`);
      setNoteFor(null);
      noteForm.resetFields();
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const archive = async () => {
    const v = await archForm.validateFields();
    const app = archiveFor!;
    try {
      await api.post(`/install/applications/${app.id}/archive`, {
        customerId: v.customerId || undefined,
        customer: v.customerId
          ? undefined
          : { name: app.applicantName, custType: app.custType, phone: app.contactPhone, addr: app.addr },
        account: {
          usageCategory: app.usageCategory,
          addr: app.addr,
        },
        meterId: v.meterId || undefined,
        meter: v.meterId ? undefined : { caliber: app.caliberReq || 'DN15', brand: '报装新表' },
        installation: {
          initialReading: v.initialReading,
          reason: 'NEW',
        },
      });
      message.success('已归档立户');
      setArchiveFor(null);
      archForm.resetFields();
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const cols: ColumnsType<Apply> = [
    { title: '申请号', dataIndex: 'applyNo', width: 150 },
    { title: '申请人', dataIndex: 'applicantName', width: 120 },
    { title: '联系电话', dataIndex: 'contactPhone', width: 120, render: (v: string | null) => v ?? '—' },
    { title: '用水性质', dataIndex: 'usageCategory', width: 100, render: (v: string) => USAGE_CATEGORY_OPTIONS.find((c) => c.value === v)?.label ?? v },
    { title: '地址', dataIndex: 'addr', ellipsis: true },
    { title: '申请口径', dataIndex: 'caliberReq', width: 90, render: (v: string | null) => v ?? '—' },
    { title: '状态', dataIndex: 'status', width: 90, render: (s: ApplyStatus) => <Tag color={STATUS_COLORS[s]}>{STATUS_LABELS[s]}</Tag> },
    { title: '申请时间', dataIndex: 'createdAt', width: 160, render: (v: string) => fmtDate(v.slice(0, 10)) },
    {
      title: '操作',
      width: 220,
      render: (_, r) => (
        <Space size={4} wrap>
          <Button size="small" onClick={() => setDetail(r)}>详情</Button>
          {canWrite &&
            (NEXT_ACTIONS[r.status] ?? []).map((a) => (
              <Button key={a.to} size="small" danger={a.to === 'REJECTED' || a.to === 'CANCELLED'} onClick={() => setNoteFor({ app: r, ...a })}>
                {a.label}
              </Button>
            ))}
          {canWrite && (r.status === 'INSTALLING' || r.status === 'APPROVED') && (
            <Button size="small" type="primary" onClick={() => setArchiveFor(r)}>归档立户</Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="报装申请"
      size="small"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 130 }}
            onChange={setStatus}
            options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          />
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建申请</Button>
          )}
        </Space>
      }
    >
      <Table rowKey="id" size="small" columns={cols} dataSource={rows} loading={loading} pagination={false} />

      <Modal title="新建报装申请" open={createOpen} onOk={() => void create()} onCancel={() => setCreateOpen(false)} destroyOnHidden>
        <Form form={form} layout="vertical" initialValues={{ custType: 'PERSONAL', usageCategory: 'RES_METERED' }}>
          <Form.Item name="applicantName" label="申请人名称" rules={[{ required: true }]}>
            <Input maxLength={60} />
          </Form.Item>
          <Space>
            <Form.Item name="custType" label="客户类型" rules={[{ required: true }]}>
              <Select style={{ width: 140 }} options={[{ value: 'PERSONAL', label: '个人' }, { value: 'ORG', label: '单位' }]} />
            </Form.Item>
            <Form.Item name="contactPhone" label="联系电话">
              <Input maxLength={30} style={{ width: 180 }} />
            </Form.Item>
          </Space>
          <Form.Item name="addr" label="安装地址" rules={[{ required: true }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Space>
            <Form.Item name="usageCategory" label="用水性质" rules={[{ required: true }]}>
              <Select style={{ width: 160 }} options={USAGE_CATEGORY_OPTIONS} />
            </Form.Item>
            <Form.Item name="caliberReq" label="申请口径">
              <Select allowClear style={{ width: 140 }} options={['DN15', 'DN20', 'DN25', 'DN40', 'DN50', 'DN100'].map((v) => ({ value: v, label: v }))} />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={300} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={noteFor ? `${noteFor.label}：${noteFor.app.applyNo}` : ''}
        open={!!noteFor}
        onOk={() => void transition()}
        onCancel={() => setNoteFor(null)}
        destroyOnHidden
      >
        <Form form={noteForm} layout="vertical">
          <Form.Item name="note" label={noteFor?.to === 'REJECTED' ? '驳回原因' : '办理备注'} rules={noteFor?.to === 'REJECTED' ? [{ required: true }] : []}>
            <Input.TextArea rows={3} maxLength={300} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`归档立户：${archiveFor?.applyNo ?? ''}`}
        open={!!archiveFor}
        onOk={() => void archive()}
        onCancel={() => setArchiveFor(null)}
        width={560}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          将按立户向导创建 客户/结算户/用水户/表计安装。可关联既有客户，缺省则按申请信息新建。
        </Typography.Paragraph>
        <Form form={archForm} layout="vertical">
          <Form.Item name="customerId" label="关联既有客户（可选）">
            <CustomerSelect placeholder="不选则新建客户" />
          </Form.Item>
          <Form.Item name="bookId" label="抄表册（可选）">
            <ReadingBookSelect />
          </Form.Item>
          <Form.Item name="meterId" label="选用库存表（可选，不选则新建表号）">
            <MeterSelect status="AVAILABLE" />
          </Form.Item>
          <Form.Item name="initialReading" label="水表起始读数（m³）" rules={[{ required: true }]}>
            <InputNumber min={0} precision={2} style={{ width: 200 }} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title={`申请详情 ${detail?.applyNo ?? ''}`} open={!!detail} onClose={() => setDetail(null)} width={520}>
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="申请人">{detail.applicantName}</Descriptions.Item>
            <Descriptions.Item label="联系电话">{detail.contactPhone ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="地址">{detail.addr}</Descriptions.Item>
            <Descriptions.Item label="用水性质">{USAGE_CATEGORY_OPTIONS.find((c) => c.value === detail.usageCategory)?.label ?? detail.usageCategory}</Descriptions.Item>
            <Descriptions.Item label="状态"><Tag color={STATUS_COLORS[detail.status]}>{STATUS_LABELS[detail.status]}</Tag></Descriptions.Item>
            {detail.surveyNote && <Descriptions.Item label="勘察备注">{detail.surveyNote}</Descriptions.Item>}
            {detail.installNote && <Descriptions.Item label="装表备注">{detail.installNote}</Descriptions.Item>}
            {detail.rejectReason && <Descriptions.Item label="驳回原因">{detail.rejectReason}</Descriptions.Item>}
            {detail.waterAccountId && <Descriptions.Item label="已归档户号">{detail.waterAccountNo ?? detail.waterAccountId}</Descriptions.Item>}
            <Descriptions.Item label="备注">{detail.remark ?? '—'}</Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>
    </Card>
  );
}
