import {
  CheckOutlined,
  EyeOutlined,
  PlusOutlined,
  LinkOutlined,
  ReloadOutlined,
  StopOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tabs,
  Tag,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiErrorText } from '../../api/client';
import {
  TASK_BIZ_ROUTES,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TASK_TYPE_LABELS,
  type TaskItem,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { enumLabel, fmtTime, taskContextFields, taskContextText } from '../common';

const PRIORITY_COLOR: Record<string, string> = {
  LOW: 'default',
  NORMAL: 'blue',
  HIGH: 'orange',
  URGENT: 'red',
};

type Box = 'todo' | 'done' | 'alert';

/** 任务中心（任务书 §1.7）：待办/已办/告警三箱，领取式处理 + bizType 直达。 */
export default function Tasks() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const navigate = useNavigate();
  const [box, setBox] = useState<Box>('todo');
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<TaskItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [detail, setDetail] = useState<TaskItem | null>(null);
  const [completeFor, setCompleteFor] = useState<TaskItem | null>(null);
  const [completeForm] = Form.useForm<{ note: string }>();
  const [evidence, setEvidence] = useState<string[]>([]);
  const [completing, setCompleting] = useState(false);

  const canAlert = hasPerm('iam:write');

  const load = useCallback(
    async (b: Box, p: number, size: number) => {
      setLoading(true);
      try {
        const res = await api.get<{ items: TaskItem[]; total: number }>('/tasks', {
          params: { box: b, take: size, skip: (p - 1) * size, ...(typeFilter ? { type: typeFilter } : {}) },
        });
        setRows(res.data.items);
        setTotal(res.data.total);
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [message, typeFilter],
  );

  useEffect(() => {
    void load(box, page, pageSize);
  }, [load, box, page, pageSize]);

  const openDetail = async (id: string) => {
    try {
      const res = await api.get<TaskItem>(`/tasks/${id}`);
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const claim = async (id: string) => {
    try {
      await api.post(`/tasks/${id}/claim`);
      message.success('已领取，开始处理');
      setDetail(null);
      void load(box, page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
      void load(box, page, pageSize);
    }
  };

  /** 完成弹窗（3.4）：处理结果必填；现场类任务必须带佐证。 */
  const openComplete = (t: TaskItem) => {
    setCompleteFor(t);
    completeForm.resetFields();
    setEvidence([]);
  };

  const submitComplete = async () => {
    if (!completeFor) return;
    const v = await completeForm.validateFields();
    if (completeFor.evidenceRequired && !evidence.length) {
      message.warning('现场类任务完成须上传佐证（照片/单据）');
      return;
    }
    setCompleting(true);
    try {
      await api.post(`/tasks/${completeFor.id}/complete`, {
        note: v.note.trim(),
        evidenceRefs: evidence,
      });
      message.success('已完成');
      setCompleteFor(null);
      setDetail(null);
      void load(box, page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setCompleting(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await api.post(`/tasks/${id}/cancel`, { reason: '管理员取消' });
      message.success('已取消');
      setDetail(null);
      void load(box, page, pageSize);
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const gotoBiz = (t: TaskItem) => {
    const tpl = TASK_BIZ_ROUTES[t.type];
    if (!tpl) {
      message.warning('该任务类型暂无直达页面');
      return;
    }
    const ctx = (t.context ?? {}) as Record<string, unknown>;
    const route = tpl.replace(/\{(\w+)\}/g, (_m, k) => {
      if (k === 'bizId') return t.bizId;
      if (k === 'taskId') return t.id;
      const v = ctx[k];
      return v == null ? '' : String(v);
    });
    // U1：携带完整定位参数（户号/账期便于目标页与人工核对）。
    const extra = new URLSearchParams();
    const wa = ctx.waterAccountNo ?? ctx.settleNo ?? null;
    if (wa != null && wa !== '') extra.set('wa', String(wa));
    if (ctx.period != null && ctx.period !== '') extra.set('period', String(ctx.period));
    const sep = route.includes('?') ? '&' : '?';
    navigate(extra.size ? `${route}${sep}${extra.toString()}` : route);
  };

  const columns: ColumnsType<TaskItem> = [
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 130,
      render: (v: string, r) => (
        <Tag color={r.escalatedAt ? 'red' : 'default'}>{enumLabel(TASK_TYPE_LABELS, v)}</Tag>
      ),
    },
    { title: '标题', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: '业务对象',
      dataIndex: 'bizLabel',
      key: 'bizLabel',
      width: 180,
      render: (v: string | null) => v ?? '—',
    },
    { title: '触发原因', dataIndex: 'reason', key: 'reason', ellipsis: true },
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 90,
      render: (v: TaskItem['priority']) => (
        <Tag color={PRIORITY_COLOR[v]}>{enumLabel(TASK_PRIORITY_LABELS, v)}</Tag>
      ),
    },
    {
      title: '期限',
      dataIndex: 'dueAt',
      key: 'dueAt',
      width: 130,
      render: (v: string | null, r) =>
        v ? (
          <span style={{ color: dayjs(v).isBefore(dayjs()) && r.status !== 'DONE' ? '#cf1322' : undefined }}>
            {dayjs(v).format('MM-DD HH:mm')}
          </span>
        ) : (
          '—'
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (v: TaskItem['status'], r) => (
        <Badge
          status={v === 'DONE' ? 'success' : v === 'CLAIMED' ? 'processing' : 'default'}
          text={
            <>
              {enumLabel(TASK_STATUS_LABELS, v)}
              {v === 'CLAIMED' && r.assigneeName ? `（${r.assigneeName}）` : ''}
            </>
          }
        />
      ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 200,
      render: (_, r) => (
        <Space size="small">
          <Button size="small" icon={<EyeOutlined />} onClick={() => void openDetail(r.id)}>
            详情
          </Button>
          {box === 'todo' && r.status === 'PENDING' && (
            <Button size="small" type="primary" icon={<UserAddOutlined />} onClick={() => void claim(r.id)}>
              领取
            </Button>
          )}
          {box === 'todo' && r.status === 'CLAIMED' && (
            <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => openComplete(r)}>
              完成
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="待办中心"
      extra={
        <Space>
          <Tabs
            size="small"
            activeKey={box}
            onChange={(k) => {
              setBox(k as Box);
              setPage(1);
            }}
            items={[
              { key: 'todo', label: '我的待办' },
              { key: 'done', label: '已办' },
              ...(canAlert ? [{ key: 'alert', label: '待指派告警' }] : []),
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(box, page, pageSize)}>
            刷新
          </Button>
        </Space>
      }
    >
      {box === 'alert' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="以下任务无任何具备所需权限的账号可承接，请调整权限或为账号授权。"
        />
      )}
      <Space style={{ marginBottom: 12 }} wrap>
        <span>类型：</span>
        <Button
          size="small"
          type={typeFilter === undefined ? 'primary' : 'default'}
          onClick={() => setTypeFilter(undefined)}
        >
          全部
        </Button>
        {Object.entries(TASK_TYPE_LABELS).map(([k, v]) => (
          <Button
            key={k}
            size="small"
            type={typeFilter === k ? 'primary' : 'default'}
            onClick={() => setTypeFilter(k)}
          >
            {v}
          </Button>
        ))}
      </Space>
      <Table<TaskItem>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          onChange: (p, s) => {
            setPage(p);
            setPageSize(s);
          },
        }}
      />
      <Drawer
        title={detail ? `任务详情 · ${enumLabel(TASK_TYPE_LABELS, detail.type)}` : '任务详情'}
        open={detail !== null}
        width={520}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            {detail.escalatedAt && (
              <Alert type="error" showIcon message="已超期升级" description={`于 ${fmtTime(detail.escalatedAt)} 标记为紧急并抄送上级。`} />
            )}
            {detail.candidateCount === 0 && detail.status === 'PENDING' && (
              <Alert
                type="warning"
                showIcon
                message="暂无具备权限的账号"
                description={`该任务需要权限 ${detail.requiredPerm}，当前无任何账号持有。请系统管理员调整权限。`}
              />
            )}
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="标题">{detail.title}</Descriptions.Item>
              <Descriptions.Item label="业务对象">{detail.bizLabel ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="触发原因">{detail.reason}</Descriptions.Item>
              <Descriptions.Item label="状态">
                {enumLabel(TASK_STATUS_LABELS, detail.status)}
                {detail.assigneeName ? `（${detail.assigneeName}）` : ''}
              </Descriptions.Item>
              <Descriptions.Item label="候选责任人">
                {detail.candidates?.length
                  ? detail.candidates.map((c) => c.name).join('、')
                  : '—'}
              </Descriptions.Item>
              {detail.guide && (
                <Descriptions.Item label="操作指引">
                  <Alert type="info" showIcon message={detail.guide} style={{ padding: '4px 8px' }} />
                </Descriptions.Item>
              )}
              {detail.context && (
                <Descriptions.Item label="业务要素">
                  {taskContextText(detail.type, detail.context) && (
                    <div style={{ marginBottom: 6, color: '#555' }}>
                      {taskContextText(detail.type, detail.context)}
                    </div>
                  )}
                  <Descriptions column={1} size="small" bordered>
                    {taskContextFields(detail.context).map((f) => (
                      <Descriptions.Item key={f.key} label={f.label}>
                        {f.text}
                      </Descriptions.Item>
                    ))}
                  </Descriptions>
                </Descriptions.Item>
              )}
              {detail.status === 'DONE' && (
                <>
                  <Descriptions.Item label="处理结果">
                    {detail.resultNote ?? '—'}
                  </Descriptions.Item>
                  {Array.isArray(detail.resultEvidence) && detail.resultEvidence.length > 0 && (
                    <Descriptions.Item label="佐证">
                      {detail.resultEvidence.length} 项
                      {detail.resultEvidence.slice(0, 4).map((ev, i) =>
                        typeof ev === 'string' && ev.startsWith('data:image') ? (
                          <img key={i} src={ev} alt={`佐证${i + 1}`} style={{ display: 'block', maxWidth: 160, marginTop: 4, borderRadius: 4 }} />
                        ) : (
                          <Tag key={i} style={{ marginLeft: 4 }}>佐证{i + 1}</Tag>
                        ),
                      )}
                    </Descriptions.Item>
                  )}
                </>
              )}
              <Descriptions.Item label="创建时间">{fmtTime(detail.createdAt)}</Descriptions.Item>
              {detail.dueAt && (
                <Descriptions.Item label="期限">{fmtTime(detail.dueAt)}</Descriptions.Item>
              )}
            </Descriptions>
            <Space wrap>
              <Button icon={<LinkOutlined />} onClick={() => gotoBiz(detail)}>
                前往业务页处理
              </Button>
              {detail.canClaim && (
                <Button type="primary" icon={<UserAddOutlined />} onClick={() => void claim(detail.id)}>
                  领取任务
                </Button>
              )}
              {detail.status === 'CLAIMED' && (
                <Button type="primary" icon={<CheckOutlined />} onClick={() => openComplete(detail)}>
                  标记完成
                </Button>
              )}
              {canAlert && (detail.status === 'PENDING' || detail.status === 'CLAIMED') && (
                <Button danger icon={<StopOutlined />} onClick={() => void cancel(detail.id)}>
                  取消任务
                </Button>
              )}
            </Space>
          </Space>
        )}
      </Drawer>

      <Modal
        maskClosable={false}
        title={completeFor ? `完成任务：${completeFor.title}` : ''}
        open={!!completeFor}
        onOk={() => void submitComplete()}
        onCancel={() => setCompleteFor(null)}
        confirmLoading={completing}
        okText="确认完成"
        destroyOnHidden
      >
        {completeFor?.guide && (
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message={completeFor.guide} />
        )}
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="完成前请确认业务动作已实际达成——系统会校验完成标准，未达成将拦截。"
        />
        <Form form={completeForm} layout="vertical">
          <Form.Item
            name="note"
            label="处理结果（必填）"
            rules={[{ required: true, whitespace: true, message: '请填写处理结果' }]}
          >
            <Input.TextArea rows={3} maxLength={480} placeholder="如：已现场换表，新表号 M…，起度 0；客户已签字确认。" />
          </Form.Item>
          <Form.Item
            label={completeFor?.evidenceRequired ? '佐证照片/单据（必填）' : '佐证照片/单据（可后补）'}
            required={completeFor?.evidenceRequired}
          >
            <Upload
              accept="image/*,.pdf"
              multiple
              beforeUpload={(file) => {
                const reader = new FileReader();
                reader.onload = () => setEvidence((prev) => [...prev, String(reader.result)]);
                reader.readAsDataURL(file);
                return false;
              }}
              onRemove={(file) => {
                setEvidence((prev) => prev.filter((_, i) => i !== Number(file.uid) - 1));
                return true;
              }}
              fileList={evidence.map((_, i) => ({ uid: String(i + 1), name: `佐证 ${i + 1}` }) as never)}
              listType="text"
            >
              <Button icon={<PlusOutlined />}>添加佐证</Button>
            </Upload>
            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
              支持照片/单据，多选；已选 {evidence.length} 项。
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
