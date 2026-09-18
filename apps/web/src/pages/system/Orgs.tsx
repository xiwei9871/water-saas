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
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Tree,
  TreeSelect,
  Typography,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type { OrgUnit } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';

const ORG_TYPE_LABELS: Record<OrgUnit['type'], string> = {
  COMPANY: '公司',
  BRANCH: '营业所',
  DEPT: '部门',
};

interface OrgFormValues {
  name: string;
  type: OrgUnit['type'];
  parentId?: string | null;
}

const fmtTime = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm:ss');

/** 组织管理：左侧组织树，右侧选中节点详情 + 增/改/删。 */
export default function Orgs() {
  const { message } = AntdApp.useApp();
  const { user, hasPerm } = useAuth();
  const canWrite = hasPerm('iam:write');
  // Creating a ROOT org requires ALL scope — a scoped writer's parentId=null
  // is outside their orgScope and the API rejects it with ORG_OUT_OF_SCOPE.
  const canCreateRoot = canWrite && user?.scope === 'ALL';

  const [orgs, setOrgs] = useState<OrgUnit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<
    | { mode: 'create'; parentId: string | null }
    | { mode: 'edit'; org: OrgUnit }
    | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<OrgFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<OrgUnit[]>('/iam/orgs');
      setOrgs(res.data);
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

  const childrenOf = useCallback(
    (id: string | null) => orgs.filter((o) => o.parentId === id),
    [orgs],
  );

  // A scoped user's subtree top still has parentId pointing at an org
  // OUTSIDE the returned set — it must render as a root or the whole tree
  // (and every org TreeSelect) comes out empty.
  const rootNodes = useMemo(() => {
    const ids = new Set(orgs.map((o) => o.id));
    return orgs.filter((o) => o.parentId === null || !ids.has(o.parentId));
  }, [orgs]);

  const treeData = useMemo<DataNode[]>(() => {
    const build = (list: OrgUnit[]): DataNode[] =>
      list.map((o) => ({
        key: o.id,
        title: `${o.name}（${ORG_TYPE_LABELS[o.type]}）`,
        children: build(childrenOf(o.id)),
      }));
    return build(rootNodes);
  }, [childrenOf, rootNodes]);

  /** TreeSelect data for the parent picker inside the edit modal. */
  const parentTreeData = useMemo<DataNode[]>(() => {
    const exclude = modal?.mode === 'edit' ? modal.org.id : null;
    const build = (list: OrgUnit[]): DataNode[] =>
      list.map((o) => ({
        key: o.id,
        value: o.id,
        title: o.name,
        // Disallow reparenting onto self — deeper descendants are still
        // offered but the API rejects cycles with ORG_CYCLE (surfaced).
        disabled: o.id === exclude,
        children: build(childrenOf(o.id)),
      }));
    return build(rootNodes);
  }, [childrenOf, rootNodes, modal]);

  const selected = orgs.find((o) => o.id === selectedId) ?? null;
  const selectedChildren = selectedId ? childrenOf(selectedId) : [];
  const parentName = (id: string | null) =>
    id === null ? '—（根节点）' : (orgs.find((o) => o.id === id)?.name ?? id);

  const openCreate = (parentId: string | null) => {
    form.setFieldsValue({ name: '', type: 'DEPT', parentId });
    setModal({ mode: 'create', parentId });
  };
  const openEdit = (org: OrgUnit) => {
    form.setFieldsValue({ name: org.name, type: org.type, parentId: org.parentId });
    setModal({ mode: 'edit', org });
  };

  const submit = async () => {
    let values: OrgFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // inline field errors are already shown
    }
    setSaving(true);
    try {
      if (modal?.mode === 'create') {
        await api.post('/iam/orgs', {
          name: values.name,
          type: values.type,
          parentId: modal.parentId,
        });
        message.success('组织已创建');
      } else if (modal?.mode === 'edit') {
        const patch: Record<string, unknown> = {
          name: values.name,
          type: values.type,
        };
        // Send parentId ONLY when it changed — a scoped user's current parent
        // sits outside their orgScope, so echoing it back trips
        // ORG_OUT_OF_SCOPE on a plain rename.
        if ((values.parentId ?? null) !== modal.org.parentId) {
          patch.parentId = values.parentId ?? null;
        }
        await api.patch(`/iam/orgs/${modal.org.id}`, patch);
        message.success('组织已更新');
      }
      setModal(null);
      await load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (org: OrgUnit) => {
    try {
      await api.delete(`/iam/orgs/${org.id}`);
      message.success('组织已删除');
      if (selectedId === org.id) setSelectedId(null);
      await load();
    } catch (err) {
      // ORG_HAS_CHILDREN / ORG_HAS_STAFF / ORG_OUT_OF_SCOPE …
      message.error(apiErrorText(err));
    }
  };

  return (
    <Card
      title="组织管理"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          {canCreateRoot && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => openCreate(null)}
            >
              新增根组织
            </Button>
          )}
        </Space>
      }
    >
      <Row gutter={16}>
        <Col xs={24} md={10}>
          {treeData.length > 0 ? (
            <Tree
              treeData={treeData}
              defaultExpandAll
              selectedKeys={selectedId ? [selectedId] : []}
              onSelect={(keys) => setSelectedId((keys[0] as string) ?? null)}
            />
          ) : (
            <Empty description={loading ? '加载中…' : '暂无组织'} />
          )}
        </Col>
        <Col xs={24} md={14}>
          {selected ? (
            <>
              <Descriptions
                bordered
                size="small"
                column={1}
                items={[
                  { key: 'name', label: '名称', children: selected.name },
                  {
                    key: 'type',
                    label: '类型',
                    children: ORG_TYPE_LABELS[selected.type],
                  },
                  {
                    key: 'parent',
                    label: '上级组织',
                    children: parentName(selected.parentId),
                  },
                  {
                    key: 'children',
                    label: '下级数量',
                    children: selectedChildren.length,
                  },
                  {
                    key: 'updated',
                    label: '更新时间',
                    children: fmtTime(selected.updatedAt),
                  },
                ]}
              />
              {canWrite && (
                <Space style={{ marginTop: 16 }} wrap>
                  <Button
                    icon={<PlusOutlined />}
                    onClick={() => openCreate(selected.id)}
                  >
                    新增下级
                  </Button>
                  <Button icon={<EditOutlined />} onClick={() => openEdit(selected)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除该组织？"
                    description="删除前需确保无下级组织且无所属用户。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => void remove(selected)}
                  >
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      disabled={selectedChildren.length > 0}
                      title={
                        selectedChildren.length > 0
                          ? '存在下级组织，无法删除'
                          : undefined
                      }
                    >
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              )}
            </>
          ) : (
            <Empty description="请选择左侧组织节点" />
          )}
        </Col>
      </Row>

      <Modal
        open={modal !== null}
        title={modal?.mode === 'create' ? '新增组织' : '编辑组织'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {modal?.mode === 'create' && (
            <Form.Item label="上级组织">
              <Typography.Text>{parentName(modal.parentId)}</Typography.Text>
            </Form.Item>
          )}
          <Form.Item
            name="name"
            label="组织名称"
            rules={[{ required: true, message: '请输入组织名称' }]}
          >
            <Input placeholder="如：第二营业所" />
          </Form.Item>
          <Form.Item
            name="type"
            label="组织类型"
            rules={[{ required: true, message: '请选择组织类型' }]}
          >
            <Select
              options={(['COMPANY', 'BRANCH', 'DEPT'] as const).map((t) => ({
                value: t,
                label: ORG_TYPE_LABELS[t],
              }))}
            />
          </Form.Item>
          {modal?.mode === 'edit' && (
            <Form.Item name="parentId" label="上级组织（留空则设为根节点）">
              <TreeSelect
                allowClear
                treeData={parentTreeData}
                treeDefaultExpandAll
                placeholder="选择上级组织"
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  );
}
