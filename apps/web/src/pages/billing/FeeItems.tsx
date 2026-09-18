import {
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type { CalcType, FeeItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { cleanBody, fmtTime, newIdemKey } from '../common';
import { CALC_TYPE_LABELS } from './common';

interface CreateFormValues {
  code: string;
  name: string;
  calcType: CalcType;
}

type ModalState =
  | { kind: 'create' }
  | { kind: 'edit'; item: FeeItem }
  | null;

/**
 * 费用项（FeeItem）：计费引用的计价行类型（水费/污水费/违约金…）。
 * code/calcType 一经创建不可改（账单明细按语义引用），编辑仅限名称。
 */
export default function FeeItems() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('billing:write');

  const [rows, setRows] = useState<FeeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [code, setCode] = useState('');
  const [calcType, setCalcType] = useState<CalcType | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [modal, setModal] = useState<ModalState>(null);
  const [idemKey, setIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<CreateFormValues>();

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<FeeItem[]>('/fee-items', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(code.trim() ? { code: code.trim() } : {}),
            ...(calcType ? { calcType } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [calcType, code, message],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const openCreate = () => {
    form.resetFields();
    setIdemKey(newIdemKey());
    setModal({ kind: 'create' });
  };

  const openEdit = (item: FeeItem) => {
    form.resetFields();
    form.setFieldsValue({ code: item.code, name: item.name, calcType: item.calcType });
    setModal({ kind: 'edit', item });
  };

  const submit = async () => {
    let values: CreateFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (modal?.kind === 'create') {
        await api.post(
          '/fee-items',
          cleanBody({
            code: values.code,
            name: values.name,
            calcType: values.calcType,
          }),
          { headers: { 'Idempotency-Key': idemKey } },
        );
        message.success('费用项已创建');
      } else if (modal?.kind === 'edit') {
        await api.patch(`/fee-items/${modal.item.id}`, {
          name: values.name.trim(),
        });
        message.success('费用项已更新');
      }
      setModal(null);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<FeeItem> = [
    { title: '编码', dataIndex: 'code', key: 'code', width: 160 },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '计费方式',
      dataIndex: 'calcType',
      key: 'calcType',
      width: 120,
      render: (t: CalcType) => <Tag color="blue">{CALC_TYPE_LABELS[t]}</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 165,
      render: fmtTime,
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_: unknown, record: FeeItem) =>
        canWrite ? (
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
        ) : null,
    },
  ];

  return (
    <Card
      title="费用项"
      extra={
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="按编码过滤（精确）"
            style={{ width: 200 }}
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            onSearch={(v) => {
              setCode(v);
              setPage(1);
            }}
          />
          <Select
            allowClear
            placeholder="计费方式"
            style={{ width: 130 }}
            options={(['PER_QTY', 'FIXED', 'PERCENT'] as const).map((t) => ({
              value: t,
              label: CALC_TYPE_LABELS[t],
            }))}
            value={calcType}
            onChange={(v) => {
              setCalcType(v);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(page, pageSize)}>
            刷新
          </Button>
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建费用项
            </Button>
          )}
        </Space>
      }
    >
      <Table<FeeItem>
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
        title={
          modal?.kind === 'create'
            ? '新建费用项'
            : modal?.kind === 'edit'
              ? `编辑费用项 — ${modal.item.name}`
              : ''
        }
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="code"
            label="编码"
            rules={[{ required: true, message: '请输入编码' }]}
            extra={modal?.kind === 'edit' ? '编码为身份字段，不可修改' : '租户内唯一，如 WATER / SEWAGE'}
          >
            <Input disabled={modal?.kind === 'edit'} placeholder="如 WATER" />
          </Form.Item>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="如 水费" />
          </Form.Item>
          <Form.Item
            name="calcType"
            label="计费方式"
            rules={[{ required: true, message: '请选择计费方式' }]}
            extra={modal?.kind === 'edit' ? '计费方式为身份字段，不可修改' : undefined}
          >
            <Select
              disabled={modal?.kind === 'edit'}
              options={(['PER_QTY', 'FIXED', 'PERCENT'] as const).map((t) => ({
                value: t,
                label: CALC_TYPE_LABELS[t],
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
