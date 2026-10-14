import { TaskContextBanner } from '../../components/TaskContextBanner';
import { DownloadOutlined, SearchOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Form,
  InputNumber,
  Select,
  Space,
  Table,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { BILL_STATUS_LABELS } from '../billing/common';
import {
  ACCOUNT_STATUS_LABELS,
  enumLabel,
  fmtCent,
  fmtDate,
  fmtPeriod,
  USAGE_CATEGORY_LABELS,
  USAGE_CATEGORY_OPTIONS,
} from '../common';
import {
  BillingAccountSelect,
  OrgUnitTreeSelect,
  SettleAccountLookupSelect,
} from '../pickers';
import { PAY_CHANNEL_LABELS, PAYMENT_STATUS_LABELS } from '../payment/common';

export type QueryKind =
  | 'accounts'
  | 'usage-details'
  | 'bill-details'
  | 'payments'
  | 'arrears';

const TITLES: Record<QueryKind, string> = {
  accounts: '用户档案查询',
  'usage-details': '水量明细查询',
  'bill-details': '账单明细查询',
  payments: '收款流水查询',
  arrears: '欠费明细查询',
};

type Row = Record<string, unknown>;

const cents = (v: unknown) =>
  v === '' || v == null ? '' : fmtCent(v as string | number);

/**
 * A1–A5 查询导出（§四）。JSON 与 xlsx 同一份行数据（服务端单一查询
 * 路径），导出列即界面列——中文表头、无 UUID。行数服务端硬上限
 * EXPORT_ROW_CAP，超限提示收窄条件分批导出。
 */
export default function Queries({ kind }: { kind: QueryKind }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [queried, setQueried] = useState(false);

  const buildParams = (values: Record<string, unknown>) => {
    const p: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === null || v === '') continue;
      if (dayjs.isDayjs(v)) {
        const d = v as Dayjs;
        if (k === 'period') p[k] = d.format('YYYYMM');
        else p[k] = d.format('YYYY-MM-DD');
      } else if (k === 'minAmount') {
        p[k] = Math.round(Number(v) * 100); // 界面元 → 服务端分
      } else {
        p[k] = v;
      }
    }
    return p;
  };

  const runQuery = async () => {
    const params = buildParams(form.getFieldsValue());
    setLoading(true);
    try {
      const res = await api.get<Row[]>(`/reports/query/${kind}`, { params });
      setRows(res.data);
      setQueried(true);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  };

  const exportXlsx = async () => {
    const params = { ...buildParams(form.getFieldsValue()), format: 'xlsx' };
    setExporting(true);
    try {
      const res = await api.get(`/reports/query/${kind}`, {
        params,
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${TITLES[kind]}-${dayjs().format('YYYYMMDD')}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('导出完成');
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setExporting(false);
    }
  };

  const columns: ColumnsType<Row> = COLUMN_DEFS[kind];

  return (
    <>
      <TaskContextBanner />
      <Card title={TITLES[kind]}>
      <Form form={form} layout="inline" onFinish={runQuery} style={{ rowGap: 8 }}>
        {kind === 'accounts' && (
          <>
            <Form.Item name="usageCategory" label="用水类别">
              <Select
                allowClear
                options={USAGE_CATEGORY_OPTIONS}
                style={{ width: 140 }}
                placeholder="全部"
              />
            </Form.Item>
            <Form.Item name="status" label="状态">
              <Select
                allowClear
                style={{ width: 110 }}
                options={[
                  { value: 'NORMAL', label: '在册' },
                  { value: 'SUSPENDED', label: '暂停' },
                  { value: 'CLOSED', label: '销户' },
                ]}
                placeholder="全部"
              />
            </Form.Item>
            <Form.Item name="caliber" label="口径">
              <Select
                allowClear
                style={{ width: 110 }}
                options={['DN15', 'DN20', 'DN25', 'DN40', 'DN50'].map((v) => ({
                  value: v,
                  label: v,
                }))}
                placeholder="全部"
              />
            </Form.Item>
          </>
        )}
        {(kind === 'usage-details' || kind === 'bill-details') && (
          <Form.Item
            name="period"
            label="账期"
            rules={[{ required: true, message: '请选择账期' }]}
          >
            <DatePicker picker="month" />
          </Form.Item>
        )}
        {kind === 'payments' && (
          <>
            <Form.Item
              name="from"
              label="收款日期起"
              rules={[{ required: true, message: '必选' }]}
            >
              <DatePicker />
            </Form.Item>
            <Form.Item
              name="to"
              label="收款日期止"
              rules={[{ required: true, message: '必选' }]}
            >
              <DatePicker />
            </Form.Item>
            <Form.Item name="channel" label="渠道">
              <Select
                allowClear
                style={{ width: 120 }}
                options={Object.entries(PAY_CHANNEL_LABELS).map(([v, l]) => ({
                  value: v,
                  label: l,
                }))}
                placeholder="全部"
              />
            </Form.Item>
            <Form.Item name="settleAccountId" label="结算户">
              <SettleAccountLookupSelect />
            </Form.Item>
          </>
        )}
        {kind === 'arrears' && (
          <>
            <Form.Item
              name="asOf"
              label="截至日期"
              rules={[{ required: true, message: '必选' }]}
            >
              <DatePicker />
            </Form.Item>
            <Form.Item name="agingMin" label="账龄≥(月)">
              <InputNumber min={0} style={{ width: 90 }} />
            </Form.Item>
            <Form.Item name="agingMax" label="账龄≤(月)">
              <InputNumber min={0} style={{ width: 90 }} />
            </Form.Item>
            <Form.Item name="minAmount" label="欠费≥(元)">
              <InputNumber min={0} style={{ width: 110 }} />
            </Form.Item>
          </>
        )}
        {(kind === 'usage-details' ||
          kind === 'bill-details' ||
          kind === 'arrears') && (
          <Form.Item name="waterAccountId" label="用水户">
            <BillingAccountSelect includeClosed />
          </Form.Item>
        )}
        {kind !== 'payments' && (
          <Form.Item name="orgUnitId" label="所属片区">
            <OrgUnitTreeSelect />
          </Form.Item>
        )}
        {kind === 'usage-details' && (
          <Form.Item name="zeroStreak" label="连续零水量≥">
            <InputNumber min={2} style={{ width: 90 }} />
          </Form.Item>
        )}
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={loading}>
              查询
            </Button>
            <Button
              icon={<DownloadOutlined />}
              onClick={exportXlsx}
              loading={exporting}
              disabled={!queried}
            >
              导出 Excel
            </Button>
          </Space>
        </Form.Item>
      </Form>
      <Table<Row>
        style={{ marginTop: 16 }}
        size="small"
        rowKey={(_r, i) => String(i)}
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{ pageSize: 50, showTotal: (t) => `共 ${t} 行` }}
        locale={{
          emptyText: queried ? '当前条件下无数据' : '设置筛选条件后点「查询」',
        }}
        scroll={{ x: 'max-content' }}
      />
      </Card>
    </>
  );
}

const money = (k: string, title: string) => ({
  key: k,
  dataIndex: k,
  title,
  align: 'right' as const,
  render: cents,
});

const COLUMN_DEFS: Record<QueryKind, ColumnsType<Row>> = {
  accounts: [
    { key: 'accountNo', dataIndex: 'accountNo', title: '户号' },
    { key: 'customerName', dataIndex: 'customerName', title: '户名' },
    { key: 'addr', dataIndex: 'addr', title: '地址', ellipsis: true },
    {
      key: 'usageCategory',
      dataIndex: 'usageCategory',
      title: '用水类别',
      render: (v: string) => enumLabel(USAGE_CATEGORY_LABELS, v),
    },
    { key: 'meterNo', dataIndex: 'meterNo', title: '表号' },
    { key: 'caliber', dataIndex: 'caliber', title: '口径' },
    { key: 'baseReading', dataIndex: 'baseReading', title: '表底数', align: 'right' },
    { key: 'lastReading', dataIndex: 'lastReading', title: '最近读数', align: 'right' },
    {
      key: 'lastReadPeriod',
      dataIndex: 'lastReadPeriod',
      title: '读数账期',
      render: fmtPeriod,
    },
    { key: 'orgName', dataIndex: 'orgName', title: '所属片区' },
    { key: 'openedAt', dataIndex: 'openedAt', title: '立户日期', render: fmtDate },
    {
      key: 'status',
      dataIndex: 'status',
      title: '状态',
      render: (v: string) => enumLabel(ACCOUNT_STATUS_LABELS, v),
    },
  ],
  'usage-details': [
    { key: 'accountNo', dataIndex: 'accountNo', title: '户号' },
    { key: 'customerName', dataIndex: 'customerName', title: '户名' },
    { key: 'period', dataIndex: 'period', title: '账期', render: fmtPeriod },
    { key: 'prevReading', dataIndex: 'prevReading', title: '上期表底', align: 'right' },
    { key: 'endReading', dataIndex: 'endReading', title: '本期表底', align: 'right' },
    { key: 'usageQty', dataIndex: 'usageQty', title: '本期水量', align: 'right' },
    { key: 'ytdUsage', dataIndex: 'ytdUsage', title: '累计水量', align: 'right' },
    {
      key: 'isEstimated',
      dataIndex: 'isEstimated',
      title: '是否估抄',
      render: (v: boolean) => (v ? '估抄' : '实抄'),
    },
    { key: 'readSource', dataIndex: 'readSource', title: '抄表方式' },
    { key: 'readerName', dataIndex: 'readerName', title: '抄表员' },
    {
      key: 'usageCategory',
      dataIndex: 'usageCategory',
      title: '用水类别',
      render: (v: string) => enumLabel(USAGE_CATEGORY_LABELS, v),
    },
  ],
  'bill-details': [
    { key: 'accountNo', dataIndex: 'accountNo', title: '户号' },
    { key: 'customerName', dataIndex: 'customerName', title: '户名' },
    { key: 'period', dataIndex: 'period', title: '账期', render: fmtPeriod },
    { key: 'usageQty', dataIndex: 'usageQty', title: '水量', align: 'right' },
    { key: 'priceText', dataIndex: 'priceText', title: '单价构成', ellipsis: true },
    money('totalAmount', '应收(元)'),
    money('adjusted', '调整/减免(元)'),
    money('allocated', '实收(元)'),
    money('remaining', '欠费(元)'),
    {
      key: 'status',
      dataIndex: 'status',
      title: '状态',
      render: (v: string) => enumLabel(BILL_STATUS_LABELS, v),
    },
  ],
  payments: [
    { key: 'paymentNo', dataIndex: 'paymentNo', title: '流水号' },
    { key: 'settleNo', dataIndex: 'settleNo', title: '结算户号' },
    { key: 'settleName', dataIndex: 'settleName', title: '户名' },
    { key: 'accountNos', dataIndex: 'accountNos', title: '关联户号', ellipsis: true },
    {
      key: 'receivedAt',
      dataIndex: 'receivedAt',
      title: '缴费日期',
      render: (v: string) => String(v).slice(0, 16).replace('T', ' '),
    },
    {
      key: 'channel',
      dataIndex: 'channel',
      title: '渠道',
      render: (v: string) => enumLabel(PAY_CHANNEL_LABELS, v as keyof typeof PAY_CHANNEL_LABELS),
    },
    { key: 'cashierName', dataIndex: 'cashierName', title: '收费员' },
    money('amount', '金额(元)'),
    { key: 'allocPeriods', dataIndex: 'allocPeriods', title: '对应账期' },
    {
      key: 'status',
      dataIndex: 'status',
      title: '状态',
      render: (v: string) => enumLabel(PAYMENT_STATUS_LABELS, v),
    },
  ],
  arrears: [
    { key: 'settleNo', dataIndex: 'settleNo', title: '结算户号' },
    { key: 'settleName', dataIndex: 'settleName', title: '户名' },
    { key: 'accountNo', dataIndex: 'accountNo', title: '用水户号' },
    { key: 'customerName', dataIndex: 'customerName', title: '客户名' },
    money('arrearsAmount', '欠费金额(元)'),
    { key: 'agingMonths', dataIndex: 'agingMonths', title: '账龄(月)', align: 'right' },
    {
      key: 'oldestPeriod',
      dataIndex: 'oldestPeriod',
      title: '欠费起始账期',
      render: fmtPeriod,
    },
    { key: 'billCount', dataIndex: 'billCount', title: '欠费账单数', align: 'right' },
    money('writtenOff', '已核销(元)'),
    { key: 'phone', dataIndex: 'phone', title: '联系方式' },
  ],
};
