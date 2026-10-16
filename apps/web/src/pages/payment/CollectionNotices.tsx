import { PrinterOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Modal,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { fmtCent, fmtPeriod } from '../common';
import { WaterAccountSearchSelect } from '../pickers';

interface NoticeBill {
  period: string;
  total: string;
  due: string;
}

interface Notice {
  id: string;
  noticeNo: string;
  waterAccountId: string;
  waterAccountLabel: string | null;
  periodFrom: string;
  periodTo: string;
  amountDue: string;
  billCount: number;
  bills: NoticeBill[];
  printCount: number;
  lastPrintedAt: string | null;
  createdAt: string;
}

/** G4 催缴通知单：欠费户生成/打印/留痕，同时挂催缴任务。 */
export default function CollectionNotices() {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(false);
  const [accountId, setAccountId] = useState<string>();
  const [printing, setPrinting] = useState<Notice | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<Notice[]>('/payments/collection-notices');
      setRows(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => void load(), [load]);

  const create = async () => {
    if (!accountId) {
      message.warning('请选择用水户');
      return;
    }
    try {
      await api.post('/payments/collection-notices', { waterAccountId: accountId });
      message.success('已生成催缴通知单并挂催缴任务');
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const print = async (n: Notice) => {
    try {
      await api.post(`/payments/collection-notices/${n.id}/print`);
      setPrinting(n);
      setTimeout(() => {
        const node = printRef.current;
        if (node) {
          const w = window.open('', '_blank', 'width=720,height=560');
          if (w) {
            w.document.write(`<html><head><title>催缴通知单 ${n.noticeNo}</title><style>body{font-family:sans-serif;padding:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:6px 10px;text-align:left}</style></head><body>${node.innerHTML}</body></html>`);
            w.document.close();
            w.print();
          }
        }
        void load();
      }, 50);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const cols: ColumnsType<Notice> = [
    { title: '通知单号', dataIndex: 'noticeNo', width: 150 },
    { title: '用水户', dataIndex: 'waterAccountLabel', render: (v: string | null) => v ?? '—' },
    { title: '欠费账期', render: (_, r) => `${fmtPeriod(r.periodFrom)} ~ ${fmtPeriod(r.periodTo)}`, width: 170 },
    { title: '欠费笔数', dataIndex: 'billCount', width: 80 },
    { title: '欠费金额', dataIndex: 'amountDue', render: (v: string) => fmtCent(v), width: 110 },
    { title: '打印次数', dataIndex: 'printCount', width: 80 },
    {
      title: '最近打印',
      dataIndex: 'lastPrintedAt',
      width: 160,
      render: (v: string | null) => (v ? v.slice(0, 19).replace('T', ' ') : '—'),
    },
    { title: '出具时间', dataIndex: 'createdAt', render: (v: string) => v.slice(0, 19).replace('T', ' ') },
    { title: '', render: (_, r) => <Button size="small" icon={<PrinterOutlined />} onClick={() => void print(r)}>打印</Button> },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Card title="催缴通知单" size="small"
        extra={
          <Space>
            <WaterAccountSearchSelect value={accountId} onChange={setAccountId} placeholder="搜索户号/户名/地址" />
            <Button type="primary" onClick={() => void create()}>生成通知单</Button>
          </Space>
        }
      >
        <Table rowKey="id" size="small" columns={cols} dataSource={rows} loading={loading} pagination={false} />
      </Card>
      <Modal open={!!printing} onCancel={() => setPrinting(null)} footer={null} title="打印预览" width={640}>
        <div ref={printRef}>
          {printing && (
            <div>
              <Typography.Title level={4} style={{ textAlign: 'center' }}>水费催缴通知单</Typography.Title>
              <p>单号：{printing.noticeNo}</p>
              <p>用水户：{printing.waterAccountLabel ?? printing.waterAccountId}</p>
              <p>欠费账期：{fmtPeriod(printing.periodFrom)} 至 {fmtPeriod(printing.periodTo)}，共 {printing.billCount} 笔</p>
              <p>欠费金额：<b>{fmtCent(printing.amountDue)}</b></p>
              <Table
                rowKey="period"
                size="small"
                pagination={false}
                dataSource={printing.bills}
                columns={[
                  { title: '账期', dataIndex: 'period', render: fmtPeriod },
                  { title: '应收', dataIndex: 'total', render: fmtCent },
                  { title: '未付', dataIndex: 'due', render: fmtCent },
                ]}
              />
              <p style={{ marginTop: 16 }}>请于收到本通知后及时缴清水费，逾期将按规定计收违约金并可能影响供水服务。</p>
            </div>
          )}
        </div>
      </Modal>
    </Space>
  );
}
