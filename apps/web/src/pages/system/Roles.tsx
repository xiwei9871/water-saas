import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Divider,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type { DataScope, Permission, Role } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';

const SCOPE_LABELS: Record<DataScope, string> = {
  ALL: '全部数据',
  ORG_SUBTREE: '本组织及下级',
  SELF: '仅本人',
};

interface RoleFormValues {
  code: string;
  name: string;
  dataScope: DataScope;
  permissionIds: string[];
}

/**
 * 角色权限：角色列表 + 权限编辑。
 * 角色/权限写接口服务端一律 admin-only（assertAdmin）——非 admin 时本页
 * 只读，所有编辑入口隐藏。
 */
export default function Roles() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const isAdmin = hasPerm('*');

  const [rows, setRows] = useState<Role[]>([]);
  const [dict, setDict] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; role: Role } | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [permsTouched, setPermsTouched] = useState(false);
  const [form] = Form.useForm<RoleFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<Role[]>('/iam/roles');
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
    api
      .get<Permission[]>('/iam/roles/permissions/list')
      .then((res) => setDict(res.data))
      .catch((err) => {
        // Surface it — a silently-empty dictionary makes edit modals map every
        // bound permission to nothing, and PUT would wipe the role's grants.
        setDict([]);
        message.error(`权限字典加载失败：${apiErrorText(err)}`);
      });
  }, [load, message]);

  const permIdByCode = useMemo(
    () => new Map(dict.map((p) => [p.code, p.id])),
    [dict],
  );

  const openCreate = () => {
    form.setFieldsValue({
      code: '',
      name: '',
      dataScope: 'ORG_SUBTREE',
      permissionIds: [],
    });
    setPermsTouched(false);
    setModal({ mode: 'create' });
  };

  const openEdit = (role: Role) => {
    form.setFieldsValue({
      code: role.code,
      name: role.name,
      dataScope: role.dataScope,
      // role.perms are permission CODES — translate to dictionary ids.
      permissionIds: role.perms
        .map((c) => permIdByCode.get(c))
        .filter((id): id is string => id !== undefined),
    });
    setPermsTouched(false);
    setModal({ mode: 'edit', role });
  };

  const submit = async () => {
    let values: RoleFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // inline field errors are already shown
    }
    setSaving(true);
    try {
      if (modal?.mode === 'create') {
        const res = await api.post<Role>('/iam/roles', {
          code: values.code,
          name: values.name,
          dataScope: values.dataScope,
        });
        if (values.permissionIds.length > 0) {
          await api.put(`/iam/roles/${res.data.id}/permissions`, {
            permissionIds: values.permissionIds,
          });
        }
        message.success('角色已创建');
      } else if (modal?.mode === 'edit') {
        await api.patch(`/iam/roles/${modal.role.id}`, {
          name: values.name,
          dataScope: values.dataScope,
        });
        // PUT is a full replace — only send it when the admin actually edited
        // the checkbox list, or a failed/empty dictionary would wipe every
        // existing grant on an unrelated rename.
        if (permsTouched) {
          await api.put(`/iam/roles/${modal.role.id}/permissions`, {
            permissionIds: values.permissionIds,
          });
        }
        message.success('角色已更新');
      }
      setModal(null);
      await load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (role: Role) => {
    try {
      await api.delete(`/iam/roles/${role.id}`);
      message.success('角色已删除');
      await load();
    } catch (err) {
      // ROLE_IN_USE / ROLE_PROTECTED …
      message.error(apiErrorText(err));
    }
  };

  const columns: ColumnsType<Role> = [
    { title: '角色编码', dataIndex: 'code', key: 'code' },
    { title: '角色名称', dataIndex: 'name', key: 'name' },
    {
      title: '数据范围',
      dataIndex: 'dataScope',
      key: 'dataScope',
      width: 140,
      render: (s: DataScope) => <Tag>{SCOPE_LABELS[s]}</Tag>,
    },
    {
      title: '权限',
      dataIndex: 'perms',
      key: 'perms',
      render: (perms: string[], record) =>
        record.code === 'admin' ? (
          <Tag color="gold">*（全部权限）</Tag>
        ) : perms.length > 0 ? (
          <Space size={[4, 4]} wrap>
            {perms.map((p) => (
              <Tag key={p}>{p}</Tag>
            ))}
          </Space>
        ) : (
          <span style={{ color: '#999' }}>无</span>
        ),
    },
    ...(isAdmin
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 160,
            render: (_: unknown, record: Role) => (
              <Space size="small">
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => openEdit(record)}
                >
                  编辑
                </Button>
                <Popconfirm
                  title="删除该角色？"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => void remove(record)}
                >
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={record.code === 'admin'}
                    title={
                      record.code === 'admin'
                        ? '内置管理员角色不可删除'
                        : undefined
                    }
                  >
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          } satisfies ColumnsType<Role>[number],
        ]
      : []),
  ];

  return (
    <Card
      title="角色权限"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          {isAdmin && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增角色
            </Button>
          )}
        </Space>
      }
    >
      <Table<Role>
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
      />

      <Modal
        open={modal !== null}
        title={modal?.mode === 'create' ? '新增角色' : '编辑角色'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setModal(null)}
        width={560}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="code"
            label="角色编码"
            rules={[{ required: true, message: '请输入角色编码' }]}
            extra={modal?.mode === 'edit' ? '编码创建后不可修改' : '如 reader、cashier'}
          >
            <Input disabled={modal?.mode === 'edit'} />
          </Form.Item>
          <Form.Item
            name="name"
            label="角色名称"
            rules={[{ required: true, message: '请输入角色名称' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="dataScope"
            label="数据范围"
            rules={[{ required: true, message: '请选择数据范围' }]}
          >
            <Select
              options={(['ALL', 'ORG_SUBTREE', 'SELF'] as const).map((s) => ({
                value: s,
                label: `${SCOPE_LABELS[s]}（${s}）`,
              }))}
            />
          </Form.Item>
          <Divider plain style={{ margin: '8px 0 16px' }}>
            权限（未改动保持原样；改动后整体替换）
          </Divider>
          <Form.Item name="permissionIds" noStyle>
            <Checkbox.Group
              style={{ width: '100%' }}
              onChange={() => setPermsTouched(true)}
            >
              <Space direction="vertical" size={4}>
                {dict.map((p) => (
                  <Checkbox key={p.id} value={p.id}>
                    {p.code}
                    <span style={{ color: '#999', marginLeft: 8 }}>
                      {p.type === 'MENU' ? '菜单' : p.type === 'ACTION' ? '操作' : '数据'}
                    </span>
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
