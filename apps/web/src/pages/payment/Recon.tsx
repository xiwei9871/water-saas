import Select from '../../components/CopySelect';
import { UploadOutlined } from '@ant-design/icons';
import {App as AntdApp, Button, Card, Drawer, Form, Input, Space, Tag, Typography, Upload} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState, useRef } from 'react';
import { api, apiErrorText } from '../../api/client';
import { fmtCent } from '../common';
import {
  FOCUS_ROW_CLASS,
  FocusTaskBar,
  useFocusList,
  useFocusParams,
  useTaskGroup,
} from '../../components/TaskFocus';
import Table from '../../components/PageTable';


interface ReconBatch {
  id: string;
  channel: string;
  fileName: string | null;
  bizDateFrom: string | null;
  bizDateTo: string | null;
  totalRows: number;
  matched: number;
  mismatched: number;
  missingInFile: number;
  taskId: string | null;
  createdAt: string;
}

interface ReconRow {
  id: string;
  rowNo: number;
  channelRef: string;
  amount: string;
  paidAt: string | null;
  matchStatus: 'MATCHED' | 'AMOUNT_MISMATCH' | 'NOT_FOUND' | 'STATUS_MISMATCH';
  paymentId: string | null;
  note: string | null;
}

const CHANNEL_LABELS: Record<string, string> = {
  CASH: '现金', POS: 'POS', TRANSFER: '转账', ONLINE: '线上缴费', BANK_DEDUCT: '银行代扣',
};
const MATCH_LABELS: Record<ReconRow['matchStatus'], string> = {
  MATCHED: '已对上', AMOUNT_MISMATCH: '金额不符', NOT_FOUND: '我方无此单', STATUS_MISMATCH: '状态不符',
};
const MATCH_COLORS: Record<ReconRow['matchStatus'], string> = {
  MATCHED: 'green', AMOUNT_MISMATCH: 'orange', NOT_FOUND: 'red', STATUS_MISMATCH: 'volcano',
};

/** G3 渠道对账：上传通道对账单（CSV）逐笔核账，差异自动挂处理任务。
 *  真实通道接入前用「生成模拟对账单」走通流程。 */
export default function Recon() {
  const { message } = AntdApp.useApp();
  const [batches, setBatches] = useState<ReconBatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<(ReconBatch & { rows: ReconRow[] }) | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<ReconBatch[]>('/payments/recon');
      setBatches(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => void load(), [load]);

  const upload = async (v: { channel: string; fileName?: string; content: string }) => {
    try {
      const res = await api.post<{ batch: ReconBatch }>('/payments/recon', v);
      const b = res.data.batch;
      message.success(`对账完成：共 ${b.totalRows} 笔，匹配 ${b.matched}，差异 ${b.mismatched}，缺单 ${b.missingInFile}`);
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const mockStatement = async () => {
    try {
      const ch = form.getFieldValue('channel') as string | undefined;
      const res = await api.get<{ content: string; channel: string; rows: number }>('/payments/recon/mock-statement', {
        params: { channel: ch ?? 'ONLINE' },
      });
      form.setFieldsValue({ content: res.data.content, channel: res.data.channel });
      message.success(`已生成模拟对账单（${res.data.rows} 笔），可直接提交核账`);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const { focusId, clear: clearFocus } = useFocusParams();
  const focusDone = useRef<string | null>(null);
  // A3 任务三态分组：对账任务挂在批次上。
  const taskGroup = useTaskGroup<ReconBatch>('RECON_BATCH', batches, (r) => r.id);
  const focusList = useFocusList<ReconBatch>(
    focusId,
    taskGroup.filtered,
    focusId ? (r) => r.id === focusId : null,
  );
  const shownBatches = focusList.shown;

  const openDetail = async (id: string) => {
    try {
      const res = await api.get<ReconBatch & { rows: ReconRow[] }>(`/payments/recon/${id}`);
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  // 任务直达 ?focusId= → 自动打开该批次明细。
  useEffect(() => {
    if (focusId && focusDone.current !== focusId) {
      focusDone.current = focusId;
      void openDetail(focusId);
    }
  }, [focusId]);

  const batchCols: ColumnsType<ReconBatch> = [
    { title: '渠道', dataIndex: 'channel', render: (c: string) => CHANNEL_LABELS[c] ?? c },
    { title: '文件', dataIndex: 'fileName', render: (v: string | null) => v ?? '—' },
    { title: '总笔数', dataIndex: 'totalRows', width: 80 },
    { title: '匹配', dataIndex: 'matched', width: 80 },
    { title: '差异', dataIndex: 'mismatched', width: 80, render: (v: number) => (v ? <Typography.Text type="danger">{v}</Typography.Text> : 0) },
    { title: '缺单', dataIndex: 'missingInFile', width: 80, render: (v: number) => (v ? <Typography.Text type="warning">{v}</Typography.Text> : 0) },
    { title: '对账时间', dataIndex: 'createdAt', render: (v: string) => v.slice(0, 19).replace('T', ' ') },
    { title: '', render: (_, r) => <Button size="small" onClick={() => void openDetail(r.id)}>明细</Button> },
  ];

  const rowCols: ColumnsType<ReconRow> = [
    { title: '行号', dataIndex: 'rowNo', width: 60 },
    { title: '收款单号', dataIndex: 'channelRef' },
    { title: '金额', dataIndex: 'amount', render: (v: string) => fmtCent(v) },
    { title: '支付时间', dataIndex: 'paidAt', render: (v: string | null) => (v ? v.slice(0, 19).replace('T', ' ') : '—') },
    { title: '核对', dataIndex: 'matchStatus', render: (s: ReconRow['matchStatus']) => <Tag color={MATCH_COLORS[s]}>{MATCH_LABELS[s]}</Tag> },
    { title: '备注', dataIndex: 'note', render: (v: string | null) => v ?? '—' },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Card title="渠道对账" size="small">
        <Form form={form} onFinish={(v) => void upload(v)} initialValues={{ channel: 'BANK_DEDUCT' }}>
          <Space wrap>
            <Form.Item name="channel" label="渠道" rules={[{ required: true }]} style={{ marginBottom: 8 }}>
              <Select style={{ width: 140 }} options={Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ value, label }))} />
            </Form.Item>
            <Form.Item name="fileName" label="文件名" style={{ marginBottom: 8 }}>
              <Input style={{ width: 200 }} placeholder="可选" />
            </Form.Item>
            <Form.Item style={{ marginBottom: 8 }}>
              <Upload
                accept=".csv,.txt"
                showUploadList={false}
                beforeUpload={(f) => {
                  void f.text().then((t) => form.setFieldsValue({ content: t, fileName: f.name }));
                  return false;
                }}
              >
                <Button icon={<UploadOutlined />}>选择对账文件</Button>
              </Upload>
            </Form.Item>
            <Form.Item style={{ marginBottom: 8 }}>
              <Button onClick={() => void mockStatement()}>生成模拟对账单</Button>
            </Form.Item>
            <Form.Item style={{ marginBottom: 8 }}>
              <Button type="primary" htmlType="submit">核账</Button>
            </Form.Item>
          </Space>
          <Form.Item name="content" style={{ marginBottom: 0 }} rules={[{ required: true, message: '请粘贴或上传对账 CSV' }]}>
            <Input.TextArea rows={5} placeholder={'CSV 内容：收款单号,金额(元),支付时间\n支持上传文件或直接粘贴'} />
          </Form.Item>
        </Form>
      </Card>
      <Card title="对账批次" size="small">
        {focusId && (
          <FocusTaskBar
            focusId={focusId}
            summary={<span>该对账批次已定位并打开明细</span>}
            showAll={focusList.showAll}
            onToggleAll={focusList.toggleAll}
            onOpenDetail={() => void openDetail(focusId)}
            onClose={clearFocus}
          />
        )}
        {!focusList.focusing && taskGroup.tabs}
        <Table scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }} rowKey="id" size="small" columns={batchCols} dataSource={shownBatches} loading={loading} pagination={false} rowClassName={(r) => (r.id === focusId ? FOCUS_ROW_CLASS : '')} />
      </Card>
      <Drawer title={`对账明细（${detail?.fileName ?? detail?.channel ?? ''}）`} open={!!detail} onClose={() => setDetail(null)} width={820}>
        {detail && <Table scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }} rowKey="id" size="small" columns={rowCols} dataSource={detail.rows} pagination={false} />}
      </Drawer>
    </Space>
  );
}
