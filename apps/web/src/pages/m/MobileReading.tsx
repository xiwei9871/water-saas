import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import {
  CheckOutlined,
  EnvironmentOutlined,
  FieldNumberOutlined,
  LogoutOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { EXCEPTION_CODES } from '@ws/types';
import { Navigate, useLocation } from 'react-router-dom';

/** crypto.randomUUID 仅在安全上下文可用 —— 内网 http 部署需回退。 */
const newIdemKey = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
import { api, apiErrorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { cleanBody, enumLabel } from '../common';
import { EXCEPTION_CODE_LABELS } from '../metering/common';

interface PlanRow {
  id: string;
  bookId: string;
  bookNo?: string | null;
  bookName?: string | null;
  period: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CLOSED';
  readerId?: string | null;
  readerName?: string | null;
}

interface PlanItem {
  id: string;
  seqNo: number;
  waterAccountId: string;
  accountNo?: string | null;
  customerName?: string | null;
  addr?: string | null;
  meterNo?: string | null;
  status: string;
  prevReadingValue?: string | null;
}

interface ProgressRow {
  PENDING: number;
  READ: number;
  NO_READ: number;
  SKIPPED: number;
  total: number;
}

/**
 * 抄表工作台（H5）— 现场抄表员移动入口。
 * 挂在 AdminLayout 外的裸路由：手机浏览器直达 /m/reading。
 * 业务口径全部走既有 /reading-plans + /meter-readings 接口（source=APP），
 * QC/异常/任务规则在服务端复用，本页只做「我的计划 → 顺序录数 → 提交」。
 */
export default function MobileReading() {
  const { user, loading, hasPerm, logout } = useAuth();
  const location = useLocation();
  const { message } = AntdApp.useApp();

  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [planId, setPlanId] = useState<string>();
  const [items, setItems] = useState<PlanItem[]>([]);
  const [progress, setProgress] = useState<ProgressRow | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [readingValue, setReadingValue] = useState<number | null>(null);
  const [remark, setRemark] = useState('');
  const [noReadOpen, setNoReadOpen] = useState(false);
  const [noReadForm] = Form.useForm<{ exceptionCode: string; estimateQty?: string; remark?: string }>();
  const idemKey = useRef(newIdemKey());

  const loadPlans = useCallback(async () => {
    setBusy(true);
    try {
      const res = await api.get('/reading-plans', { params: { take: 200 } });
      const rows = (res.data?.items ?? res.data ?? []) as PlanRow[];
      setPlans(
        rows
          .filter(
            (p) =>
              (p.status === 'OPEN' || p.status === 'IN_PROGRESS') &&
              (!p.readerId || p.readerId === user?.id),
          )
          .sort((a, b) => b.period.localeCompare(a.period)),
      );
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setBusy(false);
    }
  }, [message, user?.id]);

  const loadItems = useCallback(
    async (pid: string) => {
      setBusy(true);
      try {
        const [itemsRes, progRes] = await Promise.all([
          api.get(`/reading-plans/${pid}/items`, {
            params: { status: 'PENDING', take: 200 },
          }),
          api.get(`/reading-plans/${pid}/progress`),
        ]);
        const list = (itemsRes.data?.items ?? itemsRes.data ?? []) as PlanItem[];
        setItems(list);
        setProgress(progRes.data);
        setCurrentIdx(0);
        setReadingValue(null);
        setRemark('');
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setBusy(false);
      }
    },
    [message],
  );

  useEffect(() => {
    if (user) void loadPlans();
  }, [user, loadPlans]);

  useEffect(() => {
    if (planId) void loadItems(planId);
  }, [planId, loadItems]);

  const current = items[currentIdx];
  const done = progress ? progress.READ + progress.NO_READ + progress.SKIPPED : 0;

  const submit = useCallback(
    async (body: Record<string, unknown>) => {
      if (!current || !planId) return;
      setSubmitting(true);
      try {
        const res = await api.post(
          '/meter-readings',
          cleanBody({ planItemId: current.id, source: 'APP', ...body }),
          { headers: { 'Idempotency-Key': idemKey.current } },
        );
        const tasks = (res.data as { reviewTasks?: { reason: string }[] }).reviewTasks;
        if (tasks?.length) {
          message.warning(`已提交，触发 ${tasks.length} 个复核任务`);
        } else {
          message.success('已抄录');
        }
        idemKey.current = newIdemKey();
        const next = items.filter((i) => i.id !== current.id);
        setItems(next);
        setCurrentIdx(0);
        setReadingValue(null);
        setRemark('');
        const prog = await api.get(`/reading-plans/${planId}/progress`);
        setProgress(prog.data);
      } catch (err) {
        message.error(apiErrorText(err));
        idemKey.current = newIdemKey();
      } finally {
        setSubmitting(false);
      }
    },
    [current, items, message, planId],
  );

  const submitActual = () => {
    if (readingValue === null || readingValue === undefined) {
      message.warning('请输入本期读数');
      return;
    }
    void submit({ resultType: 'ACTUAL', readingValue, remark: remark || undefined });
  };

  const submitNoRead = async () => {
    const v = await noReadForm.validateFields();
    await submit({
      resultType: 'NO_READ',
      exceptionCode: v.exceptionCode,
      estimateQty: v.estimateQty,
      remark: v.remark,
    });
    setNoReadOpen(false);
    noReadForm.resetFields();
  };

  const planOptions = useMemo(
    () =>
      plans.map((p) => ({
        value: p.id,
        label: `${p.bookNo ?? ''} ${p.bookName ?? ''} · ${p.period} · ${p.status === 'OPEN' ? '未开始' : '进行中'}`,
      })),
    [plans],
  );

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (!hasPerm('metering:write')) {
    return (
      <div style={{ padding: 24 }}>
        <Empty description="无抄表录入权限（metering:write）" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '8px 12px 32px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 0',
        }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          抄表工作台
        </Typography.Title>
        <Space>
          <Typography.Text type="secondary">{user.name}</Typography.Text>
          <Button
            type="text"
            size="small"
            icon={<LogoutOutlined />}
            onClick={logout}
          />
        </Space>
      </div>

      <Card size="small" style={{ marginBottom: 8 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <Select
            style={{ width: '100%' }}
            size="large"
            placeholder="选择抄表计划（我的/未指派）"
            options={planOptions}
            value={planId}
            onChange={setPlanId}
            loading={busy && plans.length === 0}
            showSearch
            optionFilterProp="label"
          />
          {progress && (
            <div>
              <Space size={8} style={{ marginBottom: 4 }}>
                <Typography.Text type="secondary">
                  进度 {done}/{progress.total}
                </Typography.Text>
                <Tag color="orange">待抄 {progress.PENDING}</Tag>
                <Tag color="green">已抄 {progress.READ}</Tag>
                {progress.NO_READ > 0 && <Tag color="red">未抄见 {progress.NO_READ}</Tag>}
                <Button
                  type="text"
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => planId && loadItems(planId)}
                />
              </Space>
              <Progress
                percent={progress.total ? Math.round((done / progress.total) * 100) : 0}
                size="small"
                showInfo={false}
              />
            </div>
          )}
        </Space>
      </Card>

      {planId && !busy && items.length === 0 && (
        <Empty description="该计划无待抄项" style={{ marginTop: 40 }} />
      )}

      {current && (
        <Card
          size="small"
          title={
            <Space>
              <FieldNumberOutlined />#{current.seqNo}
              <Typography.Text strong>{current.accountNo}</Typography.Text>
              <Typography.Text>{current.customerName}</Typography.Text>
            </Space>
          }
          style={{ marginBottom: 8 }}
        >
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            <Typography.Text type="secondary">
              <EnvironmentOutlined /> {current.addr ?? '—'}
            </Typography.Text>
            <Space size={16}>
              <Typography.Text>
                表号 <Typography.Text strong>{current.meterNo ?? '—'}</Typography.Text>
              </Typography.Text>
              <Typography.Text>
                上期止度{' '}
                <Typography.Text strong>
                  {current.prevReadingValue ?? '—'}
                </Typography.Text>
              </Typography.Text>
            </Space>
            <InputNumber
              size="large"
              style={{ width: '100%', fontSize: 22 }}
              placeholder="输入本期读数"
              min={0}
              value={readingValue}
              onChange={(v) => setReadingValue(v)}
              inputMode="decimal"
              controls={false}
            />
            <Input
              placeholder="备注（选填）"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              maxLength={100}
            />
            <Space.Compact block>
              <Button
                type="primary"
                size="large"
                icon={<CheckOutlined />}
                style={{ flex: 1 }}
                loading={submitting}
                onClick={submitActual}
              >
                提交读数
              </Button>
              <Button
                size="large"
                danger
                icon={<WarningOutlined />}
                onClick={() => setNoReadOpen(true)}
              >
                无法抄见
              </Button>
            </Space.Compact>
          </Space>
        </Card>
      )}

      {items.length > 1 && (
        <Card size="small" title={`待抄队列（${items.length}）`}>
          <Space direction="vertical" style={{ width: '100%' }} size={4}>
            {items.map((it, idx) => (
              <div
                key={it.id}
                onClick={() => {
                  setCurrentIdx(idx);
                  setReadingValue(null);
                  setRemark('');
                }}
                style={{
                  padding: '8px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: idx === currentIdx ? '#e6f4ff' : '#fafafa',
                  border:
                    idx === currentIdx
                      ? '1px solid #91caff'
                      : '1px solid #f0f0f0',
                }}
              >
                <Space>
                  <Typography.Text type="secondary">#{it.seqNo}</Typography.Text>
                  <Typography.Text strong>{it.accountNo}</Typography.Text>
                  <Typography.Text>{it.customerName}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {it.addr}
                  </Typography.Text>
                </Space>
              </div>
            ))}
          </Space>
        </Card>
      )}

      <Modal
        title="无法抄见"
        open={noReadOpen}
        onOk={submitNoRead}
        okText="提交"
        confirmLoading={submitting}
        onCancel={() => setNoReadOpen(false)}
        destroyOnHidden
      >
        <Form form={noReadForm} layout="vertical">
          <Form.Item
            name="exceptionCode"
            label="异常原因"
            rules={[{ required: true, message: '请选择异常原因' }]}
          >
            <Select
              size="large"
              options={EXCEPTION_CODES.map((c) => ({
                value: c,
                label: enumLabel(EXCEPTION_CODE_LABELS, c),
              }))}
            />
          </Form.Item>
          <Form.Item name="estimateQty" label="预估水量（选填）">
            <Input inputMode="decimal" placeholder="如按上期水量预估可填" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
