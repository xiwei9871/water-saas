import {
  CarryOutOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  CashierDayClose,
  CashierDayCloseDetail,
  DayClosePayment,
  PayChannel,
  Staff,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { fmtCent, fmtDate, fmtTime } from '../common';
import { StaffSelect } from '../pickers';
import { PAY_CHANNEL_COLORS, PAY_CHANNEL_LABELS, PAYMENT_STATUS_COLORS, PAYMENT_STATUS_LABELS } from './common';

interface CloseFormValues {
  closeDate: dayjs.Dayjs;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 收费员日结（CashierDayClose）：把收款员 ≤ 日结日的全部 RECEIVED
 * 收款扫入一张 POSTED 日结单。日结本身自幂等（重复 → DAY_CLOSE_EXISTS /
 * 空 → DAY_CLOSE_EMPTY），不带 Idempotency-Key。
 */
export default function DayClose() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('payment:write');
  const canIamRead = hasPerm('iam:read');

  const [rows, setRows] = useState<CashierDayClose[]>([]);
  const [loading, setLoading] = useState(false);
  const [closeDate, setCloseDate] = useState<dayjs.Dayjs | null>(null);
  const [cashierId, setCashierId] = useState<string | undefined>(undefined);
  const [cashierIdInput, setCashierIdInput] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [staff, setStaff] = useState<Staff[]>([]);

  const [detail, setDetail] = useState<CashierDayCloseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [closeOpen, setCloseOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closeForm] = Form.useForm<CloseFormValues>();

  const effectiveCashierId = canIamRead
    ? cashierId
    : UUID_RE.test(cashierIdInput.trim())
      ? cashierIdInput.trim()
      : undefined;

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<CashierDayClose[]>('/cashier-day-close', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(closeDate ? { closeDate: closeDate.format('YYYY-MM-DD') } : {}),
            ...(effectiveCashierId ? { cashierId: effectiveCashierId } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [closeDate, effectiveCashierId, message],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  useEffect(() => {
    if (!canIamRead) return;
    api
      .get<Staff[]>('/iam/staff')
      .then((res) => setStaff(res.data))
      .catch(() => setStaff([]));
  }, [canIamRead]);

  const staffName = useCallback(
    (id: string) => {
      const s = staff.find((x) => x.id === id);
      return s ? `${s.name}（${s.login}）` : `${id.slice(0, 8)}…`;
    },
    [staff],
  );

  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const detailSeq = useRef(0);

  const openDetail = async (row: CashierDayClose) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api.get<CashierDayCloseDetail>(`/cashier-day-close/${row.id}`);
      if (seq === detailSeq.current) setDetail(res.data);
    } catch (err) {
      if (seq === detailSeq.current) message.error(apiErrorText(err));
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  };

  /** 执行日结：closeDate 默认今天；服务端自幂等 —— 不带幂等键。 */
  const submitClose = async () => {
    let values: CloseFormValues;
    try {
      values = await closeForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<CashierDayCloseDetail>('/cashier-day-close/close', {
        closeDate: values.closeDate.format('YYYY-MM-DD'),
      });
      message.success(
        `日结完成：${fmtDate(res.data.closeDate)} 共 ${res.data.totalCount} 笔、${fmtCent(res.data.totalAmount)}`,
      );
      setCloseOpen(false);
      await load(page, pageSize);
    } catch (err) {
      // DAY_CLOSE_EXISTS / DAY_CLOSE_EMPTY 直接透出。
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const channelBuckets = (b: CashierDayClose['byChannel']) =>
    (['CASH', 'POS', 'TRANSFER'] as const).map((c) => {
      const bucket = b?.[c];
      return (
        <Tag key={c} color={PAY_CHANNEL_COLORS[c]}>
          {PAY_CHANNEL_LABELS[c]} {bucket ? `${bucket.count}笔 ${fmtCent(bucket.amount)}` : '0笔'}
        </Tag>
      );
    });

  const columns: ColumnsType<CashierDayClose> = [
    {
      title: '日结日期',
      dataIndex: 'closeDate',
      key: 'closeDate',
      width: 110,
      render: fmtDate,
    },
    {
      title: '收费员',
      dataIndex: 'cashierId',
      key: 'cashierId',
      width: 150,
      render: staffName,
    },
    {
      title: '笔数',
      dataIndex: 'totalCount',
      key: 'totalCount',
      width: 80,
      align: 'right',
    },
    {
      title: '合计金额',
      dataIndex: 'totalAmount',
      key: 'totalAmount',
      width: 120,
      align: 'right',
      render: fmtCent,
    },
    {
      title: '渠道明细',
      key: 'byChannel',
      render: (_: unknown, r: CashierDayClose) => (
        <Space size={4} wrap>
          {channelBuckets(r.byChannel)}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: () => <Tag color="green">已日结</Tag>,
    },
    {
      title: '日结时间',
      dataIndex: 'closedAt',
      key: 'closedAt',
      width: 165,
      render: fmtTime,
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_: unknown, record: CashierDayClose) => (
        <Button size="small" icon={<SearchOutlined />} onClick={() => void openDetail(record)}>
          详情
        </Button>
      ),
    },
  ];

  const paymentColumns: ColumnsType<DayClosePayment> = [
    { title: '收款单号', dataIndex: 'paymentNo', key: 'paymentNo', width: 160 },
    {
      title: '渠道',
      dataIndex: 'channel',
      key: 'channel',
      width: 100,
      render: (c: PayChannel) => (
        <Tag color={PAY_CHANNEL_COLORS[c]}>{PAY_CHANNEL_LABELS[c]}</Tag>
      ),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      width: 110,
      align: 'right',
      render: (v: string, r: DayClosePayment) => (
        <span style={r.reversalOfId ? { color: '#cf1322' } : undefined}>
          {fmtCent(v)}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (s: DayClosePayment['status'], r: DayClosePayment) => (
        <Space size={4}>
          <Tag color={PAYMENT_STATUS_COLORS[s]}>{PAYMENT_STATUS_LABELS[s]}</Tag>
          {r.reversalOfId && <Tag color="red">红冲</Tag>}
        </Space>
      ),
    },
    {
      title: '收款时间',
      dataIndex: 'receivedAt',
      key: 'receivedAt',
      width: 165,
      render: fmtTime,
    },
  ];

  return (
    <Card
      title="收费员日结"
      extra={
        <Space wrap>
          <DatePicker
            allowClear
            placeholder="日结日期"
            value={closeDate}
            onChange={(v) => {
              setCloseDate(v);
              setPage(1);
            }}
          />
          {canIamRead ? (
            <span style={{ width: 190, display: 'inline-block' }}>
              <StaffSelect
                value={cashierId}
                onChange={(v) => {
                  setCashierId(v);
                  setPage(1);
                }}
                placeholder="按收费员过滤"
              />
            </span>
          ) : (
            <Input.Search
              allowClear
              placeholder="按收费员 ID 过滤"
              style={{ width: 220 }}
              value={cashierIdInput}
              onChange={(e) => setCashierIdInput(e.target.value)}
              onSearch={() => setPage(1)}
            />
          )}
          <Button icon={<ReloadOutlined />} onClick={() => void load(page, pageSize)}>
            刷新
          </Button>
          {canWrite && (
            <Button
              type="primary"
              icon={<CarryOutOutlined />}
              onClick={() => {
                closeForm.resetFields();
                closeForm.setFieldsValue({ closeDate: dayjs() });
                setCloseOpen(true);
              }}
            >
              执行日结
            </Button>
          )}
        </Space>
      }
    >
      <Table<CashierDayClose>
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          onChange: (p, size) => {
            setPage(p);
            setPageSize(size);
          },
        }}
      />

      {/* 执行日结 */}
      <Modal
        open={closeOpen}
        title="执行日结"
        okText="日结"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitClose()}
        onCancel={() => setCloseOpen(false)}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="将把当前用户在日结日（含）之前收款的全部未日结收款扫入一张日结单。日结单签发后不可更改；红冲收款以负额行计入下一次日结。"
        />
        <Form form={closeForm} layout="vertical">
          <Form.Item
            name="closeDate"
            label="日结日期"
            rules={[{ required: true, message: '请选择日结日期' }]}
            extra="默认今天；同一收费员同一日期只能日结一次"
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 日结详情抽屉 */}
      <Drawer
        open={detail !== null || detailLoading}
        width={720}
        title={
          detail ? `日结详情 — ${fmtDate(detail.closeDate)} ${staffName(detail.cashierId)}` : '日结详情'
        }
        onClose={() => setDetail(null)}
      >
        {detailLoading || !detail ? (
          <Spin />
        ) : (
          <>
            <Descriptions
              bordered
              size="small"
              column={2}
              items={[
                { key: 'date', label: '日结日期', children: fmtDate(detail.closeDate) },
                { key: 'cashier', label: '收费员', children: staffName(detail.cashierId) },
                { key: 'count', label: '笔数', children: detail.totalCount },
                {
                  key: 'amount',
                  label: '合计金额',
                  children: <b>{fmtCent(detail.totalAmount)}</b>,
                },
                {
                  key: 'status',
                  label: '状态',
                  children: <Tag color="green">已日结</Tag>,
                },
                { key: 'closedAt', label: '日结时间', children: fmtTime(detail.closedAt) },
              ]}
            />
            <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>渠道汇总</div>
            <Space size={4} wrap>
              {channelBuckets(detail.byChannel)}
            </Space>
            <div style={{ margin: '16px 0 8px', fontWeight: 600 }}>
              扫入收款（{detail.payments.length} 笔）
            </div>
            <Table<DayClosePayment>
              rowKey="id"
              size="small"
              columns={paymentColumns}
              dataSource={detail.payments}
              pagination={false}
              scroll={{ y: 320 }}
            />
          </>
        )}
      </Drawer>
    </Card>
  );
}
