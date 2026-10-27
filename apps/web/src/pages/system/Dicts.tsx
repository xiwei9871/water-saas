import { PlusOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Switch, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import Table from '../../components/PageTable';


interface DictCategory {
  code: string;
  name: string;
}

interface DictItem {
  id: string;
  category: string;
  code: string;
  name: string;
  seq: number;
  status: 'ACTIVE' | 'DISABLED';
  value?: object | null;
}

/** 这些类别的字典项携带 JSON value（任务权限映射/触发规则）。 */
const TASK_VALUE_CATEGORIES = new Set(['TASK_TYPE_PERM', 'TASK_RULE']);

/** G4 统一字典管理 —— 报表筛选类别与业务原因码的租户级配置。
 *  停用保留行（历史单据已引用），code 创建后不可改。 */
export default function Dicts() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const [categories, setCategories] = useState<DictCategory[]>([]);
  const [category, setCategory] = useState<string>('WRITEOFF_REASON');
  const [rows, setRows] = useState<DictItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [modal, setModal] = useState<{ open: boolean; editing?: DictItem }>({ open: false });
  const [form] = Form.useForm();
  const canWrite = hasPerm('iam:write');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<DictItem[]>('/iam/dicts', {
        params: { category, ...(showAll ? { all: '1' } : {}) },
      });
      setRows(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [category, showAll, message]);

  useEffect(() => {
    api
      .get<DictCategory[]>('/iam/dicts/categories')
      .then((res) => setCategories(res.data))
      .catch((err) => message.error(apiErrorText(err)));
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const v = await form.validateFields();
    let value: object | undefined;
    if (TASK_VALUE_CATEGORIES.has(category) && v.value !== undefined && `${v.value}`.trim() !== '') {
      try {
        value = JSON.parse(v.value);
      } catch {
        message.error('value 必须是合法 JSON');
        return;
      }
    }
    try {
      if (modal.editing) {
        await api.patch(`/iam/dicts/${modal.editing.id}`, {
          name: v.name,
          seq: v.seq ?? 0,
          ...(value !== undefined ? { value } : {}),
        });
        message.success('已更新');
      } else {
        await api.post('/iam/dicts', {
          category,
          code: v.code,
          name: v.name,
          seq: v.seq ?? 0,
          ...(value !== undefined ? { value } : {}),
        });
        message.success('已新增');
      }
      setModal({ open: false });
      form.resetFields();
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const toggle = async (r: DictItem) => {
    try {
      await api.patch(`/iam/dicts/${r.id}`, {
        status: r.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
      });
      message.success(r.status === 'ACTIVE' ? '已停用' : '已启用');
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const columns: ColumnsType<DictItem> = [
    { key: 'code', dataIndex: 'code', title: '编码', width: 200 },
    { key: 'name', dataIndex: 'name', title: '名称' },
    { key: 'seq', dataIndex: 'seq', title: '排序', width: 70 },
    {
      key: 'status',
      dataIndex: 'status',
      title: '状态',
      width: 90,
      render: (v: string) =>
        v === 'ACTIVE' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>,
    },
    ...(canWrite
      ? [
          {
            key: 'ops',
            title: '操作',
            width: 150,
            render: (_: unknown, r: DictItem) => (
              <Space>
                <Button
                  size="small"
                  onClick={() => {
                    setModal({ open: true, editing: r });
                    form.setFieldsValue({
                      code: r.code,
                      name: r.name,
                      seq: r.seq,
                      value: r.value != null ? JSON.stringify(r.value) : undefined,
                    });
                  }}
                >
                  编辑
                </Button>
                <Button size="small" onClick={() => void toggle(r)}>
                  {r.status === 'ACTIVE' ? '停用' : '启用'}
                </Button>
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card title="字典管理">
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          value={category}
          onChange={setCategory}
          options={categories.map((c) => ({ value: c.code, label: c.name }))}
          style={{ width: 180 }}
        />
        <span>
          显示已停用
          <Switch checked={showAll} onChange={setShowAll} style={{ marginLeft: 8 }} />
        </span>
        {canWrite && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setModal({ open: true });
              form.resetFields();
            }}
          >
            新增字典项
          </Button>
        )}
      </Space>
      <Table<DictItem> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
      />
      <Modal
        title={modal.editing ? '编辑字典项' : '新增字典项'}
        open={modal.open}
        onOk={() => void save()}
        onCancel={() => setModal({ open: false })}
        destroyOnClose={false}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="code"
            label="编码（大写字母/数字/下划线，创建后不可改）"
            rules={[
              { required: true, message: '必填' },
              { pattern: /^[A-Z][A-Z0-9_]{0,39}$/, message: '大写字母开头，仅 A-Z 0-9 _' },
            ]}
          >
            <Input disabled={!!modal.editing} placeholder="如 UNREACHABLE" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="如 无法联系客户" />
          </Form.Item>
          <Form.Item name="seq" label="排序">
            <InputNumber min={0} style={{ width: 120 }} />
          </Form.Item>
          {TASK_VALUE_CATEGORIES.has(category) && (
            <Form.Item
              name="value"
              label="规则值（JSON）"
              rules={[{ required: true, message: '必填' }]}
              extra={
                category === 'TASK_TYPE_PERM'
                  ? '如 {"perm":"billing:write","dueDays":3,"priority":"HIGH"}'
                  : '如 {"amountThreshold":100000,"overdueDays":30}'
              }
            >
              <Input.TextArea rows={3} style={{ fontFamily: 'monospace' }} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  );
}
