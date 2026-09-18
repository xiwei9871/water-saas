import {
  EditOutlined,
  KeyOutlined,
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
  TreeSelect,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { DataNode } from 'antd/es/tree';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type { OrgUnit, Role, Staff } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';

interface StaffFormValues {
  login: string;
  name: string;
  password?: string;
  orgUnitId: string;
  status?: Staff['status'];
  roleIds?: string[];
}

const fmtTime = (iso: string) => iso.replace('T', ' ').slice(0, 19);

/** 用户管理：员工列表 + 新建/编辑 + 重置密码。角色绑定仅管理员可见。 */
export default function StaffPage() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('iam:write');
  // Binding roles is a grant → server-side admin-only (assertAdmin).
  const isAdmin = hasPerm('*');

  const [rows, setRows] = useState<Staff[]>([]);
  const [orgs, setOrgs] = useState<OrgUnit[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(false);
  const [orgFilter, setOrgFilter] = useState<string | undefined>(undefined);
  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; staff: Staff } | null
  >(null);
  const [pwdTarget, setPwdTarget] = useState<Staff | null>(null);
  const [saving, setSaving] = useState(false);
  const [rolesTouched, setRolesTouched] = useState(false);
  const [form] = Form.useForm<StaffFormValues>();
  const [pwdForm] = Form.useForm<{ password: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<Staff[]>('/iam/staff', {
        params: orgFilter ? { orgUnitId: orgFilter } : undefined,
      });
      setRows(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [message, orgFilter]);

  useEffect(() => {
    // Defer to a microtask — setState must not run synchronously in effects.
    queueMicrotask(() => void load());
  }, [load]);

  useEffect(() => {
    api
      .get<OrgUnit[]>('/iam/orgs')
      .then((res) => setOrgs(res.data))
      .catch((err) => message.error(apiErrorText(err)));
    api
      .get<Role[]>('/iam/roles')
      .then((res) => setRoles(res.data))
      .catch(() => setRoles([])); // 非 iam:read 时不阻塞主列表
  }, [message]);

  const orgName = useCallback(
    (id: string) => orgs.find((o) => o.id === id)?.name ?? id.slice(0, 8),
    [orgs],
  );

  const orgTreeData = useMemo<DataNode[]>(() => {
    const build = (parentId: string | null): DataNode[] =>
      orgs
        .filter((o) => o.parentId === parentId)
        .map((o) => ({
          key: o.id,
          value: o.id,
          title: o.name,
          children: build(o.id),
        }));
    return build(null);
  }, [orgs]);

  const openCreate = () => {
    form.resetFields();
    setRolesTouched(false);
    setModal({ mode: 'create' });
  };
  const openEdit = (staff: Staff) => {
    form.setFieldsValue({
      login: staff.login,
      name: staff.name,
      orgUnitId: staff.orgUnitId,
      status: staff.status,
      roleIds: undefined,
    });
    setRolesTouched(false);
    setModal({ mode: 'edit', staff });
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (modal?.mode === 'create') {
        await api.post('/iam/staff', {
          login: values.login,
          name: values.name,
          password: values.password,
          orgUnitId: values.orgUnitId,
          // roleIds omitted entirely → stays a delegated (non-admin) create.
          ...(isAdmin && rolesTouched ? { roleIds: values.roleIds ?? [] } : {}),
        });
        message.success('用户已创建');
      } else if (modal?.mode === 'edit') {
        await api.patch(`/iam/staff/${modal.staff.id}`, {
          name: values.name,
          orgUnitId: values.orgUnitId,
          status: values.status,
          // The list API does not return current role bindings — an empty
          // untouched field MUST NOT wipe them, so only send when changed.
          ...(isAdmin && rolesTouched ? { roleIds: values.roleIds ?? [] } : {}),
        });
        message.success('用户已更新');
      }
      setModal(null);
      await load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const submitPassword = async () => {
    const { password } = await pwdForm.validateFields();
    if (!pwdTarget) return;
    setSaving(true);
    try {
      await api.post(`/iam/staff/${pwdTarget.id}/password`, { password });
      message.success(`已重置 ${pwdTarget.name} 的密码`);
      setPwdTarget(null);
      pwdForm.resetFields();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<Staff> = [
    { title: '账号', dataIndex: 'login', key: 'login' },
    { title: '姓名', dataIndex: 'name', key: 'name' },
    {
      title: '所属组织',
      dataIndex: 'orgUnitId',
      key: 'orgUnitId',
      render: (id: string) => orgName(id),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: Staff['status']) =>
        s === 'ACTIVE' ? (
          <Tag color="green">正常</Tag>
        ) : (
          <Tag color="red">停用</Tag>
        ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: fmtTime,
    },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 170,
            render: (_: unknown, record: Staff) => (
              <Space size="small">
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => openEdit(record)}
                >
                  编辑
                </Button>
                <Button
                  size="small"
                  icon={<KeyOutlined />}
                  onClick={() => setPwdTarget(record)}
                >
                  重置密码
                </Button>
              </Space>
            ),
          } satisfies ColumnsType<Staff>[number],
        ]
      : []),
  ];

  return (
    <Card
      title="用户管理"
      extra={
        <Space>
          <TreeSelect
            allowClear
            placeholder="按组织筛选"
            style={{ width: 220 }}
            treeData={orgTreeData}
            treeDefaultExpandAll
            value={orgFilter}
            onChange={(v) => setOrgFilter(v)}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增用户
            </Button>
          )}
        </Space>
      }
    >
      <Table<Staff>
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: true }}
      />

      <Modal
        open={modal !== null}
        title={modal?.mode === 'create' ? '新增用户' : '编辑用户'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="login"
            label="登录账号"
            rules={[{ required: true, message: '请输入登录账号' }]}
          >
            <Input disabled={modal?.mode === 'edit'} placeholder="如 meter01" />
          </Form.Item>
          <Form.Item
            name="name"
            label="姓名"
            rules={[{ required: true, message: '请输入姓名' }]}
          >
            <Input />
          </Form.Item>
          {modal?.mode === 'create' && (
            <Form.Item
              name="password"
              label="初始密码"
              rules={[{ required: true, message: '请输入初始密码' }]}
            >
              <Input.Password placeholder="首次登录密码" />
            </Form.Item>
          )}
          <Form.Item
            name="orgUnitId"
            label="所属组织"
            rules={[{ required: true, message: '请选择所属组织' }]}
          >
            <TreeSelect
              treeData={orgTreeData}
              treeDefaultExpandAll
              placeholder="选择组织"
            />
          </Form.Item>
          {modal?.mode === 'edit' && (
            <Form.Item name="status" label="状态">
              <Select
                options={[
                  { value: 'ACTIVE', label: '正常' },
                  { value: 'DISABLED', label: '停用' },
                ]}
              />
            </Form.Item>
          )}
          {isAdmin && (
            <Form.Item
              name="roleIds"
              label="角色"
              extra="留空表示不修改角色；选择后提交将整体替换该用户的角色。"
            >
              <Select
                mode="multiple"
                allowClear
                placeholder="选择角色（管理员操作）"
                options={roles.map((r) => ({
                  value: r.id,
                  label: `${r.name}（${r.code}）`,
                }))}
                onChange={() => setRolesTouched(true)}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        open={pwdTarget !== null}
        title={pwdTarget ? `重置密码 — ${pwdTarget.name}` : ''}
        okText="重置"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitPassword()}
        onCancel={() => setPwdTarget(null)}
        destroyOnHidden
      >
        <Form form={pwdForm} layout="vertical">
          <Form.Item
            name="password"
            label="新密码"
            rules={[{ required: true, message: '请输入新密码' }]}
          >
            <Input.Password placeholder="重置后请通知本人修改" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
