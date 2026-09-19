import { EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type { TenantParam } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';

interface ParamFormValues {
  key: string;
  value: string;
}

const fmtTime = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm:ss');

const pretty = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

/** 租户参数：key/value 列表 + JSON 编辑（PUT 为 upsert，可新增 key）。 */
export default function TenantParams() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('iam:write');

  const [rows, setRows] = useState<TenantParam[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; param: TenantParam } | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ParamFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<TenantParam[]>('/iam/tenant-params');
      setRows(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    // Defer to a microtask — setState must not run synchronously in effects.
    queueMicrotask(() => void load());
  }, [load]);

  const openCreate = () => {
    form.setFieldsValue({ key: '', value: '' });
    setModal({ mode: 'create' });
  };
  const openEdit = (param: TenantParam) => {
    form.setFieldsValue({ key: param.key, value: pretty(param.value) });
    setModal({ mode: 'edit', param });
  };

  const submit = async () => {
    let values: ParamFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // inline field errors are already shown
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.value);
    } catch {
      message.error('参数值不是合法的 JSON，请检查后重试');
      return;
    }
    // `value Json` is a required column — a literal null 500s server-side.
    if (parsed === null) {
      message.error('参数值不支持 null，请改用 0、false 或 {}');
      return;
    }
    setSaving(true);
    try {
      await api.put(`/iam/tenant-params/${encodeURIComponent(values.key)}`, {
        value: parsed,
      });
      message.success('参数已保存');
      setModal(null);
      await load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<TenantParam> = [
    { title: '参数键', dataIndex: 'key', key: 'key', width: 280 },
    {
      title: '参数值（JSON）',
      dataIndex: 'value',
      key: 'value',
      render: (v: unknown) => (
        <Typography.Text code copyable={{ text: JSON.stringify(v) }}>
          {JSON.stringify(v)}
        </Typography.Text>
      ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 170,
      render: fmtTime,
    },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 100,
            render: (_: unknown, record: TenantParam) => (
              <Button
                size="small"
                icon={<EditOutlined />}
                onClick={() => openEdit(record)}
              >
                编辑
              </Button>
            ),
          } satisfies ColumnsType<TenantParam>[number],
        ]
      : []),
  ];

  return (
    <Card
      title="租户参数"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增参数
            </Button>
          )}
        </Space>
      }
    >
      <Table<TenantParam>
        rowKey="key"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
      />

      <Modal
        open={modal !== null}
        title={modal?.mode === 'create' ? '新增参数' : `编辑参数 — ${modal?.param.key}`}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="key"
            label="参数键"
            rules={[{ required: true, message: '请输入参数键' }]}
          >
            <Input
              disabled={modal?.mode === 'edit'}
              placeholder="如 max_consecutive_estimates"
            />
          </Form.Item>
          <Form.Item
            name="value"
            label="参数值（JSON）"
            rules={[
              { required: true, message: '请输入参数值' },
              {
                validator: (_, v: string) => {
                  try {
                    if (JSON.parse(v) === null) {
                      return Promise.reject(new Error('不支持 null 值'));
                    }
                    return Promise.resolve();
                  } catch {
                    return Promise.reject(new Error('不是合法的 JSON'));
                  }
                },
              },
            ]}
            extra='合法 JSON：数字 3、字符串 "ABC"、布尔 true、对象 {"a":1}、数组 [1,2]'
          >
            <Input.TextArea rows={6} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
