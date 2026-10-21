import { PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { newIdemKey } from '../common';

interface Agreement {
  id: string;
  settleAccountId: string;
  cardNoMasked: string;
  cardLast4: string;
  bankCode: string;
  holderName: string | null;
  status: string;
  signDate: string | null;
}
interface Batch {
  id: string;
  period: string;
  totalCount: number;
  totalAmount: string;
  status: string;
  executedAt: string | null;
  createdAt: string;
}
interface Item {
  id: string;
  settleAccountId: string;
  amount: string;
  status: string;
  bankSerialNo: string | null;
  failReason: string | null;
  paymentId: string | null;
  settle: { settleNo: string; name: string | null } | null;
}

const BANK_LABEL: Record<string, string> = {
  ICBC: '工商银行',
  ABC: '农业银行',
  CCB: '建设银行',
  BOC: '中国银行',
  COMM: '交通银行',
};
const ITEM_LABEL: Record<string, string> = {
  PENDING: '待扣',
  SUCCESS: '成功',
  FAILED: '失败',
  SKIPPED: '跳过',
};
const ITEM_COLOR: Record<string, string> = {
  PENDING: 'gold',
  SUCCESS: 'green',
  FAILED: 'red',
  SKIPPED: 'default',
};

const yuan = (v: string | number) => `¥${(Number(v) / 100).toFixed(2)}`;

/** 20261021 整改 任务F：银行代扣（协议→月度批次→执行→PKMX/PKJG/DZMX）。 */
export default function BankDebit() {
  const { message } = AntdApp.useApp();
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(false);
  const [agModal, setAgModal] = useState(false);
  const [batchModal, setBatchModal] = useState(false);
  const [detail, setDetail] = useState<{ batch: Batch; items: Item[] } | null>(null);
  const [exportRows, setExportRows] = useState<{ kind: string; rows: Record<string, unknown>[] } | null>(null);
  const [agForm] = Form.useForm();
  const [batchForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([
        api.get<Agreement[]>('/bank-debit/agreements'),
        api.get<Batch[]>('/bank-debit/batches'),
      ]);
      setAgreements(a.data);
      setBatches(b.data);
    } catch (e) {
      message.error(apiErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const createAgreement = async () => {
    const v = await agForm.validateFields();
    try {
      await api.post('/bank-debit/agreements', v, {
        headers: { 'Idempotency-Key': newIdemKey() },
      });
      message.success('协议已签约');
      setAgModal(false);
      agForm.resetFields();
      void load();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const createBatch = async () => {
    const v = await batchForm.validateFields();
    try {
      const res = await api.post<Batch & { skipped: { reason: string }[] }>(
        '/bank-debit/batches',
        { period: v.period },
        { headers: { 'Idempotency-Key': newIdemKey() } },
      );
      message.success(
        `批次已生成：${res.data.totalCount} 户 / ${yuan(res.data.totalAmount)}` +
          (res.data.skipped?.length ? `，跳过 ${res.data.skipped.length} 户（防重复）` : ''),
      );
      setBatchModal(false);
      batchForm.resetFields();
      void load();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const execute = async (b: Batch) => {
    try {
      const res = await api.post<{ results: { status: string }[] }>(
        `/bank-debit/batches/${b.id}/execute`,
        {},
      );
      const c = res.data.results.reduce<Record<string, number>>((m, r) => {
        m[r.status] = (m[r.status] ?? 0) + 1;
        return m;
      }, {});
      message.success(
        `执行完成：成功 ${c.SUCCESS ?? 0} / 失败 ${c.FAILED ?? 0} / 跳过 ${c.SKIPPED ?? 0}`,
      );
      void load();
      if (detail) void openDetail(detail.batch);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const openDetail = async (b: Batch) => {
    try {
      const res = await api.get<Item[]>(`/bank-debit/batches/${b.id}/items`);
      setDetail({ batch: b, items: res.data });
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const openExport = async (kind: 'pkmx' | 'pkjg' | 'dzmx') => {
    if (!detail) return;
    try {
      const res = await api.get<Record<string, unknown>[]>(
        `/bank-debit/batches/${detail.batch.id}/${kind}`,
      );
      setExportRows({ kind: kind.toUpperCase(), rows: res.data });
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const agCols: ColumnsType<Agreement> = [
    { title: '结算户', dataIndex: 'settleAccountId', render: (v: string) => `${v.slice(0, 8)}…` },
    { title: '卡号(掩码)', dataIndex: 'cardNoMasked' },
    { title: '开户行', dataIndex: 'bankCode', render: (v: string) => BANK_LABEL[v] ?? v },
    { title: '户名', dataIndex: 'holderName', render: (v) => v ?? '—' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <Tag color={v === 'ACTIVE' ? 'green' : 'default'}>{v === 'ACTIVE' ? '有效' : '已解约'}</Tag>,
    },
    {
      title: '操作',
      width: 90,
      render: (_, r) =>
        r.status === 'ACTIVE' && (
          <Button
            size="small"
            danger
            onClick={async () => {
              try {
                await api.post(`/bank-debit/agreements/${r.id}/cancel`, {});
                message.success('已解约');
                void load();
              } catch (e) {
                message.error(apiErrorText(e));
              }
            }}
          >
            解约
          </Button>
        ),
    },
  ];

  const batchCols: ColumnsType<Batch> = [
    { title: '期间', dataIndex: 'period', width: 90 },
    { title: '户数', dataIndex: 'totalCount', width: 80 },
    { title: '金额', dataIndex: 'totalAmount', width: 110, render: (v: string) => yuan(v) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => (
        <Tag color={v === 'DONE' ? 'green' : v === 'EXECUTING' ? 'blue' : 'gold'}>
          {{ GENERATED: '已生成', EXECUTING: '执行中', DONE: '已完成' }[v] ?? v}
        </Tag>
      ),
    },
    { title: '执行时间', dataIndex: 'executedAt', render: (v) => v?.slice(0, 19).replace('T', ' ') ?? '—' },
    {
      title: '操作',
      width: 200,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" onClick={() => void openDetail(r)}>明细</Button>
          {r.status === 'GENERATED' && r.totalCount > 0 && (
            <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => void execute(r)}>
              执行
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const itemCols: ColumnsType<Item> = [
    { title: '结算户号', render: (_, r) => r.settle?.settleNo ?? r.settleAccountId.slice(0, 8) },
    { title: '金额', dataIndex: 'amount', render: (v: string) => yuan(v) },
    {
      title: '结果',
      dataIndex: 'status',
      width: 80,
      render: (v: string) => <Tag color={ITEM_COLOR[v]}>{ITEM_LABEL[v] ?? v}</Tag>,
    },
    { title: '银行流水', dataIndex: 'bankSerialNo', render: (v) => v ?? '—' },
    { title: '失败原因', dataIndex: 'failReason', render: (v) => v ?? '—' },
  ];

  return (
    <Card
      title="银行代扣"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading} />
          <Button onClick={() => setAgModal(true)}>签协议</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setBatchModal(true)}>
            生成代扣批次
          </Button>
        </Space>
      }
    >
      <Tabs
        items={[
          {
            key: 'batches',
            label: '代扣批次',
            children: (
              <Table<Batch> rowKey="id" size="small" columns={batchCols} dataSource={batches} pagination={false} />
            ),
          },
          {
            key: 'agreements',
            label: '代扣协议',
            children: (
              <Table<Agreement> rowKey="id" size="small" columns={agCols} dataSource={agreements} pagination={{ pageSize: 20 }} />
            ),
          },
        ]}
      />

      <Modal title="签约代扣协议" open={agModal} onOk={() => void createAgreement()} onCancel={() => setAgModal(false)} destroyOnHidden>
        <Form form={agForm} layout="vertical">
          <Form.Item name="settleAccountId" label="结算户ID" rules={[{ required: true }]}>
            <Input placeholder="结算户 UUID" />
          </Form.Item>
          <Form.Item name="cardNo" label="银行卡号" rules={[{ required: true }]}>
            <Input placeholder="16-19位卡号，仅存掩码" />
          </Form.Item>
          <Form.Item name="bankCode" label="开户行" rules={[{ required: true }]}>
            <Select options={Object.entries(BANK_LABEL).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item name="holderName" label="户名">
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="生成代扣批次" open={batchModal} onOk={() => void createBatch()} onCancel={() => setBatchModal(false)} destroyOnHidden>
        <Form form={batchForm} layout="vertical">
          <Form.Item
            name="period"
            label="期间(YYYYMM)"
            rules={[{ required: true, pattern: /^\d{6}$/, message: '6位数字' }]}
          >
            <Input placeholder="如 202610" />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={`批次明细 ${detail?.batch.period ?? ''}`}
        open={detail !== null}
        onClose={() => setDetail(null)}
        width={760}
        extra={
          <Space>
            <Button onClick={() => void openExport('pkmx')}>PKMX 扣款明细</Button>
            <Button onClick={() => void openExport('pkjg')}>PKJG 扣款结果</Button>
            <Button onClick={() => void openExport('dzmx')}>DZMX 对账明细</Button>
          </Space>
        }
      >
        <Table<Item> rowKey="id" size="small" columns={itemCols} dataSource={detail?.items ?? []} pagination={false} />
      </Drawer>

      <Modal
        title={exportRows ? `${exportRows.kind} 输出` : ''}
        open={exportRows !== null}
        onCancel={() => setExportRows(null)}
        footer={null}
        width={720}
      >
        <pre style={{ maxHeight: 480, overflow: 'auto', fontSize: 12 }}>
          {exportRows ? JSON.stringify(exportRows.rows, null, 2) : ''}
        </pre>
      </Modal>
    </Card>
  );
}
