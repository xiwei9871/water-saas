import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { App as AntdApp, Button, Card, DatePicker, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Spin, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fetchAll, apiErrorText, errorCode, toApiError } from '../../api/client';
import type {
  BookCadence,
  BookMember,
  MeterChannel,
  ReadingBook,
  ReadingBookDetail,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  enumLabel,
  cleanBody,
  cleanPatch,
  fmtTime,
  newIdemKey,
} from '../common';
import {
  AccountStatusTag,
  BillingAccountSelect,
  CustomerSelect,
  OrgUnitTreeSelect,
  StaffSelect,
  WaterAccountSelect,
} from '../pickers';
import { FocusTaskBar } from '../../components/TaskFocus';
import Table from '../../components/PageTable';


interface BookFormValues {
  bookNo?: string;
  name: string;
  orgUnitId: string;
  readerId?: string;
  scheduleDay?: number | null;
  cadence: BookCadence;
  anchorMonth?: dayjs.Dayjs | null;
  meterChannel: MeterChannel;
}

const CADENCE_LABELS: Record<BookCadence, string> = {
  MONTHLY: '每月',
  ODD_MONTH: '单月（1/3/5/7/9/11月）',
  EVEN_MONTH: '双月（2/4/6/8/10/12月）',
  QUARTERLY: '季度（每3个月）',
};
const CHANNEL_LABELS: Record<MeterChannel, string> = {
  MECHANICAL: '机械表·人工',
  REMOTE_MANUAL: '远传·人工补录',
  REMOTE_AUTO: '远传·自动（仅登记）',
};

interface MemberFormValues {
  customerId?: string; // 仅用于级联过滤用水户，不提交
  waterAccountId: string;
}


type ModalState =
  | { kind: 'create' }
  | { kind: 'edit'; book: ReadingBook }
  | null;

/**
 * 抄表册：册列表 + 新建/编辑 + 册内用水户管理（抽屉）+ 删除。
 * 组织/抄表员选择需要 iam:read；没有该权限时组织默认取当前用户
 * 所属组织、抄表员字段隐藏（服务端readerId可空，生成计划时再指定）。
 */
export default function ReadingBooks() {
  const { message, modal: antdModal } = AntdApp.useApp();
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
  const [cadenceFilter, setCadenceFilter] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // A2 缺失类异常直达：?wa=用水户id → 只显示含该户的抄表册。
  const [focusParams, setFocusParams] = useSearchParams();
  const focusWa = focusParams.get('wa');

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
    async () => {
      setLoading(true);
      try {
        const res = { data: await fetchAll<ReadingBook>('/reading-books', {            ...(name.trim() ? { name: name.trim() } : {}),
            ...(bookNo.trim() ? { bookNo: bookNo.trim() } : {}),
            ...(orgFilter ? { orgUnitId: orgFilter } : {}),
            ...(cadenceFilter ? { cadence: cadenceFilter } : {}),
            ...(statusFilter ? { status: statusFilter } : {}),
            ...(focusWa ? { waterAccountId: focusWa } : {}),
          }) };
        setRows(res.data);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [bookNo, message, name, orgFilter, cadenceFilter, statusFilter, focusWa],
  );

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  // 组织/抄表员名称已由 API 内嵌（orgUnitName/readerName）；取不到按规范显 '—'。
  const orgName = useCallback((_id: string) => '—', []);
  const staffName = useCallback((_id: string | null) => '—', []);

  const total = rows.length;

  const openModal = (m: NonNullable<ModalState>) => {
    setIdemKey(newIdemKey());
    setModal(m);
  };

  const openCreate = () => {
    form.resetFields();
    // 无 iam:read 时组织字段不渲染 —— 默认挂到当前用户所属组织。
    form.setFieldsValue({
      orgUnitId: user?.orgUnitId,
      cadence: 'MONTHLY',
      meterChannel: 'MECHANICAL',
    });
    openModal({ kind: 'create' });
  };

  const openEdit = (book: ReadingBook) => {
    form.setFieldsValue({
      name: book.name,
      orgUnitId: book.orgUnitId,
      readerId: book.readerId ?? undefined,
      scheduleDay: book.scheduleDay,
      cadence: book.cadence ?? 'MONTHLY',
      anchorMonth: book.anchorPeriod ? dayjs(`${book.anchorPeriod}01`) : null,
      meterChannel: book.meterChannel ?? 'MECHANICAL',
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
            cadence: values.cadence,
            meterChannel: values.meterChannel,
            // 仅季度册带首抄月锚点（DB CHECK 同步）。
            anchorPeriod:
              values.cadence === 'QUARTERLY'
                ? values.anchorMonth?.format('YYYYMM')
                : undefined,
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
            cadence: values.cadence,
            meterChannel: values.meterChannel,
            anchorPeriod:
              values.cadence === 'QUARTERLY'
                ? (values.anchorMonth?.format('YYYYMM') ?? null)
                : null,
          }),
        );
        message.success('抄表册已更新');
      }
      setModal(null);
      await load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (book: ReadingBook) => {
    const next = book.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
    try {
      await api.patch(`/reading-books/${book.id}`, { status: next });
      message.success(`抄表册 ${book.name} 已${next === 'DISABLED' ? '停用' : '启用'}`);
      await load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const remove = async (book: ReadingBook) => {
    try {
      await api.delete(`/reading-books/${book.id}`);
      message.success(`抄表册 ${book.name} 已删除`);
      await load();
    } catch (err) {
      // BOOK_HAS_PLANS 等冲突文案直接透出。
      message.error(apiErrorText(err));
    }
  };

  const membersSeq = useRef(0);

  const openMembers = async (book: ReadingBook) => {
    // Stale-guard: only the most recent openMembers may write drawer state.
    const seq = ++membersSeq.current;
    setMembersLoading(true);
    setMembersBook(null);
    setMemberIdemKey(newIdemKey()); // 每次成功添加后重新生成 —— 同一键不能复用于不同内容
    memberForm.resetFields();
    try {
      const res = await api.get<ReadingBookDetail>(`/reading-books/${book.id}`);
      if (seq === membersSeq.current) setMembersBook(res.data);
    } catch (err) {
      if (seq === membersSeq.current) message.error(apiErrorText(err));
    } finally {
      if (seq === membersSeq.current) setMembersLoading(false);
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
      // 顺序号由服务端按 max+1 分配（RC1-2 / F9），前端不再提交。
      await api.post(
        `/reading-books/${membersBook.id}/meters`,
        cleanBody({
          waterAccountId: values.waterAccountId,
        }),
        { headers: { 'Idempotency-Key': memberIdemKey } },
      );
      message.success('已加入抄表册');
      setMemberIdemKey(newIdemKey());
      memberForm.resetFields();
      await reloadMembers();
    } catch (err) {
      // RC1-2 / F10: 该户已在其他册 → 显式转移确认，绝不静默双册。
      if (errorCode(err) === 'ACCOUNT_IN_OTHER_BOOK') {
        const body = toApiError(err).body as
          | { bookNo?: string | null; bookName?: string | null }
          | undefined;
        const where = body?.bookNo
          ? `${body.bookName ?? ''}（${body.bookNo}）`
          : '另一抄表册';
        antdModal.confirm({
          title: '该用水户已在其他抄表册',
          content: `该用水户当前已属于：${where}。是否转移到本册「${membersBook.name}」？`,
          okText: '转移到本册',
          cancelText: '取消',
          onOk: async () => {
            await api.post(
              `/reading-books/${membersBook.id}/meters/transfer`,
              { waterAccountId: values.waterAccountId },
              { headers: { 'Idempotency-Key': newIdemKey() } },
            );
            message.success('已转移到本册');
            setMemberIdemKey(newIdemKey());
            memberForm.resetFields();
            await reloadMembers();
          },
        });
      } else {
        message.error(apiErrorText(err));
      }
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
      key: 'orgUnit',
      width: 140,
      render: (_: unknown, r: ReadingBook) =>
        r.orgUnitName ?? orgName(r.orgUnitId),
    },
    {
      title: '默认抄表员',
      key: 'reader',
      width: 150,
      render: (_: unknown, r: ReadingBook) =>
        r.readerName ?? staffName(r.readerId),
    },
    {
      title: '抄表日',
      dataIndex: 'scheduleDay',
      key: 'scheduleDay',
      width: 90,
      render: (d: number | null) => (d ? `每月 ${d} 日` : '—'),
    },
    {
      title: '周期 / 方式',
      key: 'cadence',
      width: 170,
      render: (_: unknown, r: ReadingBook) => (
        <Space size={4} wrap>
          <Tag>
            {enumLabel(CADENCE_LABELS, r.cadence ?? 'MONTHLY')}
            {r.cadence === 'QUARTERLY' && r.anchorPeriod
              ? ` · 锚 ${r.anchorPeriod.slice(0, 4)}-${r.anchorPeriod.slice(4)}`
              : ''}
          </Tag>
          <Tag color="geekblue">{enumLabel(CHANNEL_LABELS, r.meterChannel ?? 'MECHANICAL')}</Tag>
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 80,
      render: (_: unknown, r: ReadingBook) =>
        r.status === 'DISABLED' ? <Tag>停用</Tag> : <Tag color="green">启用</Tag>,
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
      width: 280,
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
            <Button
              size="small"
              onClick={() => void toggleStatus(record)}
            >
              {record.status === 'DISABLED' ? '启用' : '停用'}
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
      width: 150,
      render: (_: unknown, m: BookMember) =>
        m.waterAccount?.accountNo ?? '—',
    },
    {
      title: '客户名称',
      key: 'customerName',
      width: 110,
      ellipsis: true,
      render: (_: unknown, m: BookMember) => m.waterAccount?.customer?.name ?? '—',
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
                title="移出该用水户？"
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
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="抄表周期"
            style={{ width: 170 }}
            value={cadenceFilter}
            onChange={(v) => {
              setCadenceFilter(v);
              setPage(1);
            }}
            options={(Object.keys(CADENCE_LABELS) as BookCadence[]).map(
              (c) => ({ value: c, label: enumLabel(CADENCE_LABELS, c) }),
            )}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="状态"
            style={{ width: 110 }}
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v);
              setPage(1);
            }}
            options={[
              { value: 'ACTIVE', label: '启用' },
              { value: 'DISABLED', label: '停用' },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
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
      {focusWa && (
        <FocusTaskBar
          focusId={focusWa}
          summary={
            <span>
              该用水户的入册情况（未入册异常时此处应为空，请在右侧册中「加入用水户」）
            </span>
          }
          showAll={false}
          onToggleAll={() => {
            const next = new URLSearchParams(focusParams);
            next.delete('wa');
            setFocusParams(next, { replace: true });
          }}
          onClose={() => {
            const next = new URLSearchParams(focusParams);
            next.delete('wa');
            setFocusParams(next, { replace: true });
          }}
        />
      )}
      <Table<ReadingBook> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows.slice((page - 1) * pageSize, page * pageSize)}
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
      <Modal maskClosable={false}
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
            <InputNumber min={1} max={31} precision={0} style={{ width: '100%' }} placeholder="1-31，可空" />
          </Form.Item>
          <Form.Item
            name="cadence"
            label="抄表周期"
            rules={[{ required: true, message: '请选择抄表周期' }]}
          >
            <Select
              options={(Object.keys(CADENCE_LABELS) as BookCadence[]).map((c) => ({
                value: c,
                label: enumLabel(CADENCE_LABELS, c),
              }))}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.cadence !== b.cadence}>
            {({ getFieldValue }) =>
              getFieldValue('cadence') === 'QUARTERLY' ? (
                <Form.Item
                  name="anchorMonth"
                  label="季度首抄月"
                  rules={[{ required: true, message: '季度抄表必须选择首抄月' }]}
                  extra="确定每 3 个月一期的节奏：如 2026-01 表示 1/4/7/10 月抄表，2026-02 表示 2/5/8/11 月抄表"
                >
                  <DatePicker picker="month" style={{ width: '100%' }} allowClear={false} />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item
            name="meterChannel"
            label="抄表方式"
            rules={[{ required: true, message: '请选择抄表方式' }]}
          >
            <Select
              options={(Object.keys(CHANNEL_LABELS) as MeterChannel[]).map((c) => ({
                value: c,
                label: enumLabel(CHANNEL_LABELS, c),
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 成员管理抽屉 */}
      <Drawer
        maskClosable={false}
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
                          rules={[{ required: true, message: '请选择用水户' }]}
                          style={{ minWidth: 220 }}
                        >
                          <WaterAccountSelect
                            customerId={getFieldValue('customerId')}
                            placeholder="选择用水户"
                          />
                        </Form.Item>
                      )}
                    </Form.Item>
                  </>
                ) : (
                  // 无 customer:read 走业务侧户号搜索，不填 uuid。
                  <Form.Item
                    name="waterAccountId"
                    rules={[{ required: true, message: '请选择用水户' }]}
                    style={{ minWidth: 300 }}
                  >
                    <BillingAccountSelect placeholder="搜索户号/客户名" />
                  </Form.Item>
                )}
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
            <Table<BookMember> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
              rowKey="waterAccountId"
              size="small"
              columns={memberColumns}
              dataSource={membersBook.members}
              pagination={false}
              locale={{ emptyText: '册内暂无用水户' }}
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
