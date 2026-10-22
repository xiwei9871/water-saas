import { PlusOutlined, UndoOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { fmtCent, fmtDate } from '../common';
import { BillingAccountSelect, SettleAccountLookupSelect } from '../pickers';
import { useSearchParams } from 'react-router-dom';

interface DictItem {
  id: string;
  code: string;
  name: string;
}

interface Writeoff {
  id: string;
  settleAccountId: string;
  settleNo: string | null;
  settleName: string | null;
  waterAccountId: string | null;
  accountNo: string | null;
  billId: string | null;
  amount: string;
  reasonCode: string;
  note: string | null;
  status: 'ACTIVE' | 'REVERSED';
  effectiveDate: string;
}

/** G2 坏账核销登记（轻量版）：登记 + 原因字典 + 留痕；不做账务冲销，
 *  应收数据原样保留，报表层（年报/欠费清单）标注扣减。 */
export default function Writeoffs() {
  const [focusParams] = useSearchParams();
  const focusId = focusParams.get('focusId');
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const [rows, setRows] = useState<Writeoff[]>([]);
  const [reasons, setReasons] = useState<DictItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [modal, setModal] = useState(false);
  const [form] = Form.useForm();
  const canWrite = hasPerm('payment:write');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<Writeoff[]>('/writeoffs', {
        params: status ? { status } : {},
      });
      setRows(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [status, message]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<DictItem[]>('/iam/dicts', { params: { category: 'WRITEOFF_REASON' } })
      .then((res) => setReasons(res.data))
      .catch(() => setReasons([]));
  }, []);

  const save = async () => {
    const v = await form.validateFields();
    try {
      await api.post('/writeoffs', {
        settleAccountId: v.settleAccountId,
        ...(v.waterAccountId ? { waterAccountId: v.waterAccountId } : {}),
        amount: Math.round(Number(v.amount) * 100),
        reasonCode: v.reasonCode,
        ...(v.note ? { note: v.note } : {}),
        effectiveDate: v.effectiveDate.format('YYYY-MM-DD'),
      });
      message.success('核销已登记');
      setModal(false);
      form.resetFields();
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const reverse = async (r: Writeoff) => {
    try {
      await api.post(`/writeoffs/${r.id}/reverse`);
      message.success('已撤销核销');
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const reasonName = (code: string) =>
    reasons.find((r) => r.code === code)?.name ?? code;

  const columns: ColumnsType<Writeoff> = [
    { key: 'settleNo', dataIndex: 'settleNo', title: '结算户号' },
    { key: 'settleName', dataIndex: 'settleName', title: '户名' },
    { key: 'accountNo', dataIndex: 'accountNo', title: '用水户号', render: (v) => v ?? '—' },
    {
      key: 'amount',
      dataIndex: 'amount',
      title: '核销额(元)',
      align: 'right',
      render: (v) => fmtCent(v),
    },
    {
      key: 'reasonCode',
      dataIndex: 'reasonCode',
      title: '核销原因',
      render: reasonName,
    },
    { key: 'effectiveDate', dataIndex: 'effectiveDate', title: '生效日期', render: fmtDate },
    { key: 'note', dataIndex: 'note', title: '备注', ellipsis: true },
    {
      key: 'status',
      dataIndex: 'status',
      title: '状态',
      width: 90,
      render: (v: string) =>
        v === 'ACTIVE' ? <Tag color="orange">已核销</Tag> : <Tag>已撤销</Tag>,
    },
    ...(canWrite
      ? [
          {
            key: 'ops',
            title: '操作',
            width: 90,
            render: (_: unknown, r: Writeoff) =>
              r.status === 'ACTIVE' ? (
                <Popconfirm title="确认撤销该笔核销？" onConfirm={() => void reverse(r)}>
                  <Button size="small" icon={<UndoOutlined />}>
                    撤销
                  </Button>
                </Popconfirm>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <>
      <Card title="坏账核销">
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          value={status}
          onChange={setStatus}
          placeholder="状态"
          style={{ width: 120 }}
          options={[
            { value: 'ACTIVE', label: '已核销' },
            { value: 'REVERSED', label: '已撤销' },
          ]}
        />
        {canWrite && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              if (reasons.length === 0) {
                message.warning('请先在「系统管理 → 字典管理」配置 WRITEOFF_REASON 核销原因');
                return;
              }
              form.resetFields();
              form.setFieldsValue({ effectiveDate: dayjs() });
              setModal(true);
            }}
          >
            登记核销
          </Button>
        )}
      </Space>
      {/* 任务直达 ?focusId= 行级高亮 */}
      <Table<Writeoff>
        size="small"
        rowKey="id"
        rowClassName={(r: Writeoff) => (r.id === focusId ? 'ant-table-row-selected' : '')}
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{ pageSize: 50 }}
      />
      <Modal
        title="登记坏账核销"
        open={modal}
        onOk={() => void save()}
        onCancel={() => setModal(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="settleAccountId"
            label="结算户"
            rules={[{ required: true, message: '必选' }]}
          >
            <SettleAccountLookupSelect />
          </Form.Item>
          <Form.Item name="waterAccountId" label="关联用水户（可选）">
            <BillingAccountSelect includeClosed />
          </Form.Item>
          <Form.Item
            name="amount"
            label="核销金额(元)"
            rules={[{ required: true, message: '必填' }]}
          >
            <InputNumber min={0.01} precision={2} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item
            name="reasonCode"
            label="核销原因"
            rules={[{ required: true, message: '必选' }]}
          >
            <Select options={reasons.map((r) => ({ value: r.code, label: r.name }))} />
          </Form.Item>
          <Form.Item
            name="effectiveDate"
            label="生效日期"
            rules={[{ required: true, message: '必选' }]}
          >
            <DatePicker />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
    </>
  );
}
