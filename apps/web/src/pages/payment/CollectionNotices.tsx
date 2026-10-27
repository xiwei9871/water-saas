import { PrinterOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Input,
  InputNumber,
  Modal,
  Space,
  Table,
  Tabs,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { fmtCent, fmtPeriod } from '../common';
import { WaterAccountSearchSelect } from '../pickers';
import {
  FocusTaskBar,
  FOCUS_ROW_CLASS,
  useFocusList,
  useFocusParams,
  useTaskGroup,
} from '../../components/TaskFocus';

interface NoticeBill {
  period: string;
  total: string;
  due: string;
}

interface ArrearRow {
  waterAccountId: string;
  accountNo: string;
  customerName: string;
  customerNo: string;
  phone: string | null;
  addr: string;
  amountDue: string;
  billCount: number;
  oldestPeriod: string;
  overdueDays: number;
}

interface Notice {
  id: string;
  noticeNo: string;
  waterAccountId: string;
  waterAccountLabel: string | null;
  settleAccountId: string | null;
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
  const { focusId, clear: clearFocus } = useFocusParams();
  const [rows, setRows] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(false);
  const [accountId, setAccountId] = useState<string>();
  const [printing, setPrinting] = useState<Notice | null>(null);
  const printRef = useRef<HTMLDivElement>(null);
  // 待催缴户清单
  const [arrears, setArrears] = useState<ArrearRow[]>([]);
  const [arrearsLoading, setArrearsLoading] = useState(false);
  const [minAmount, setMinAmount] = useState<number | null>(null);
  const [minDays, setMinDays] = useState<number | null>(null);
  const [arrearsQ, setArrearsQ] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [batching, setBatching] = useState(false);
  // A3 任务三态分组：按通知单 id（后端经 context.noticeId 回联催缴任务）。
  const taskGroup = useTaskGroup<Notice>('collectionNotice', rows, (r) => r.id);
  // A2「只显示该条」：?focusId=（=结算户 id）→ 只看该结算户的催缴单。
  const focusList = useFocusList<Notice>(
    focusId,
    taskGroup.filtered,
    focusId ? (r) => r.settleAccountId === focusId || r.id === focusId : null,
  );
  const shownRows = focusList.shown;

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

  const loadArrears = useCallback(async () => {
    setArrearsLoading(true);
    try {
      const res = await api.get<{ total: number; items: ArrearRow[] }>(
        '/payments/collection-notices/arrears',
        {
          params: {
            ...(minAmount ? { minAmount } : {}),
            ...(minDays ? { minOverdueDays: minDays } : {}),
            ...(arrearsQ.trim() ? { q: arrearsQ.trim() } : {}),
          },
        },
      );
      setArrears(res.data.items);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setArrearsLoading(false);
    }
  }, [arrearsQ, message, minAmount, minDays]);
  useEffect(() => void loadArrears(), [loadArrears]);

  const batchCreate = async () => {
    if (!selected.length) {
      message.warning('请先勾选要催缴的户');
      return;
    }
    setBatching(true);
    try {
      const res = await api.post<{ created: number; results: { ok: boolean; error?: string }[] }>(
        '/payments/collection-notices/batch',
        { waterAccountIds: selected },
      );
      const failed = res.data.results.filter((r) => !r.ok).length;
      message.success(`已生成 ${res.data.created} 份催缴通知单${failed ? `，${failed} 户失败` : ''}`);
      setSelected([]);
      void load();
      void loadArrears();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setBatching(false);
    }
  };

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

  const arrearsCols: ColumnsType<ArrearRow> = [
    { title: '户号', dataIndex: 'accountNo', width: 130 },
    { title: '户名', dataIndex: 'customerName', width: 150 },
    { title: '联系电话', dataIndex: 'phone', width: 130, render: (v) => v ?? '—' },
    { title: '用水地址', dataIndex: 'addr', ellipsis: true },
    { title: '欠费金额', dataIndex: 'amountDue', width: 120, render: fmtCent, sorter: (a, b) => Number(BigInt(a.amountDue) - BigInt(b.amountDue)), defaultSortOrder: 'descend' },
    { title: '欠费笔数', dataIndex: 'billCount', width: 90 },
    { title: '最早账期', dataIndex: 'oldestPeriod', width: 100, render: fmtPeriod },
    { title: '最大逾期(天)', dataIndex: 'overdueDays', width: 110, sorter: (a, b) => a.overdueDays - b.overdueDays },
    {
      title: '',
      width: 110,
      render: (_, r) => (
        <Button
          size="small"
          onClick={async () => {
            try {
              await api.post('/payments/collection-notices', { waterAccountId: r.waterAccountId });
              message.success('已生成催缴通知单并挂催缴任务');
              void load();
              void loadArrears();
            } catch (err) {
              message.error(apiErrorText(err));
            }
          }}
        >
          生成通知单
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Card size="small" bodyStyle={{ paddingTop: 8 }}>
        <Tabs
          defaultActiveKey="arrears"
          items={[
            {
              key: 'arrears',
              label: '待催缴户清单',
              children: (
                <>
                  <Space style={{ marginBottom: 12 }} wrap>
                    <InputNumber
                      placeholder="欠费金额下限(元)"
                      min={0}
                      value={minAmount}
                      onChange={(v) => setMinAmount(v)}
                      style={{ width: 150 }}
                    />
                    <InputNumber
                      placeholder="逾期天数≥"
                      min={0}
                      value={minDays}
                      onChange={(v) => setMinDays(v)}
                      style={{ width: 110 }}
                    />
                    <Input.Search
                      placeholder="户号/户名/地址"
                      allowClear
                      style={{ width: 220 }}
                      onSearch={(v) => setArrearsQ(v)}
                    />
                    <Button icon={<ReloadOutlined />} onClick={() => void loadArrears()} />
                    <Button
                      type="primary"
                      disabled={!selected.length}
                      loading={batching}
                      onClick={() => void batchCreate()}
                    >
                      批量生成通知单{selected.length ? `（已选 ${selected.length}）` : ''}
                    </Button>
                  </Space>
                  <Table scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
                    rowKey="waterAccountId"
                    size="small"
                    columns={arrearsCols}
                    dataSource={arrears}
                    loading={arrearsLoading}
                    rowSelection={{
                      selectedRowKeys: selected,
                      onChange: (keys) => setSelected(keys as string[]),
                    }}
                    pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 户欠费` }}
                  />
                </>
              ),
            },
            {
              key: 'notices',
              label: '催缴通知单',
              children: (
                <>
                  <Space style={{ marginBottom: 12 }}>
                    <WaterAccountSearchSelect
                      value={accountId}
                      onChange={setAccountId}
                      placeholder="搜索户号/户名/地址"
                    />
                    <Button type="primary" onClick={() => void create()}>
                      生成通知单
                    </Button>
                  </Space>
                  {focusId && (
                    <FocusTaskBar
                      focusId={focusId}
                      summary={<span>该结算户的催缴单（若尚无通知单请先生成）</span>}
                      showAll={focusList.showAll}
                      onToggleAll={focusList.toggleAll}
                      onClose={clearFocus}
                    />
                  )}
                  {!focusList.focusing && taskGroup.tabs}
                  <Table scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }} rowKey="id" size="small" columns={cols} rowClassName={(r) => (r.settleAccountId === focusId || r.id === focusId ? FOCUS_ROW_CLASS : '')} dataSource={shownRows} loading={loading} pagination={false} />
                </>
              ),
            },
          ]}
        />
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
              <Table scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
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
