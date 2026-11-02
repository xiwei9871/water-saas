import Select from '../../components/CopySelect';
import {
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp, Button, Card, DatePicker, Form, Input, InputNumber,
  Modal, Radio, Space, Tag, Typography,
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
  collectMode: 'READER_DIRECT' | 'ZONE_SEGMENT';
  collectModeLabel: string;
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
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; zone: ZoneRow } | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ZoneFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [z, c] = await Promise.all([
        api.get<ZoneRow[]>('/reading-zones'),
        api.get<CalendarResp>('/metering/calendar'),
      ]);
      setRows(z.data);
      setCal(c.data);
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
          {r.status === 'ACTIVE' && r.zoneNo !== '111' && (
            <Button size="small" danger onClick={() => void unbind(r)}>解绑</Button>
          )}
        </Space>
      ),
    },
  ];

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
          <Space>
            <Typography.Text>抄表归集模式：</Typography.Text>
            <Radio.Group
              value={cal?.collectMode ?? 'ZONE_SEGMENT'}
              disabled={!canWrite}
              onChange={(e) => void saveConfig({ collectMode: e.target.value })}
              options={[
                { value: 'READER_DIRECT', label: '抄表员直管' },
                { value: 'ZONE_SEGMENT', label: '区段管理' },
              ]}
              optionType="button"
            />
          </Space>
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
            <Space>
              <DatePicker
                placeholder="选择日期登记节假日"
                onChange={(d) => void addException(d, 'HOLIDAY')}
              />
              <DatePicker
                placeholder="选择日期登记调休上班日"
                onChange={(d) => void addException(d, 'WORKDAY')}
              />
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
              <Typography.Text type="secondary">无例外登记，默认周一至周五为工作日</Typography.Text>
            )}
          </Space>
        </Space>
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
    </Space>
  );
}
