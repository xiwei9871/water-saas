import {
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiErrorText } from '../../api/client';
import type { Customer, CustomerDetail, WaterAccountRef } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  CUST_TYPE_LABELS,
  cleanBody,
  cleanPatch,
  fmtTime,
  newIdemKey,
} from './common';
import { AccountStatusTag } from './pickers';

interface CustomerFormValues {
  customerNo?: string;
  name: string;
  custType: Customer['custType'];
  idType?: string;
  idNo?: string;
  phone?: string;
  addr?: string;
}

/** 客户列表：名称/编号搜索 + take/skip 分页 + 新建/编辑 + 详情抽屉（名下水表户）。 */
export default function Customers() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('customer:write');

  const [rows, setRows] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  // Typing only updates the input — the filter applies on 搜索/回车.
  const [nameInput, setNameInput] = useState('');
  const [name, setName] = useState('');
  const [noInput, setNoInput] = useState('');
  const [customerNo, setCustomerNo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; customer: Customer } | null
  >(null);
  // One Idempotency-Key per form-open — a retried submit reuses it.
  const [idemKey, setIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<CustomerFormValues>();

  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<Customer[]>('/customers', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(customerNo.trim() ? { customerNo: customerNo.trim() } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [customerNo, message, name],
  );

  useEffect(() => {
    // Defer to a microtask — setState must not run synchronously in effects.
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  // The endpoint returns a page, not a total — allow "next page" exactly
  // when the current page came back full.
  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const openCreate = () => {
    form.resetFields();
    setIdemKey(newIdemKey());
    setModal({ mode: 'create' });
  };
  const openEdit = (customer: Customer) => {
    form.setFieldsValue({
      name: customer.name,
      custType: customer.custType,
      idType: customer.idType ?? undefined,
      idNo: customer.idNo ?? undefined,
      phone: customer.phone ?? undefined,
      addr: customer.addr ?? undefined,
    });
    setModal({ mode: 'edit', customer });
  };

  const submit = async () => {
    let values: CustomerFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // inline field errors are already shown
    }
    setSaving(true);
    try {
      if (modal?.mode === 'create') {
        await api.post(
          '/customers',
          cleanBody({ ...values }),
          { headers: { 'Idempotency-Key': idemKey } },
        );
        message.success('客户已创建');
      } else if (modal?.mode === 'edit') {
        // customerNo 不可变 —— PATCH 只提交资料字段。
        await api.patch(
          `/customers/${modal.customer.id}`,
          cleanPatch({
            name: values.name,
            custType: values.custType,
            idType: values.idType,
            idNo: values.idNo,
            phone: values.phone,
            addr: values.addr,
          }),
        );
        message.success('客户已更新');
      }
      setModal(null);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (customer: Customer) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api.get<CustomerDetail>(`/customers/${customer.id}`);
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const columns: ColumnsType<Customer> = [
    { title: '客户编号', dataIndex: 'customerNo', key: 'customerNo', width: 150 },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '类型',
      dataIndex: 'custType',
      key: 'custType',
      width: 80,
      render: (t: Customer['custType']) => (
        <Tag color={t === 'ORG' ? 'blue' : 'default'}>
          {CUST_TYPE_LABELS[t]}
        </Tag>
      ),
    },
    {
      title: '电话',
      dataIndex: 'phone',
      key: 'phone',
      width: 140,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '地址',
      dataIndex: 'addr',
      key: 'addr',
      ellipsis: true,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: fmtTime,
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: unknown, record: Customer) => (
        <Space size="small">
          <Button size="small" onClick={() => void openDetail(record)}>
            详情
          </Button>
          {canWrite && (
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEdit(record)}
            >
              编辑
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const accountColumns: ColumnsType<WaterAccountRef> = [
    {
      title: '户号',
      dataIndex: 'accountNo',
      key: 'accountNo',
      render: (no: string) => (
        <Link to={`/customer/water-accounts?accountNo=${encodeURIComponent(no)}`}>{no}</Link>
      ),
    },
    { title: '用水类别', dataIndex: 'usageCategory', key: 'usageCategory' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: WaterAccountRef['status']) => (
        <AccountStatusTag status={s} />
      ),
    },
  ];

  return (
    <Card
      title="客户列表"
      extra={
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="按名称搜索"
            style={{ width: 180 }}
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onSearch={(v) => {
              setName(v);
              setPage(1);
            }}
          />
          <Input.Search
            allowClear
            placeholder="按客户编号精确查询"
            style={{ width: 180 }}
            value={noInput}
            onChange={(e) => setNoInput(e.target.value)}
            onSearch={(v) => {
              setCustomerNo(v);
              setPage(1);
            }}
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void load(page, pageSize)}
          >
            刷新
          </Button>
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增客户
            </Button>
          )}
        </Space>
      }
    >
      <Table<Customer>
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

      <Modal
        open={modal !== null}
        title={modal?.mode === 'create' ? '新增客户' : '编辑客户'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {modal?.mode === 'create' && (
            <Form.Item
              name="customerNo"
              label="客户编号"
              extra="留空则由系统自动生成"
            >
              <Input placeholder="如 C202501000001" />
            </Form.Item>
          )}
          <Form.Item
            name="name"
            label="客户名称"
            rules={[{ required: true, message: '请输入客户名称' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="custType"
            label="客户类型"
            rules={[{ required: true, message: '请选择客户类型' }]}
          >
            <Select
              options={(['PERSONAL', 'ORG'] as const).map((t) => ({
                value: t,
                label: CUST_TYPE_LABELS[t],
              }))}
            />
          </Form.Item>
          <Form.Item name="idType" label="证件类型">
            <Input placeholder="如 身份证 / 统一社会信用代码" />
          </Form.Item>
          <Form.Item name="idNo" label="证件号码">
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="联系电话">
            <Input />
          </Form.Item>
          <Form.Item name="addr" label="联系地址">
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={detail !== null || detailLoading}
        width={560}
        title={detail ? `客户详情 — ${detail.name}` : '客户详情'}
        onClose={() => setDetail(null)}
      >
        {detailLoading || !detail ? (
          <Spin />
        ) : (
          <>
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                { key: 'no', label: '客户编号', children: detail.customerNo },
                { key: 'name', label: '名称', children: detail.name },
                {
                  key: 'type',
                  label: '类型',
                  children: CUST_TYPE_LABELS[detail.custType],
                },
                {
                  key: 'id',
                  label: '证件',
                  children:
                    detail.idType || detail.idNo
                      ? `${detail.idType ?? ''} ${detail.idNo ?? ''}`.trim()
                      : '—',
                },
                { key: 'phone', label: '电话', children: detail.phone ?? '—' },
                { key: 'addr', label: '地址', children: detail.addr ?? '—' },
                {
                  key: 'created',
                  label: '创建时间',
                  children: fmtTime(detail.createdAt),
                },
              ]}
            />
            <Space
              style={{ margin: '16px 0 8px', justifyContent: 'space-between', width: '100%' }}
            >
              <span style={{ fontWeight: 600 }}>名下水表户</span>
              <Link to={`/customer/water-accounts?customerId=${detail.id}`}>
                查看全部
              </Link>
            </Space>
            <Table<WaterAccountRef>
              rowKey="id"
              size="small"
              columns={accountColumns}
              dataSource={detail.waterAccounts}
              pagination={false}
            />
          </>
        )}
      </Drawer>
    </Card>
  );
}
