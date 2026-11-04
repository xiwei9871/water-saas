import Select from '../../components/CopySelect';
import {
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp, Button, Card, DatePicker, Form, Input, InputNumber,
  Modal, Space, Tag, Typography, Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type { Staff } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import Table from '../../components/PageTable';

interface ZoneRow {
  id: string;
  zoneNo: string;
  readerId: string | null;
  readerName?: string | null;
  status: 'ACTIVE' | 'DISABLED';
  remark?: string | null;
}

interface CalendarResp {
  period: string;
  reserveDays: number;
  exceptions: { day: string; kind: 'HOLIDAY' | 'WORKDAY' }[];
  segments: { segNo: string; date: string }[];
}

interface ZoneFormValues {
  zoneNo: string;
  readerId?: string;
  remark?: string;
}

/** R14 区号管理：区号—抄表员绑定维护 + R2 归集模式 + R3 工作日历。 */
export default function ReaderZones() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('iam:write') || hasPerm('metering:write');

  const [rows, setRows] = useState<ZoneRow[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [cal, setCal] = useState<CalendarResp | null>(null);
  const [genRuns, setGenRuns] = useState<{ id: string; runDate: string; planDate: string | null; segNo: string | null; status: string; generated: number; error: string | null; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; zone: ZoneRow } | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ZoneFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [z, c, g] = await Promise.all([
        api.get<ZoneRow[]>('/reading-zones'),
        api.get<CalendarResp>('/metering/calendar'),
        api.get<typeof genRuns>('/reading-plans/gen-runs', { params: { take: 10 } }).catch(() => ({ data: [] as typeof genRuns })),
      ]);
      setRows(z.data);
      setCal(c.data);
      setGenRuns(g.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
    api.get<Staff[]>('/iam/staff', { params: { take: 500 } })
      .then((r) => setStaff(r.data))
      .catch(() => undefined);
  }, [load]);

  const staffOptions = staff.map((s) => ({ value: s.id, label: `${s.name}（${s.login}）` }));

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      if (modal?.mode === 'edit') {
        await api.patch(`/reading-zones/${modal.zone.id}`, {
          readerId: v.readerId ?? null,
          status: 'ACTIVE',
          remark: v.remark ?? null,
        });
        message.success('绑定已更新');
      } else {
        await api.post('/reading-zones', {
          zoneNo: v.zoneNo.trim().padStart(2, '0'),
          readerId: v.readerId ?? null,
          remark: v.remark ?? null,
        });
        message.success('区号已绑定');
      }
      setModal(null);
      form.resetFields();
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const unbind = async (z: ZoneRow) => {
    try {
      await api.patch(`/reading-zones/${z.id}`, { readerId: null });
      message.success(`区号 ${z.zoneNo} 已解绑停用`);
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const saveConfig = async (patch: Record<string, unknown>) => {
    try {
      await api.post('/metering/calendar/config', patch);
      message.success('参数已保存');
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const addException = async (d: Dayjs | null, kind: 'HOLIDAY' | 'WORKDAY') => {
    if (!d) return;
    try {
      await api.post('/metering/calendar', { day: d.format('YYYY-MM-DD'), kind });
      message.success('已登记');
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const columns: ColumnsType<ZoneRow> = [
    { title: '区号', dataIndex: 'zoneNo', width: 90, render: (v: string) => <Tag color="blue">{v}</Tag> },
    {
      title: '绑定抄表员', dataIndex: 'readerName',
      render: (_, r) => (r.zoneNo === '111' ? '远传（不派人工）' : r.readerName ?? '—'),
    },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: string) => <Tag color={v === 'ACTIVE' ? 'green' : 'default'}>{v === 'ACTIVE' ? '启用' : '停用'}</Tag>,
    },
    { title: '备注', dataIndex: 'remark' },
    {
      title: '操作', key: 'op', width: 160,
      render: (_, r) => canWrite && (
        <Space>
          <Button size="small" onClick={() => { setModal({ mode: 'edit', zone: r }); form.setFieldsValue({ zoneNo: r.zoneNo, readerId: r.readerId ?? undefined, remark: r.remark ?? '' }); }}>变更</Button>
          {r.zoneNo !== '111' && (
            <Button size="small" onClick={() => void openPatterns(r.zoneNo)}>路线</Button>
          )}
          {r.status === 'ACTIVE' && r.zoneNo !== '111' && (
            <Button size="small" danger onClick={() => void unbind(r)}>解绑</Button>
          )}
        </Space>
      ),
    },
  ];

  // ---- R15 路线模式管理：保存当前顺序/应用/设默认/删除 ----
  interface Pattern {
    id: string;
    name: string;
    isDefault: boolean;
    entries: { waterAccountId: string; routeKey: number }[];
  }
  const [patZone, setPatZone] = useState<string | null>(null);
  const [patRows, setPatRows] = useState<Pattern[]>([]);
  const [patBusy, setPatBusy] = useState(false);
  const [patName, setPatName] = useState('');
  const loadPatterns = async (zoneNo: string) => {
    const r = await api.get<Pattern[]>('/route-patterns', { params: { zoneNo } });
    setPatRows(r.data);
  };
  const openPatterns = async (zoneNo: string) => {
    setPatZone(zoneNo);
    try { await loadPatterns(zoneNo); } catch (err) { message.error(apiErrorText(err)); }
  };
  const patAction = async (fn: () => Promise<unknown>, ok: string) => {
    setPatBusy(true);
    try { await fn(); message.success(ok); await loadPatterns(patZone!); }
    catch (err) { message.error(apiErrorText(err)); }
    finally { setPatBusy(false); }
  };
  const savePattern = () => patAction(async () => {
    await api.post('/route-patterns', { zoneNo: patZone, name: patName.trim() });
    setPatName('');
  }, '已按当前 routeKey 顺序保存模式');
  const applyPattern = (id: string) => patAction(async () => {
    const r = await api.post<{ applied: number }>(`/route-patterns/${id}/apply`);
    message.info(`已应用到 ${r.data.applied} 户`);
  }, '模式已应用');
  const setDefaultPattern = (id: string) => patAction(
    () => api.post(`/route-patterns/${id}/default`), '已设默认');
  const removePattern = (id: string) => patAction(
    () => api.delete(`/route-patterns/${id}`), '已删除');

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card
        title="区号管理（区号—抄表员绑定）"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} />
            {canWrite && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => { setModal({ mode: 'create' }); form.resetFields(); }}>
                新增绑定
              </Button>
            )}
          </Space>
        }
      >
        <Table rowKey="id" loading={loading} columns={columns} dataSource={rows} pagination={false} size="small" />
      </Card>

      <Card title={<Space><SettingOutlined />抄表参数（租户）</Space>} size="small">
        <Space direction="vertical" size={8}>
          <Typography.Text type="secondary">
            归集模式：统一「区段管理」——每个用户必有「区号 + 段号」；一抄表员一册的小公司用区内 1 段（段号 01）即可。
          </Typography.Text>
          <Space>
            <Typography.Text>月末预留工作日（不排抄表）：</Typography.Text>
            <InputNumber
              min={6} max={7} value={cal?.reserveDays ?? 6} disabled={!canWrite}
              onChange={(v) => v && void saveConfig({ reserveDays: v })}
            />
          </Space>
          <Typography.Text type="secondary">
            当月抄表段表：{cal?.segments.map((s) => `段${s.segNo}=${s.date.slice(5)}`).join('，') || '—'}
          </Typography.Text>
        </Space>
      </Card>

      <Card title="工作日历例外（节假日 / 调休上班日）" size="small">
        <Space direction="vertical" size={8}>
          {canWrite && (
            <Space wrap>
              <DatePicker
                placeholder="选择日期登记节假日"
                onChange={(d) => void addException(d, 'HOLIDAY')}
              />
              <DatePicker
                placeholder="选择日期登记调休上班日"
                onChange={(d) => void addException(d, 'WORKDAY')}
              />
              {/* 1104 遗留核查：法定节假日批量导入（CSV 两列 日期,类型）。
                  手动例外 > 内置法定日历 > 周一~五；clearYear 可清空该年手动例外重导。 */}
              <Upload accept=".csv,.txt" maxCount={1} showUploadList={false}
                customRequest={async ({ file, onSuccess, onError }) => {
                  try {
                    const text = await (file as File).text();
                    const days = text.split(/\r?\n/)
                      .map((l) => l.trim())
                      .filter((l) => l && !/^日期/i.test(l))
                      .map((l) => {
                        const [day, kind, name] = l.split(/[\t,，]/).map((x) => x.trim());
                        return { day, kind, name };
                      });
                    if (!days.length) { message.error('CSV 无有效行（格式：YYYY-MM-DD,HOLIDAY|WORKDAY）'); return; }
                    const clearYear = /clearYear=(\d{4})/.exec(location.hash)?.[1];
                    const res = await api.post<{ imported: number; cleared: number; errors: { index: number; day?: string; reason: string }[] }>(
                      '/metering/calendar/import',
                      { days, ...(clearYear ? { clearYear: Number(clearYear) } : {}) },
                    );
                    const { imported, cleared, errors } = res.data;
                    message.success(`导入 ${imported} 条${cleared ? `，清空 ${cleared}` : ''}${errors.length ? `，格式错误 ${errors.length} 行` : ''}`);
                    if (errors.length) {
                      Modal.warning({
                        title: '部分行未导入',
                        content: errors.slice(0, 10).map((e) => `第 ${e.index + 1} 行（${e.day ?? '空'}）：${e.reason}`).join('\n'),
                      });
                    }
                    void load();
                    onSuccess?.({});
                  } catch (err) { onError?.(err as Error); message.error(apiErrorText(err)); }
                }}
              >
                <Button size="small">导入节假日 CSV</Button>
              </Upload>
            </Space>
          )}
          <Space wrap>
            {(cal?.exceptions ?? []).map((e) => (
              <Tag key={e.day} color={e.kind === 'HOLIDAY' ? 'red' : 'green'}
                closable={canWrite}
                onClose={async () => { await api.delete(`/metering/calendar/${e.day}`); void load(); }}>
                {e.day} {e.kind === 'HOLIDAY' ? '休' : '班'}
              </Tag>
            ))}
            {(cal?.exceptions.length ?? 0) === 0 && (
              <Typography.Text type="secondary">无手动例外——默认按国家法定工作日历（节假日不排/调休上班日排），例外未覆盖的日期按周一至周五</Typography.Text>
            )}
          </Space>
        </Space>
      </Card>

      {/* 1104-W6/R5：前一工作日 18–24 自动生成次日计划——运行记录可视化。 */}
      <Card title="自动生成运行记录（前一工作日 18–24 生成次日计划）" size="small">
        {genRuns.length === 0 ? (
          <Typography.Text type="secondary">
            暂无运行记录——需在服务配置 CRON_TENANT_IDS 启用定时生成；亦可手动「生成计划」兜底
          </Typography.Text>
        ) : (
          <Space wrap size={6}>
            {genRuns.map((r) => (
              <Tag key={r.id}
                color={r.status === 'OK' ? 'green' : r.status === 'FAILED' ? 'red' : 'default'}
                title={r.error ?? undefined}>
                {(r.runDate ?? '').slice(0, 10)} {r.planDate ? `→${r.planDate.slice(0, 10)}` : ''}
                {r.segNo ? ` 段${r.segNo}` : ''} {r.status}{r.generated ? ` ×${r.generated}` : ''}
              </Tag>
            ))}
          </Space>
        )}
      </Card>

      <Modal
        title={modal?.mode === 'edit' ? `变更区号 ${modal.zone.zoneNo} 绑定` : '新增区号绑定'}
        open={!!modal} onOk={() => void submit()} onCancel={() => setModal(null)}
        confirmLoading={saving} destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {modal?.mode === 'create' && (
            <Form.Item name="zoneNo" label="区号" rules={[{ required: true, message: '请输入两位区号（如 01）' }]}>
              <Input placeholder="01 ~ 99（111 为远传保留）" maxLength={3} />
            </Form.Item>
          )}
          <Form.Item name="readerId" label="绑定抄表员" rules={modal?.mode === 'create' ? [{ required: true, message: '请选择抄表员' }] : []}>
            <Select options={staffOptions} showSearch optionFilterProp="label" placeholder="选择抄表员" allowClear />
          </Form.Item>
          <Form.Item name="remark" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>

      {/* R15 路线模式管理弹窗 */}
      <Modal
        title={`路线模式 — 区号 ${patZone ?? ''}`}
        open={patZone !== null}
        onCancel={() => setPatZone(null)}
        footer={null}
        destroyOnHidden
        width={620}
      >
        <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
          <Input
            placeholder="新模式名称（按当前 routeKey 顺序保存）"
            value={patName}
            onChange={(e) => setPatName(e.target.value)}
          />
          <Button type="primary" disabled={!patName.trim()} loading={patBusy}
            onClick={() => void savePattern()}>
            保存当前顺序
          </Button>
        </Space.Compact>
        <Table<Pattern>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={patRows}
          columns={[
            { title: '模式名', dataIndex: 'name' },
            { title: '户数', width: 70, render: (_, r) => r.entries?.length ?? 0 },
            {
              title: '默认', dataIndex: 'isDefault', width: 70,
              render: (v: boolean) => (v ? <Tag color="green">默认</Tag> : '—'),
            },
            {
              title: '操作', key: 'op', width: 200,
              render: (_, r) => (
                <Space size={4}>
                  <Button size="small" loading={patBusy} onClick={() => void applyPattern(r.id)}>应用</Button>
                  {!r.isDefault && (
                    <Button size="small" loading={patBusy} onClick={() => void setDefaultPattern(r.id)}>设默认</Button>
                  )}
                  <Button size="small" danger loading={patBusy} onClick={() => void removePattern(r.id)}>删除</Button>
                </Space>
              ),
            },
          ]}
        />
      </Modal>
    </Space>
  );
}
