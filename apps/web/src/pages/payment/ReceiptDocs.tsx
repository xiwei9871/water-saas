import { PlusOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { fmtCent } from '../common';
import { StaffSelect, WaterAccountSearchSelect } from '../pickers';

interface ReceiptBook {
  id: string;
  bookNo: string;
  prefix: string;
  rangeStart: number;
  rangeEnd: number;
  nextNo: number;
  status: 'STOCK' | 'ISSUED' | 'EXHAUSTED' | 'RETIRED';
  issuedTo: string | null;
  issuedToName: string | null;
  issuedAt: string | null;
}

interface Invoice {
  id: string;
  invoiceNo: string;
  waterAccountId: string | null;
  paymentId: string | null;
  billId: string | null;
  amount: string;
  status: 'ISSUED' | 'VOID';
  remark: string | null;
  createdAt: string;
}

const BOOK_LABELS: Record<ReceiptBook['status'], string> = {
  STOCK: '在库', ISSUED: '已领用', EXHAUSTED: '已用完', RETIRED: '已作废',
};
const BOOK_COLORS: Record<ReceiptBook['status'], string> = {
  STOCK: 'default', ISSUED: 'processing', EXHAUSTED: 'success', RETIRED: 'error',
};

/** G5 票据台账：收据号段（登记/领用/作废，收款自动占用）+ 发票登记（不接税控）。 */
export default function ReceiptDocs() {
  const { message } = AntdApp.useApp();
  const [books, setBooks] = useState<ReceiptBook[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [bookModal, setBookModal] = useState(false);
  const [issueFor, setIssueFor] = useState<ReceiptBook | null>(null);
  const [invoiceModal, setInvoiceModal] = useState(false);
  const [bookForm] = Form.useForm();
  const [issueForm] = Form.useForm();
  const [invForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const [b, i] = await Promise.all([
        api.get<ReceiptBook[]>('/payments/receipt-books'),
        api.get<Invoice[]>('/payments/invoices'),
      ]);
      setBooks(b.data);
      setInvoices(i.data);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  }, [message]);
  useEffect(() => void load(), [load]);

  const submitBook = async () => {
    const v = await bookForm.validateFields();
    try {
      await api.post('/payments/receipt-books', v);
      message.success('号段已登记');
      setBookModal(false);
      bookForm.resetFields();
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const submitIssue = async () => {
    const v = await issueForm.validateFields();
    try {
      await api.put(`/payments/receipt-books/${issueFor!.id}/issue`, { staffId: v.staffId });
      message.success('已领用');
      setIssueFor(null);
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const retire = async (id: string) => {
    try {
      await api.put(`/payments/receipt-books/${id}/retire`);
      message.success('已作废');
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const submitInvoice = async () => {
    const v = await invForm.validateFields();
    try {
      await api.post('/payments/invoices', {
        invoiceNo: v.invoiceNo,
        waterAccountId: v.waterAccountId,
        amount: Math.round(Number(v.amountYuan) * 100),
        remark: v.remark,
      });
      message.success('发票已登记');
      setInvoiceModal(false);
      invForm.resetFields();
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const voidInvoice = async (id: string) => {
    try {
      await api.put(`/payments/invoices/${id}/void`);
      message.success('已作废');
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const bookCols: ColumnsType<ReceiptBook> = [
    { title: '本号', dataIndex: 'bookNo', width: 120 },
    { title: '票号前缀', dataIndex: 'prefix', width: 90 },
    { title: '号段', render: (_, r) => `${r.rangeStart} ~ ${r.rangeEnd}`, width: 140 },
    { title: '下一号', dataIndex: 'nextNo', width: 80 },
    { title: '状态', dataIndex: 'status', width: 90, render: (s: ReceiptBook['status']) => <Tag color={BOOK_COLORS[s]}>{BOOK_LABELS[s]}</Tag> },
    { title: '领用人', dataIndex: 'issuedToName', render: (v: string | null) => v ?? '—' },
    {
      title: '操作',
      render: (_, r) => (
        <Space size={4}>
          {r.status === 'STOCK' && <Button size="small" onClick={() => setIssueFor(r)}>领用</Button>}
          {(r.status === 'STOCK' || r.status === 'ISSUED') && (
            <Popconfirm title="确认作废该号段？" onConfirm={() => void retire(r.id)}>
              <Button size="small" danger>作废</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const invCols: ColumnsType<Invoice> = [
    { title: '发票号', dataIndex: 'invoiceNo', width: 140 },
    { title: '金额', dataIndex: 'amount', render: (v: string) => fmtCent(v), width: 110 },
    { title: '状态', dataIndex: 'status', width: 80, render: (s: Invoice['status']) => <Tag color={s === 'ISSUED' ? 'green' : 'default'}>{s === 'ISSUED' ? '已开具' : '已作废'}</Tag> },
    { title: '备注', dataIndex: 'remark', render: (v: string | null) => v ?? '—' },
    { title: '登记时间', dataIndex: 'createdAt', render: (v: string) => v.slice(0, 19).replace('T', ' ') },
    {
      title: '操作',
      render: (_, r) =>
        r.status === 'ISSUED' && (
          <Popconfirm title="作废该发票登记？" onConfirm={() => void voidInvoice(r.id)}>
            <Button size="small" danger>作废</Button>
          </Popconfirm>
        ),
    },
  ];

  return (
    <Card title="票据台账" size="small">
      <Tabs
        items={[
          {
            key: 'books',
            label: '收据号段',
            children: (
              <>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setBookModal(true)} style={{ marginBottom: 8 }}>
                  登记号段
                </Button>
                <Table rowKey="id" size="small" columns={bookCols} dataSource={books} pagination={false} />
              </>
            ),
          },
          {
            key: 'invoices',
            label: '发票登记',
            children: (
              <>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setInvoiceModal(true)} style={{ marginBottom: 8 }}>
                  登记发票
                </Button>
                <Table rowKey="id" size="small" columns={invCols} dataSource={invoices} pagination={false} />
              </>
            ),
          },
        ]}
      />

      <Modal title="登记收据号段" open={bookModal} onOk={() => void submitBook()} onCancel={() => setBookModal(false)} destroyOnHidden>
        <Form form={bookForm} layout="vertical" initialValues={{ prefix: 'S' }}>
          <Form.Item name="bookNo" label="票据本号" rules={[{ required: true }]}>
            <Input placeholder="如 票据本-001" />
          </Form.Item>
          <Form.Item name="prefix" label="票号前缀" rules={[{ required: true }]}>
            <Input maxLength={10} />
          </Form.Item>
          <Space>
            <Form.Item name="rangeStart" label="起始号" rules={[{ required: true }]}>
              <InputNumber min={1} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="rangeEnd" label="截止号" rules={[{ required: true }]}>
              <InputNumber min={1} style={{ width: 160 }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal title={`领用号段 ${issueFor?.bookNo ?? ''}`} open={!!issueFor} onOk={() => void submitIssue()} onCancel={() => setIssueFor(null)} destroyOnHidden>
        <Form form={issueForm} layout="vertical">
          <Form.Item name="staffId" label="领用收费员（缺省为本人）">
            <StaffSelect placeholder="缺省为本人" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="登记发票" open={invoiceModal} onOk={() => void submitInvoice()} onCancel={() => setInvoiceModal(false)} destroyOnHidden>
        <Form form={invForm} layout="vertical">
          <Form.Item name="invoiceNo" label="发票号" rules={[{ required: true }]}>
            <Input maxLength={30} />
          </Form.Item>
          <Form.Item name="waterAccountId" label="关联用水户（可选）">
            <WaterAccountSearchSelect placeholder="搜索户号/户名" />
          </Form.Item>
          <Form.Item name="amountYuan" label="金额（元）" rules={[{ required: true }]}>
            <InputNumber min={0} precision={2} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
