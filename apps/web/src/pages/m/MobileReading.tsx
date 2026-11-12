import Select from '../../components/CopySelect';
import SmartSelect from '../../components/SmartSelect';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {App as AntdApp, Badge, Button, Card, Drawer, Empty, Form, Input, InputNumber, Modal, Progress, Segmented, Space, Spin, Statistic, Tag, Typography, Upload} from 'antd';
import {
  CameraOutlined,
  CheckOutlined,
  CloudUploadOutlined,
  EnvironmentOutlined,
  FieldNumberOutlined,
  InfoCircleOutlined,
  LogoutOutlined,
  ReloadOutlined,
  SearchOutlined,
  StepForwardOutlined,
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
import MobileActivate from './MobileActivate';
import { useAuth } from '../../auth/AuthContext';
import { cleanBody, enumLabel, USAGE_CATEGORY_LABELS } from '../common';
import { EXCEPTION_CODE_LABELS } from '../metering/common';
// OCR 识别已统一走服务端 /meter-readings/recognize，浏览器不再加载本地模型。

interface PlanRow {
  id: string;
  bookId: string;
  bookNo?: string | null;
  bookName?: string | null;
  period: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CLOSED';
  planType?: 'REGULAR' | 'SUPPLEMENT';
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
  phone?: string | null;
  usageCategory?: string | null;
  meterNo?: string | null;
  caliber?: string | null;
  locationRemark?: string | null;
  status: 'PENDING' | 'READ' | 'NO_READ' | 'SKIPPED';
  prevReadingValue?: string | null;
  completedReadingId?: string | null;
  completedReadingValue?: string | null;
}

interface ProgressRow {
  PENDING: number;
  READ: number;
  NO_READ: number;
  SKIPPED: number;
  total: number;
}

// R8-3：APP 抄表无论是否正常均须拍照（取消「非正常才拍」限制）。

/** 离线待上传队列项 —— localStorage 持久化，联网后手动/自动上传。
 *  url 缺省 /meter-readings；异常上报走 /service-orders。 */
interface QueuedReading {
  planItemId: string;
  url?: string;
  body: Record<string, unknown>;
  idemKey: string;
  queuedAt: string;
  accountNo?: string | null;
  seqNo?: number;
}

const queueKey = (tenant?: string | null, uid?: string) =>
  `mrq:${tenant ?? '-'}:${uid ?? '-'}`;

const loadQueue = (tenant: string | null | undefined, uid?: string): QueuedReading[] => {
  try {
    const raw = localStorage.getItem(queueKey(tenant, uid));
    const arr = raw ? (JSON.parse(raw) as QueuedReading[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};

const saveQueue = (tenant: string | null | undefined, uid: string | undefined, q: QueuedReading[]) => {
  localStorage.setItem(queueKey(tenant, uid), JSON.stringify(q));
};

/** 拍照 → canvas 压缩（最长边 1280，JPEG 0.7）→ dataURL。 */
const compressPhoto = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error('照片读取失败'));
    };
    img.src = URL.createObjectURL(file);
  });

const STATUS_TAG: Record<PlanItem['status'], { color: string; text: string }> = {
  PENDING: { color: 'orange', text: '待抄' },
  READ: { color: 'green', text: '已抄' },
  NO_READ: { color: 'red', text: '未抄见' },
  SKIPPED: { color: 'default', text: '已跳过' },
};





/**
 * 抄表工作台（H5）— 现场抄表员移动入口，挂 AdminLayout 外裸路由 /m/reading。
 * 按《抄表APP使用流程》实现：计划下载（更新数据）→ 顺序查表（续抄/跳过）→
 * 清单定位（搜索/漏抄/单只重抄 supersede）→ 水表信息查看与现场更正 →
 * 强制拍照（非户表全量、户表非正常查表）→ 离线队列手动/自动上传 → 抄表统计。
 * 业务口径全部走既有 /reading-plans + /meter-readings 接口（source=APP），
 * QC/异常/任务规则在服务端复用。
 */
export default function MobileReading() {
  const { user, tenantCode, loading, hasPerm, logout } = useAuth();
  const location = useLocation();
  const { message } = AntdApp.useApp();

  // 1028v2：抄表 / 立户上号 双工作面。
  const [mode, setMode] = useState<'reading' | 'activate' | 'report'>('reading');
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [planId, setPlanId] = useState<string>();
  const [items, setItems] = useState<PlanItem[]>([]);
  const [progress, setProgress] = useState<ProgressRow | null>(null);
  const [currentId, setCurrentId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [readingValue, setReadingValue] = useState<number | null>(null);
  const [remark, setRemark] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [ocr, setOcr] = useState<{
    value: string | null;
    confidence: number;
    method: string;
    message?: string;
  } | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const ocrReq = useRef(0);
  const [noReadOpen, setNoReadOpen] = useState(false);
  const [noReadForm] = Form.useForm<{ exceptionCode: string; estimateQty?: string; remark?: string }>();
  // 1103 项7：异常上报不弹窗——直跳「问题上报」分段并带入当前用户档案号。
  const [reportAccountNo, setReportAccountNo] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [reread, setReread] = useState<PlanItem | null>(null);
  const [rereadValue, setRereadValue] = useState<number | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'DONE'>('PENDING');
  const [search, setSearch] = useState('');
  const [queue, setQueue] = useState<QueuedReading[]>(() =>
    loadQueue(tenantCode, user?.id),
  );
  const idemKey = useRef(newIdemKey());

  const persistQueue = useCallback(
    (q: QueuedReading[]) => {
      setQueue(q);
      saveQueue(tenantCode, user?.id, q);
    },
    [tenantCode, user?.id],
  );

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
          api.get(`/reading-plans/${pid}/items`, { params: { take: 500 } }),
          api.get(`/reading-plans/${pid}/progress`),
        ]);
        const list = (itemsRes.data?.items ?? itemsRes.data ?? []) as PlanItem[];
        setItems(list);
        setProgress(progRes.data);
        setReadingValue(null);
        setRemark('');
        setPhoto(null);
        setOcr(null);
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

  const pending = useMemo(() => items.filter((i) => i.status === 'PENDING'), [items]);
  /** 顺序查表当前项：显式选中的待抄项，否则第一只待抄（续抄）。 */
  const current =
    pending.find((i) => i.id === currentId) ?? pending[0];
  const done = progress ? progress.READ + progress.NO_READ + progress.SKIPPED : 0;
  // R8-3：APP 抄表无论是否正常均须拍照（取消「非正常才拍」限制）。
  const photoRequired = true;

  const filteredItems = useMemo(() => {
    let list = items;
    if (filter === 'PENDING') list = list.filter((i) => i.status === 'PENDING');
    if (filter === 'DONE') list = list.filter((i) => i.status !== 'PENDING');
    const q = search.trim();
    if (q) {
      list = list.filter((i) =>
        [i.accountNo, i.customerName, i.addr, i.phone, i.meterNo]
          .filter(Boolean)
          .some((v) => String(v).includes(q)),
      );
    }
    return list;
  }, [items, filter, search]);

  const enqueue = useCallback(
    (item: PlanItem, body: Record<string, unknown>, url?: string) => {
      persistQueue([
        ...queue,
        {
          planItemId: item.id,
          url,
          body: cleanBody({ planItemId: item.id, source: 'APP', ...body }),
          idemKey: idemKey.current,
          queuedAt: new Date().toISOString(),
          accountNo: item.accountNo,
          seqNo: item.seqNo,
        },
      ]);
    },
    [queue, persistQueue],
  );

  const flushQueue = useCallback(async () => {
    if (!queue.length) {
      message.info('无待上传数据');
      return;
    }
    let rest = [...queue];
    let ok = 0;
    let bizFail = 0;
    for (const q of queue) {
      try {
        await api.post(q.url ?? '/meter-readings', q.body, {
          headers: { 'Idempotency-Key': q.idemKey },
        });
        ok += 1;
        rest = rest.filter((r) => r !== q);
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status && status < 500) {
          // 业务错误（如已抄/超差）：不重试，丢弃并计数
          bizFail += 1;
          rest = rest.filter((r) => r !== q);
        } else {
          break; // 网络仍不通，保留剩余
        }
      }
    }
    persistQueue(rest);
    if (ok || bizFail) {
      message.success(`已上传 ${ok} 条${bizFail ? `，${bizFail} 条被服务端拒绝已丢弃` : ''}`);
      if (planId) void loadItems(planId);
    } else {
      message.warning('网络不通，数据保留待传');
    }
  }, [queue, planId, loadItems, persistQueue, message]);

  /** 联网自动上传（文档第五步：有网自动上传）。 */
  useEffect(() => {
    const onOnline = () => void flushQueue();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flushQueue]);

  const submit = useCallback(
    async (body: Record<string, unknown>) => {
      if (!current || !planId) return;
      setSubmitting(true);
      try {
        if (navigator.onLine === false) throw new Error('OFFLINE');
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
        setCurrentId(undefined);
        setReadingValue(null);
        setRemark('');
        setPhoto(null);
        setOcr(null);
        const [itemsRes, progRes] = await Promise.all([
          api.get(`/reading-plans/${planId}/items`, { params: { take: 500 } }),
          api.get(`/reading-plans/${planId}/progress`),
        ]);
        setItems((itemsRes.data?.items ?? itemsRes.data ?? []) as PlanItem[]);
        setProgress(progRes.data);
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (!status || (err as Error).message === 'OFFLINE') {
          enqueue(current, body);
          message.warning('已离线保存，联网后点「上传」补传');
          setCurrentId(undefined);
          setReadingValue(null);
          setRemark('');
          setPhoto(null);
          setOcr(null);
        } else {
          message.error(apiErrorText(err));
        }
        idemKey.current = newIdemKey();
      } finally {
        setSubmitting(false);
      }
    },
    [current, planId, message, enqueue],
  );

  const submitActual = () => {
    if (readingValue === null || readingValue === undefined) {
      message.warning('请输入本期读数');
      return;
    }
    if (photoRequired && !photo) {
      message.warning('抄表必须拍照留底');
      return;
    }
    void submit({
      resultType: 'ACTUAL',
      readingValue,
      photoRef: photo ?? undefined,
      remark: remark || undefined,
    });
  };

  const submitNoRead = async () => {
    const v = await noReadForm.validateFields();
    if (!photo) {
      message.warning('非正常查表必须拍照留底');
      return;
    }
    await submit({
      resultType: 'NO_READ',
      exceptionCode: v.exceptionCode,
      estimateQty: v.estimateQty,
      photoRef: photo ?? undefined,
      remark: v.remark,
    });
    setNoReadOpen(false);
    noReadForm.resetFields();
  };

  const submitReread = async () => {
    if (!reread?.completedReadingId || rereadValue === null) return;
    setSubmitting(true);
    try {
      await api.post(`/meter-readings/${reread.completedReadingId}/supersede`, {
        readingValue: rereadValue,
      });
      message.success('重抄已提交（原读数保留为历史）');
      setReread(null);
      setRereadValue(null);
      if (planId) void loadItems(planId);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const skipCurrent = () => {
    if (!current) return;
    const idx = pending.findIndex((i) => i.id === current.id);
    const next = pending[idx + 1] ?? pending[0];
    setCurrentId(next?.id);
    setReadingValue(null);
    setRemark('');
    setPhoto(null);
    setOcr(null);
  };

  const jumpTo = (it: PlanItem) => {
    if (it.status === 'PENDING') {
      setCurrentId(it.id);
      setReadingValue(null);
      setRemark('');
      setPhoto(null);
      setOcr(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (it.completedReadingId) {
      setReread(it);
      setRereadValue(
        it.completedReadingValue ? Number(it.completedReadingValue) : null,
      );
    }
  };

  const planOptions = useMemo(
    () =>
      plans.map((p) => ({
        value: p.id,
        // X5：追加计划醒目紫标，与 Web 端一致
        label: `${p.planType === 'SUPPLEMENT' ? '【追加】' : ''}${p.bookNo ?? ''} ${p.bookName ?? ''} · ${p.period} · ${p.status === 'OPEN' ? '未开始' : '进行中'}`,
      })),
    [plans],
  );

  const statsByCaliber = useMemo(() => {
    const m = new Map<string, { total: number; done: number }>();
    for (const i of items) {
      const k = i.caliber ?? '未标口径';
      const row = m.get(k) ?? { total: 0, done: 0 };
      row.total += 1;
      if (i.status !== 'PENDING') row.done += 1;
      m.set(k, row);
    }
    return [...m.entries()];
  }, [items]);

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
          <Badge count={queue.length} size="small">
            <Button
              size="small"
              icon={<CloudUploadOutlined />}
              onClick={() => void flushQueue()}
            >
              上传
            </Button>
          </Badge>
          <Typography.Text type="secondary">{user.name}</Typography.Text>
          <Button type="text" size="small" icon={<LogoutOutlined />} onClick={logout} />
        </Space>
      </div>

      {/* R8 三模块：抄表作业 / 问题上报 / 装表上户 */}
      <Segmented
        block
        size="large"
        style={{ margin: '4px 0 10px' }}
        value={mode}
        onChange={(v) => setMode(v as 'reading' | 'activate' | 'report')}
        options={[
          { value: 'reading', label: '抄表作业' },
          { value: 'report', label: '问题上报' },
          { value: 'activate', label: '装表上户' },
        ]}
      />
      {mode === 'report' && <MobileReport initialAccountNo={reportAccountNo} />}
      {mode === 'activate' && <MobileActivate />}
      {mode === 'reading' && (
      <>
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
            labelRender={(p) => planOptions.find((o) => o.value === p.value)?.label ?? String(p.label ?? '')}
            optionRender={(opt) => {
              const p = plans.find((x) => x.id === opt.value);
              return (
                <Space size={4}>
                  {p?.planType === 'SUPPLEMENT' && <Tag color="purple">追加</Tag>}
                  <span>{opt.label as string}</span>
                </Space>
              );
            }}
          />
          {progress && (
            <div>
              <Space size={8} style={{ marginBottom: 4 }} wrap>
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
          <Space.Compact block>
            <Button
              icon={<ReloadOutlined />}
              style={{ flex: 1 }}
              loading={busy}
              onClick={() => {
                void loadPlans();
                if (planId) void loadItems(planId);
              }}
            >
              更新数据
            </Button>
            <Button style={{ flex: 1 }} onClick={() => setStatsOpen(true)} disabled={!planId}>
              抄表统计
            </Button>
          </Space.Compact>
        </Space>
      </Card>

      {planId && !busy && pending.length === 0 && (
        <Empty description="该计划无待抄项（漏抄=0）" style={{ marginTop: 40 }} />
      )}

      {current && (
        <Card
          size="small"
          title={
            <Space>
              <FieldNumberOutlined />#{current.seqNo}
              <Typography.Text strong>{current.accountNo}</Typography.Text>
              <Typography.Text>{current.customerName}</Typography.Text>
              <Button
                type="text"
                size="small"
                icon={<InfoCircleOutlined />}
                onClick={() => setInfoOpen(true)}
              />
            </Space>
          }
          extra={
            <Tag color={photoRequired ? 'red' : 'default'}>
              {USAGE_CATEGORY_LABELS[current.usageCategory ?? ''] ?? current.usageCategory ?? '—'}
            </Tag>
          }
          style={{ marginBottom: 8 }}
        >
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            <Typography.Text type="secondary">
              <EnvironmentOutlined /> {current.addr ?? '—'}
            </Typography.Text>
            <Space size={16} wrap>
              <Typography.Text>
                表号 <Typography.Text strong>{current.meterNo ?? '—'}</Typography.Text>
              </Typography.Text>
              <Typography.Text>
                口径 <Typography.Text strong>{current.caliber ?? '—'}</Typography.Text>
              </Typography.Text>
              <Typography.Text>
                上期止度{' '}
                <Typography.Text strong>{current.prevReadingValue ?? '—'}</Typography.Text>
              </Typography.Text>
            </Space>
            <Upload
              accept="image/*"
              showUploadList={false}
              beforeUpload={(file) => {
                void compressPhoto(file)
                  .then((dataUrl) => {
                    setPhoto(dataUrl);
                    setOcr(null);
                    setOcrBusy(true);
                    const reqId = ++ocrReq.current;
                    const applyResult = (res: {
                      value: string | null;
                      confidence: number;
                      method: string;
                      message?: string;
                    }) => {
                      if (reqId !== ocrReq.current) return;
                      setOcr(res);
                      // 低置信度不预填，只提示人工核对——避免旧兜底路径写入错值
                      if (res.value !== null && res.confidence >= 55) {
                        const n = Number(res.value);
                        if (Number.isFinite(n)) setReadingValue((v) => v ?? n);
                      }
                    };
                    // 识别统一走服务端（本地管线+多模态兜底在服务端完成）——
                    // 浏览器不再加载 opencv/ocr 模型，低端设备不会因内存不足闪退。
                    api
                      .post<{
                        value: string | null;
                        confidence: number;
                        method: string;
                        message?: string;
                      }>('/meter-readings/recognize', {
                        image: dataUrl,
                        prev: Number(current.prevReadingValue) || undefined,
                      }, {
                        // 服务端本地管线上限 ~25s + LLM 兜底 ~75s，不能用
                        // 全局 15s 默认超时——否则本地慢时移动端必然误判失败。
                        timeout: 100_000,
                      })
                      .then((r) => {
                        if (r.data?.value !== undefined) applyResult(r.data);
                        else if (reqId === ocrReq.current) {
                          setOcr({ value: null, confidence: 0, method: 'none' });
                        }
                      })
                      .catch(() => {
                        if (reqId === ocrReq.current) return;
                        setOcr({ value: null, confidence: 0, method: 'none', message: '识别服务不可用，请人工录入' });
                      })
                      .finally(() => {
                        if (reqId === ocrReq.current) setOcrBusy(false);
                      });
                  })
                  .catch(() => message.error('照片读取失败'));
                return false;
              }}
            >
              <Button
                icon={<CameraOutlined />}
                danger={photoRequired && !photo}
                type={photo ? 'primary' : 'default'}
                ghost={!!photo}
                block
              >
                {photo ? '已拍照（点击重拍）' : photoRequired ? '拍照（必拍）' : '拍照（选填）'}
              </Button>
            </Upload>
            {photo && (
              <img
                src={photo}
                alt="表底照片"
                style={{ width: '100%', borderRadius: 6, maxHeight: 160, objectFit: 'cover' }}
              />
            )}
            {ocrBusy && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                正在识别表底读数…
              </Typography.Text>
            )}
            {!ocrBusy && ocr && (
              <Typography.Text
                style={{ fontSize: 12 }}
                type={ocr.value !== null && ocr.confidence >= 55 ? 'success' : 'warning'}
              >
                {ocr.value !== null && ocr.confidence >= 55
                  ? `识别参考 ${ocr.value}（置信度 ${ocr.confidence}%${ocr.method === 'paddle-pointer' ? '，本地指针表推断' : ocr.method === 'llm' ? '，AI辅助识别' : ocr.method === 'pointer' ? '，指针表推断' : ocr.method === 'paddle-roller' ? '，本地字轮识别' : ''}），请核对表底后提交`
                  : ocr.value !== null
                    ? `识别不确定（疑似 ${ocr.value}，置信度 ${ocr.confidence}%），未预填，请人工核对录入`
                    : (ocr.message ?? '未能识别读数，请人工录入')}
              </Typography.Text>
            )}
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
                style={{ flex: 2 }}
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
              <Button
                size="large"
                icon={<StepForwardOutlined />}
                onClick={skipCurrent}
                disabled={pending.length <= 1}
              >
                跳过
              </Button>
            </Space.Compact>
            <Button
              size="small"
              type="dashed"
              icon={<WarningOutlined />}
              onClick={() => {
                setReportAccountNo(current?.accountNo ?? '');
                setMode('report');
              }}
              block
            >
              现场异常上报（跳「问题上报」，用户档案号已带入）
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              顺序查表：提交后自动跳下一只；跳过可稍后回抄。
            </Typography.Text>
          </Space>
        </Card>
      )}

      {planId && items.length > 0 && (
        <Card
          size="small"
          title="任务清单（点击定位）"
          extra={
            <Segmented
              size="small"
              value={filter}
              onChange={(v) => setFilter(v as typeof filter)}
              options={[
                { label: '待抄', value: 'PENDING' },
                { label: '已抄', value: 'DONE' },
                { label: '全部', value: 'ALL' },
              ]}
            />
          }
        >
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            <Input
              allowClear
              size="small"
              prefix={<SearchOutlined />}
              placeholder="用户档案号 / 客户名 / 地址 / 电话 / 表号"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {filteredItems.slice(0, 100).map((it) => (
              <div
                key={it.id}
                onClick={() => jumpTo(it)}
                style={{
                  padding: '8px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: it.id === current?.id ? '#e6f4ff' : '#fafafa',
                  border:
                    it.id === current?.id ? '1px solid #91caff' : '1px solid #f0f0f0',
                }}
              >
                <Space wrap>
                  <Typography.Text type="secondary">#{it.seqNo}</Typography.Text>
                  <Typography.Text strong>{it.accountNo}</Typography.Text>
                  <Typography.Text>{it.customerName}</Typography.Text>
                  <Tag color={STATUS_TAG[it.status].color} style={{ marginInlineEnd: 0 }}>
                    {STATUS_TAG[it.status].text}
                    {it.completedReadingValue ? ` ${it.completedReadingValue}` : ''}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {it.addr}
                  </Typography.Text>
                </Space>
              </div>
            ))}
            {filteredItems.length > 100 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                仅显示前 100 条，请用搜索缩小范围
              </Typography.Text>
            )}
          </Space>
        </Card>
      )}

      {/* 水表基础信息查看与现场更正（文档「其他功能 1」） */}
      <Drawer
        title="水表 / 用户基础信息"
        placement="bottom"
        height="72%"
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
      >
        {current && (
          <FieldContactForm
            key={current.id}
            item={current}
            onSaved={() => {
              setInfoOpen(false);
              if (planId) void loadItems(planId);
            }}
          />
        )}
      </Drawer>

      {/* 抄表统计（按口径分组） */}
      <Drawer
        title="抄表统计"
        placement="bottom"
        height="60%"
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Card size="small" title="本册进度">
            <Space size={24} wrap>
              <Statistic title="总数" value={progress?.total ?? 0} />
              <Statistic title="已抄" value={progress?.READ ?? 0} />
              <Statistic title="未抄见" value={progress?.NO_READ ?? 0} />
              <Statistic title="待抄" value={progress?.PENDING ?? 0} />
            </Space>
          </Card>
          <Card size="small" title="按口径分组">
            <Space direction="vertical" style={{ width: '100%' }} size={4}>
              {statsByCaliber.map(([cal, r]) => (
                <Space key={cal} style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Typography.Text>{cal}</Typography.Text>
                  <Typography.Text type="secondary">
                    已抄 {r.done} / 共 {r.total}
                  </Typography.Text>
                </Space>
              ))}
            </Space>
          </Card>
          {queue.length > 0 && (
            <Card size="small" title={`待上传（${queue.length}）`}>
              {queue.map((q) => (
                <Typography.Text key={q.idemKey} type="secondary" style={{ fontSize: 12, display: 'block' }}>
                  #{q.seqNo} {q.accountNo} · {new Date(q.queuedAt).toLocaleTimeString()}
                </Typography.Text>
              ))}
            </Card>
          )}
        </Space>
      </Drawer>

      {/* 单只重抄（supersede，原数据保留） */}
      <Modal
        title={`重抄 #${reread?.seqNo} ${reread?.accountNo ?? ''}`}
        open={!!reread}
        onOk={submitReread}
        okText="提交重抄"
        confirmLoading={submitting}
        onCancel={() => setReread(null)}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <Typography.Text type="secondary">
            原读数 {reread?.completedReadingValue ?? '—'} 保留为历史，新读数记为更正行。
          </Typography.Text>
          <InputNumber
            size="large"
            style={{ width: '100%' }}
            placeholder="输入更正后读数"
            min={0}
            value={rereadValue}
            onChange={(v) => setRereadValue(v)}
            inputMode="decimal"
            controls={false}
          />
        </Space>
      </Modal>

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
            <SmartSelect
              size="large"
              otherFieldName="otherText"
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
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            非正常查表必须拍照（请先关闭本弹窗拍照再提交）。
          </Typography.Text>
        </Form>
      </Modal>

      </>
      )}
    </div>
  );
}

/** 现场更正表单：地址 / 联系电话 / 表位说明 → PATCH field-contact。 */
function FieldContactForm({
  item,
  onSaved,
}: {
  item: PlanItem;
  onSaved: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ addr?: string; phone?: string; locationRemark?: string }>();
  const [saving, setSaving] = useState(false);
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Card size="small">
        <Space direction="vertical" size={4}>
          <Typography.Text>用户档案号：<Typography.Text strong>{item.accountNo}</Typography.Text></Typography.Text>
          <Typography.Text>客户：{item.customerName ?? '—'}</Typography.Text>
          <Typography.Text>表号：{item.meterNo ?? '—'}　口径：{item.caliber ?? '—'}</Typography.Text>
          <Typography.Text>用水类别：{USAGE_CATEGORY_LABELS[item.usageCategory ?? ''] ?? item.usageCategory ?? '—'}</Typography.Text>
          <Typography.Text>上期止度：{item.prevReadingValue ?? '—'}</Typography.Text>
        </Space>
      </Card>
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          addr: item.addr ?? '',
          phone: item.phone ?? '',
          locationRemark: item.locationRemark ?? '',
        }}
      >
        <Form.Item name="addr" label="地址">
          <Input maxLength={200} />
        </Form.Item>
        <Form.Item name="phone" label="联系电话">
          <Input inputMode="tel" maxLength={30} />
        </Form.Item>
        <Form.Item name="locationRemark" label="表位说明">
          <Input maxLength={100} placeholder="如：院内水井 / 厨房管道井" />
        </Form.Item>
        <Button
          type="primary"
          block
          loading={saving}
          onClick={async () => {
            const v = form.getFieldsValue();
            setSaving(true);
            try {
              await api.patch(
                `/water-accounts/${item.waterAccountId}/field-contact`,
                cleanBody(v),
              );
              message.success('已保存，随抄表数据同步');
              onSaved();
            } catch (err) {
              message.error(apiErrorText(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          保存更正
        </Button>
      </Form>
    </Space>
  );
}

/** R8 独立「问题上报」模块：四类问题——表务工单（注册类型）或违章核查。 */
function MobileReport({ initialAccountNo }: { initialAccountNo?: string }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ accountNo: string; reportType: string; violationType?: string; desc?: string }>();
  // 1103 项7：从抄表作业跳入时自动带入当前用户档案号，无需重新选择。
  useEffect(() => {
    if (initialAccountNo) form.setFieldsValue({ accountNo: initialAccountNo });
  }, [initialAccountNo, form]);
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 上报类型 → 后端通道：真实 SERVICE_TYPES 建工单；VIOLATION 走违章核查流程
  const REPORT_TYPES = [
    { value: 'FAULT', label: '水表故障/损坏（抢修工单）' },
    { value: 'METER_GROUP_CLEANING', label: '表井污浊/清洁（清洁工单）' },
    { value: 'SITE_RECTIFICATION', label: '现场整改（整改工单）' },
    { value: 'VIOLATION', label: '疑似违章用水（稽查核查）' },
  ] as const;
  const submit = async () => {
    const v = await form.validateFields();
    setBusy(true);
    try {
      const wa = await api.get<{ id: string; accountNo: string }[]>('/water-accounts', {
        params: { accountNo: v.accountNo.trim(), take: 1 },
      });
      if (!wa.data.length) { message.error('用户档案号不存在'); return; }
      const waId = wa.data[0].id;
      if (v.reportType === 'VIOLATION') {
        // 疑似违章→既有违章核查流程（sourceType=FIELD 抄表员上报）
        await api.post('/violations', {
          sourceType: 'FIELD',
          waterAccountId: waId,
          violationType: v.violationType ?? 'TAMPER',
          occurredDate: new Date().toISOString().slice(0, 10),
          description: v.desc ?? '',
          photoRefs: photo ? [photo] : [],
        });
        message.success('疑似违章已上报，稽查岗将现场核实');
      } else {
        await api.post('/service-orders', {
          waterAccountId: waId,
          serviceType: v.reportType,
          reason: `[现场上报] ${v.desc ?? ''}`.trim(),
          payload: photo ? { photoRefs: [photo] } : undefined,
        });
        message.success('问题已上报，工单已生成');
      }
      form.resetFields();
      setPhoto(null);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card size="small" title="现场问题上报">
      <Form form={form} layout="vertical">
        <Form.Item name="accountNo" label="关联用户档案号" rules={[{ required: true, message: '请输入用户档案号' }]}>
          <Input placeholder="输入用户档案号" />
        </Form.Item>
        <Form.Item name="reportType" label="问题类型" rules={[{ required: true, message: '请选择类型' }]}>
          <Select options={[...REPORT_TYPES]} />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(a, b) => a.reportType !== b.reportType}>
          {({ getFieldValue }) => getFieldValue('reportType') === 'VIOLATION' ? (
            <Form.Item name="violationType" label="违章类型" initialValue="TAMPER">
              <Select options={[
                { value: 'TAMPER', label: '破坏计量/铅封' },
                { value: 'PRIVATE_CONN', label: '私接管线' },
                { value: 'THEFT', label: '偷水' },
                { value: 'SEAL_BROKEN', label: '封条破损' },
              ]} />
            </Form.Item>
          ) : null}
        </Form.Item>
        <Form.Item name="desc" label="问题描述" rules={[{ required: true, message: '请填写现场描述' }]}>
          <Input.TextArea rows={3} placeholder="描述现场情况（位置、现象）" />
        </Form.Item>
        <Upload
          accept="image/*" capture="environment" maxCount={1} showUploadList={false}
          customRequest={async ({ file, onSuccess }) => {
            try { setPhoto(await compressPhoto(file as File)); onSuccess?.({}); }
            catch { message.error('照片处理失败'); }
          }}
        >
          <Button block danger={!photo}>{photo ? '已拍照（点击重拍）' : '拍照留底'}</Button>
        </Upload>
        <Button type="primary" block size="large" style={{ marginTop: 12 }}
          loading={busy} onClick={() => void submit()}>
          提交上报
        </Button>
      </Form>
    </Card>
  );
}
