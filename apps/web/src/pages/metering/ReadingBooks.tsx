import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  BookMember,
  OrgUnit,
  ReadingBook,
  ReadingBookDetail,
  Staff,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  cleanBody,
  cleanPatch,
  fmtTime,
  newIdemKey,
} from '../common';
import {
  AccountStatusTag,
  CustomerSelect,
  OrgUnitTreeSelect,
  StaffSelect,
  WaterAccountSelect,
} from '../pickers';

interface BookFormValues {
  bookNo?: string;
  name: string;
  orgUnitId: string;
  readerId?: string;
  scheduleDay?: number | null;
}

interface MemberFormValues {
  customerId?: string; // 仅用于级联过滤水表户，不提交
  waterAccountId: string;
  seqNo?: number | null;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type ModalState =
  | { kind: 'create' }
  | { kind: 'edit'; book: ReadingBook }
  | null;

/**
 * 抄表册：册列表 + 新建/编辑 + 册内水表户管理（抽屉）+ 删除。
 * 组织/抄表员选择需要 iam:read；没有该权限时组织默认取当前用户
 * 所属组织、抄表员字段隐藏（服务端readerId可空，生成计划时再指定）。
 */
export default function ReadingBooks() {
  const { message } = AntdApp.useApp();
  const { user, hasPerm } = useAuth();
  const canWrite = hasPerm('metering:write');
  const canIamRead = hasPerm('iam:read');
  const canCustomerRead = hasPerm('customer:read');

  const [rows, setRows] = useState<ReadingBook[]>([]);
  const [loading, setLoading] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [name, setName] = useState('');
  const [bookNoInput, setBookNoInput] = useState('');
  const [bookNo, setBookNo] = useState('');
  const [orgFilter, setOrgFilter] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [orgs, setOrgs] = useState<OrgUnit[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);

  const [modal, setModal] = useState<ModalState>(null);
  const [idemKey, setIdemKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<BookFormValues>();

  const [membersBook, setMembersBook] = useState<ReadingBookDetail | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberIdemKey, setMemberIdemKey] = useState('');
  const [memberSaving, setMemberSaving] = useState(false);
  const [memberForm] = Form.useForm<MemberFormValues>();

  const load = useCallback(
    async (p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<ReadingBook[]>('/reading-books', {
          params: {
            take: size,
            skip: (p - 1) * size,
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(bookNo.trim() ? { bookNo: bookNo.trim() } : {}),
            ...(orgFilter ? { orgUnitId: orgFilter } : {}),
          },
        });
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [bookNo, message, name, orgFilter],
  );

  useEffect(() => {
    queueMicrotask(() => void load(page, pageSize));
  }, [load, page, pageSize]);

  // 组织/员工名称展示 —— 仅 iam:read 用户可拉取；失败静默退化为短 id。
  useEffect(() => {
    if (!canIamRead) return;
    api
      .get<OrgUnit[]>('/iam/orgs')
      .then((res) => setOrgs(res.data))
      .catch(() => setOrgs([]));
    api
      .get<Staff[]>('/iam/staff')
      .then((res) => setStaff(res.data))
      .catch(() => setStaff([]));
  }, [canIamRead]);

  const orgName = useCallback(
    (id: string) => orgs.find((o) => o.id === id)?.name ?? `${id.slice(0, 8)}…`,
    [orgs],
  );
  const staffName = useCallback(
    (id: string | null) => {
      if (!id) return '—';
      const s = staff.find((x) => x.id === id);
      return s ? `${s.name}（${s.login}）` : `${id.slice(0, 8)}…`;
    },
    [staff],
  );

  const total = useMemo(
    () => (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
    [page, pageSize, rows.length],
  );

  const openModal = (m: NonNullable<ModalState>) => {
    setIdemKey(newIdemKey());
    setModal(m);
  };

  const openCreate = () => {
    form.resetFields();
    // 无 iam:read 时组织字段不渲染 —— 默认挂到当前用户所属组织。
    form.setFieldsValue({ orgUnitId: user?.orgUnitId });
    openModal({ kind: 'create' });
  };

  const openEdit = (book: ReadingBook) => {
    form.setFieldsValue({
      name: book.name,
      orgUnitId: book.orgUnitId,
      readerId: book.readerId ?? undefined,
      scheduleDay: book.scheduleDay,
    });
    openModal({ kind: 'edit', book });
  };

  const submit = async () => {
    let values: BookFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (modal?.kind === 'create') {
        await api.post(
          '/reading-books',
          cleanBody({
            bookNo: values.bookNo,
            name: values.name,
            // 无 iam:read 时 TreeSelect 未渲染 —— 取用户本组织兜底。
            orgUnitId: canIamRead ? values.orgUnitId : (values.orgUnitId ?? user?.orgUnitId),
            readerId: canIamRead ? values.readerId : undefined,
            scheduleDay: values.scheduleDay ?? undefined,
          }),
          { headers: { 'Idempotency-Key': idemKey } },
        );
        message.success('抄表册已创建');
      } else if (modal?.kind === 'edit') {
        // 无 iam:read 时这两项不发送 —— 服务端 PATCH 语义为 undefined=不变。
        await api.patch(
          `/reading-books/${modal.book.id}`,
          cleanPatch({
            name: values.name,
            ...(canIamRead
              ? { orgUnitId: values.orgUnitId, readerId: values.readerId ?? null }
              : {}),
            scheduleDay: values.scheduleDay ?? null,
          }),
        );
        message.success('抄表册已更新');
      }
      setModal(null);
      await load(page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (book: ReadingBook) => {
    try {
      await api.delete(`/reading-books/${book.id}`);
      message.success(`抄表册 ${book.name} 已删除`);
      await load(page, pageSize);
    } catch (err) {
      // BOOK_HAS_PLANS 等冲突文案直接透出。
      message.error(apiErrorText(err));
    }
  };

  const openMembers = async (book: ReadingBook) => {
    setMembersLoading(true);
    setMembersBook(null);
    setMemberIdemKey(newIdemKey()); // 每次成功添加后重新生成 —— 同一键不能复用于不同内容
    memberForm.resetFields();
    try {
      const res = await api.get<ReadingBookDetail>(`/reading-books/${book.id}`);
      setMembersBook(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setMembersLoading(false);
    }
  };

  const reloadMembers = async () => {
    if (!membersBook) return;
    const res = await api.get<ReadingBookDetail>(`/reading-books/${membersBook.id}`);
    setMembersBook(res.data);
  };

  const addMember = async () => {
    let values: MemberFormValues;
    try {
      values = await memberForm.validateFields();
    } catch {
      return;
    }
    if (!membersBook) return;
    setMemberSaving(true);
    try {
      await api.post(
        `/reading-books/${membersBook.id}/meters`,
        cleanBody({
          waterAccountId: values.waterAccountId,
          seqNo: values.seqNo ?? undefined,
        }),
        { headers: { 'Idempotency-Key': memberIdemKey } },
      );
      message.success('已加入抄表册');
      setMemberIdemKey(newIdemKey());
      memberForm.resetFields();
      await reloadMembers();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setMemberSaving(false);
    }
  };

  const removeMember = async (m: BookMember) => {
    if (!membersBook) return;
    try {
      await api.delete(`/reading-books/${membersBook.id}/meters/${m.waterAccountId}`);
      message.success('已移出抄表册');
      await reloadMembers();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const columns: ColumnsType<ReadingBook> = [
    { title: '册号', dataIndex: 'bookNo', key: 'bookNo', width: 140 },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '所属组织',
      dataIndex: 'orgUnitId',
      key: 'orgUnitId',
      width: 140,
      render: orgName,
    },
    {
      title: '默认抄表员',
      dataIndex: 'readerId',
      key: 'readerId',
      width: 150,
      render: staffName,
    },
    {
      title: '抄表日',
      dataIndex: 'scheduleDay',
      key: 'scheduleDay',
      width: 90,
      render: (d: number | null) => (d ? `每月 ${d} 日` : '—'),
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
      width: 220,
      render: (_: unknown, record: ReadingBook) => (
        <Space size={4} wrap>
          <Button
            size="small"
            icon={<TeamOutlined />}
            onClick={() => void openMembers(record)}
          >
            成员
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
          {canWrite && (
            <Popconfirm
              title={`删除抄表册 ${record.name}？`}
              description="已生成过计划的抄表册无法删除。"
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => void remove(record)}
            >
              <Button size="small" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const memberColumns: ColumnsType<BookMember> = [
    { title: '顺序', dataIndex: 'seqNo', key: 'seqNo', width: 70 },
    {
      title: '户号',
      key: 'accountNo',
      width: 160,
      render: (_: unknown, m: BookMember) =>
        m.waterAccount?.accountNo ?? `${m.waterAccountId.slice(0, 8)}…`,
    },
    {
      title: '地址',
      key: 'addr',
      ellipsis: true,
      render: (_: unknown, m: BookMember) => m.waterAccount?.addr ?? '—',
    },
    {
      title: '状态',
      key: 'status',
      width: 90,
      render: (_: unknown, m: BookMember) =>
        m.waterAccount ? <AccountStatusTag status={m.waterAccount.status} /> : '—',
    },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 90,
            render: (_: unknown, m: BookMember) => (
              <Popconfirm
                title="移出该水表户？"
                description="已生成的计划明细不受影响。"
                okText="移出"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => void removeMember(m)}
              >
                <Button size="small" danger>
                  移出
                </Button>
              </Popconfirm>
            ),
          } satisfies ColumnsType<BookMember>[number],
        ]
      : []),
  ];

  return (
    <Card
      title="抄表册"
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
            placeholder="按册号搜索"
            style={{ width: 180 }}
            value={bookNoInput}
            onChange={(e) => setBookNoInput(e.target.value)}
            onSearch={(v) => {
              setBookNo(v);
              setPage(1);
            }}
          />
          {canIamRead && (
            <span style={{ width: 190, display: 'inline-block' }}>
              <OrgUnitTreeSelect
                value={orgFilter}
                onChange={(v) => {
                  setOrgFilter(v);
                  setPage(1);
                }}
                placeholder="按组织过滤"
              />
            </span>
          )}
          <Button icon={<ReloadOutlined />} onClick={() => void load(page, pageSize)}>
            刷新
          </Button>
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建抄表册
            </Button>
          )}
        </Space>
      }
    >
      <Table<ReadingBook>
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

      {/* 新建 / 编辑 */}
      <Modal
        open={modal !== null}
        title={
          modal?.kind === 'create'
            ? '新建抄表册'
            : modal?.kind === 'edit'
              ? `编辑抄表册 — ${modal.book.name}`
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
          {modal?.kind === 'create' && (
            <Form.Item name="bookNo" label="册号" extra="留空则由系统自动生成">
              <Input placeholder="如 B202501000001" />
            </Form.Item>
          )}
          <Form.Item
            name="name"
            label="册名"
            rules={[{ required: true, message: '请输入册名' }]}
          >
            <Input placeholder="如 城东一片区" />
          </Form.Item>
          {canIamRead ? (
            <Form.Item
              name="orgUnitId"
              label="所属组织"
              rules={[{ required: true, message: '请选择所属组织' }]}
            >
              <OrgUnitTreeSelect />
            </Form.Item>
          ) : (
            modal?.kind === 'create' && (
              <Form.Item label="所属组织">
                <Typography.Text type="secondary">
                  当前用户所属组织（无组织查看权限，默认取本组织）
                </Typography.Text>
              </Form.Item>
            )
          )}
          {canIamRead && (
            <Form.Item name="readerId" label="默认抄表员">
              <StaffSelect placeholder="选择抄表员（可空）" />
            </Form.Item>
          )}
          <Form.Item name="scheduleDay" label="计划抄表日">
            <InputNumber min={1} max={31} style={{ width: '100%' }} placeholder="1-31，可空" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 成员管理抽屉 */}
      <Drawer
        open={membersBook !== null || membersLoading}
        width={640}
        title={membersBook ? `册成员 — ${membersBook.name}（${membersBook.bookNo}）` : '册成员'}
        onClose={() => setMembersBook(null)}
      >
        {membersLoading || !membersBook ? (
          <Spin />
        ) : (
          <>
            {canWrite && (
              <Form
                form={memberForm}
                layout="inline"
                style={{ marginBottom: 16, rowGap: 8 }}
              >
                {canCustomerRead ? (
                  <>
                    <Form.Item name="customerId" style={{ minWidth: 200 }}>
                      <CustomerSelect placeholder="先选客户" />
                    </Form.Item>
                    <Form.Item
                      noStyle
                      shouldUpdate={(a, b) => a.customerId !== b.customerId}
                    >
                      {({ getFieldValue }) => (
                        <Form.Item
                          name="waterAccountId"
                          rules={[{ required: true, message: '请选择水表户' }]}
                          style={{ minWidth: 220 }}
                        >
                          <WaterAccountSelect
                            customerId={getFieldValue('customerId')}
                            placeholder="选择水表户"
                          />
                        </Form.Item>
                      )}
                    </Form.Item>
                  </>
                ) : (
                  // 无 customer:read 时退化为手填 uuid（服务端仍校验）。
                  <Form.Item
                    name="waterAccountId"
                    rules={[
                      { required: true, message: '请输入水表户 ID' },
                      { pattern: UUID_RE, message: 'ID 格式不正确' },
                    ]}
                    style={{ minWidth: 300 }}
                  >
                    <Input placeholder="水表户 uuid" />
                  </Form.Item>
                )}
                <Form.Item name="seqNo" style={{ width: 110 }}>
                  <InputNumber min={1} placeholder="顺序(可空)" style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    loading={memberSaving}
                    onClick={() => void addMember()}
                  >
                    加入
                  </Button>
                </Form.Item>
              </Form>
            )}
            <Table<BookMember>
              rowKey="waterAccountId"
              size="small"
              columns={memberColumns}
              dataSource={membersBook.members}
              pagination={false}
              locale={{ emptyText: '册内暂无水表户' }}
            />
            <div style={{ marginTop: 8 }}>
              <Tag color="blue">共 {membersBook.members.length} 户</Tag>
            </div>
          </>
        )}
      </Drawer>
    </Card>
  );
}
