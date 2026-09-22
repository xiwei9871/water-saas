import { EyeOutlined, RedoOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, apiErrorText } from '../../api/client';
import type {
  RawRemoteEvent,
  RawRemoteEventDetail,
  RemoteEventStatus,
  RemoteSource,
} from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { fmtTime } from '../common';

const STATUS_LABELS: Record<RemoteEventStatus, string> = {
  RECEIVED: '已接收',
  UNBOUND: '未绑定',
  WAITING_PLAN: '等待计划',
  FAILED: '失败',
  CONFLICT: '冲突',
  CONVERTED: '已转抄表',
  IGNORED: '已忽略',
};

const STATUS_COLORS: Record<RemoteEventStatus, string> = {
  RECEIVED: 'default',
  UNBOUND: 'orange',
  WAITING_PLAN: 'blue',
  FAILED: 'red',
  CONFLICT: 'magenta',
  CONVERTED: 'green',
  IGNORED: 'default',
};

/** 允许显式重放的状态（CONFLICT 只能走裁决；CONVERTED/IGNORED 终态）。 */
const REPLAYABLE: RemoteEventStatus[] = ['UNBOUND', 'FAILED', 'WAITING_PLAN'];

/**
 * 远传事件（E5）— 原始事件 + 处理日志 + 重放/冲突裁决。
 * URL ?sourceId= 过滤到单个数据源。
 */
export default function RemoteEvents() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canManage = hasPerm('metering:remote:manage');
  const [params] = useSearchParams();

  const [sources, setSources] = useState<RemoteSource[]>([]);
  const [sourceId, setSourceId] = useState<string | undefined>(
    params.get('sourceId') ?? undefined,
  );
  const [status, setStatus] = useState<RemoteEventStatus | undefined>();
  const [period, setPeriod] = useState('');
  const [deviceKey, setDeviceKey] = useState('');
  const [rows, setRows] = useState<RawRemoteEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [detail, setDetail] = useState<RawRemoteEventDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveDecision, setResolveDecision] = useState<'USE_REMOTE' | 'KEEP_ACTUAL'>('USE_REMOTE');
  const [resolveNote, setResolveNote] = useState('');
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    api
      .get<RemoteSource[]>('/remote-sources', { params: { take: 200 } })
      .then((r) => setSources(r.data))
      .catch(() => setSources([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<RawRemoteEvent[]>('/remote-events', {
        params: {
          take: pageSize,
          skip: (page - 1) * pageSize,
          ...(sourceId ? { remoteSourceId: sourceId } : {}),
          ...(status ? { processingStatus: status } : {}),
          ...(period.trim() ? { businessPeriod: period.trim() } : {}),
          ...(deviceKey.trim() ? { vendorDeviceKey: deviceKey.trim() } : {}),
        },
      });
      setRows(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, sourceId, status, period, deviceKey, message]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await api.get<RawRemoteEventDetail>(`/remote-events/${id}`);
      setDetail(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const replay = async (id: string) => {
    setReplaying(true);
    try {
      await api.post(`/remote-events/${id}/replay`);
      message.success('已重新处理');
      await openDetail(id);
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setReplaying(false);
    }
  };

  const resolveConflict = async () => {
    if (!detail) return;
    setResolving(true);
    try {
      await api.post(`/remote-events/${detail.id}/resolve-conflict`, {
        decision: resolveDecision,
        note: resolveNote || undefined,
      });
      message.success(resolveDecision === 'USE_REMOTE' ? '已采用远传读数（更正）' : '已保留人工读数');
      setResolveOpen(false);
      await openDetail(detail.id);
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setResolving(false);
    }
  };

  const columns: ColumnsType<RawRemoteEvent> = [
    { title: '外部事件 Key', dataIndex: 'externalEventKey', width: 190 },
    { title: '设备 Key', dataIndex: 'vendorDeviceKey', width: 160 },
    { title: '账期', dataIndex: 'businessPeriod', width: 90 },
    { title: '采集时间', dataIndex: 'collectedAt', width: 165, render: fmtTime },
    { title: '读数', dataIndex: 'readingValue', width: 110, align: 'right' },
    {
      title: '状态',
      dataIndex: 'processingStatus',
      width: 100,
      render: (s: RemoteEventStatus) => (
        <Tag color={STATUS_COLORS[s]}>{STATUS_LABELS[s] ?? s}</Tag>
      ),
    },
    {
      title: '当前问题',
      dataIndex: 'currentIssueCode',
      width: 170,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '操作',
      key: 'ops',
      width: 150,
      render: (_, row) => (
        <Space size="small">
          <Button size="small" icon={<EyeOutlined />} onClick={() => void openDetail(row.id)}>
            详情
          </Button>
          {canManage && REPLAYABLE.includes(row.processingStatus) && (
            <Button
              size="small"
              icon={<RedoOutlined />}
              onClick={() => void replay(row.id)}
            >
              重放
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="远传事件"
      extra={
        <Space wrap>
          <Select
            allowClear
            placeholder="数据源"
            style={{ width: 190 }}
            value={sourceId}
            onChange={(v) => {
              setSourceId(v);
              setPage(1);
            }}
            options={sources.map((s) => ({ value: s.id, label: `${s.code} ${s.name}` }))}
          />
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 130 }}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <Input
            placeholder="账期 YYYYMM"
            style={{ width: 120 }}
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);
              setPage(1);
            }}
          />
          <Input.Search
            placeholder="设备 Key"
            allowClear
            style={{ width: 180 }}
            value={deviceKey}
            onChange={(e) => setDeviceKey(e.target.value)}
            onSearch={() => setPage(1)}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()} />
        </Space>
      }
    >
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={{
          current: page,
          pageSize,
          total: (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0),
          onChange: (p, s) => {
            setPage(p);
            setPageSize(s);
          },
          showSizeChanger: true,
        }}
      />

      <Drawer
        title={`事件 ${detail?.externalEventKey ?? ''}`}
        open={detail !== null}
        onClose={() => setDetail(null)}
        width={680}
        loading={detailLoading}
      >
        {detail && (
          <>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_COLORS[detail.processingStatus]}>
                  {STATUS_LABELS[detail.processingStatus]}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="当前问题">{detail.currentIssueCode ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="设备 Key">{detail.vendorDeviceKey}</Descriptions.Item>
              <Descriptions.Item label="读数">{detail.readingValue}</Descriptions.Item>
              <Descriptions.Item label="账期">{detail.businessPeriod}</Descriptions.Item>
              <Descriptions.Item label="采集时间">{fmtTime(detail.collectedAt)}</Descriptions.Item>
              <Descriptions.Item label="接收时间">{fmtTime(detail.receivedAt)}</Descriptions.Item>
              <Descriptions.Item label="厂商质量">{detail.vendorQuality ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="解析设备">{detail.resolvedRemoteDeviceId ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="解析绑定">{detail.resolvedBindingId ?? '—'}</Descriptions.Item>
              {detail.reading && (
                <Descriptions.Item label="生成抄表" span={2}>
                  {detail.reading.id.slice(0, 8)}… · {detail.reading.readingValue} · QC{' '}
                  {detail.reading.qcStatus}
                </Descriptions.Item>
              )}
            </Descriptions>

            {canManage && (
              <Space style={{ margin: '12px 0' }}>
                {REPLAYABLE.includes(detail.processingStatus) && (
                  <Button
                    type="primary"
                    icon={<RedoOutlined />}
                    loading={replaying}
                    onClick={() => void replay(detail.id)}
                  >
                    重放处理
                  </Button>
                )}
                {detail.processingStatus === 'CONFLICT' && (
                  <Button danger onClick={() => setResolveOpen(true)}>
                    裁决冲突
                  </Button>
                )}
              </Space>
            )}

            <Typography.Title level={5} style={{ marginTop: 16 }}>
              处理日志
            </Typography.Title>
            <Timeline
              items={detail.processLogs.map((log) => ({
                color:
                  log.toStatus === 'CONVERTED'
                    ? 'green'
                    : log.toStatus === 'FAILED' || log.toStatus === 'CONFLICT'
                      ? 'red'
                      : 'blue',
                children: (
                  <div>
                    <div>
                      <b>{log.action}</b>
                      {log.fromStatus && ` ${STATUS_LABELS[log.fromStatus] ?? log.fromStatus}`}
                      {log.toStatus && ` → ${STATUS_LABELS[log.toStatus] ?? log.toStatus}`}
                      {log.code && <Tag style={{ marginLeft: 6 }}>{log.code}</Tag>}
                    </div>
                    {log.message && <div style={{ color: '#888' }}>{log.message}</div>}
                    <div style={{ color: '#aaa', fontSize: 12 }}>
                      {fmtTime(log.createdAt)} · {log.actorType}
                    </div>
                  </div>
                ),
              }))}
            />

            <Typography.Title level={5}>Payload</Typography.Title>
            <pre style={{ fontSize: 12, maxHeight: 240, overflow: 'auto', background: '#f6f6f6', padding: 8 }}>
              {JSON.stringify(detail.canonicalPayload, null, 2)}
            </pre>
          </>
        )}

        <Modal
          title="冲突裁决 — 远传读数 vs 人工读数"
          open={resolveOpen}
          onCancel={() => setResolveOpen(false)}
          onOk={() => void resolveConflict()}
          confirmLoading={resolving}
          okText="确认裁决"
          destroyOnHidden
        >
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="同一计划项已有人工实际读数。采用远传将生成一条更正读数（supersede 人工行）；保留人工则事件记为已忽略。两者都是可审计终态。"
          />
          <Select
            style={{ width: '100%', marginBottom: 12 }}
            value={resolveDecision}
            onChange={(v) => setResolveDecision(v)}
            options={[
              { value: 'USE_REMOTE', label: '采用远传读数（生成更正抄表）' },
              { value: 'KEEP_ACTUAL', label: '保留人工读数（事件忽略）' },
            ]}
          />
          <Input.TextArea
            rows={3}
            placeholder="裁决说明（可选，记入处理日志）"
            value={resolveNote}
            onChange={(e) => setResolveNote(e.target.value)}
          />
        </Modal>
      </Drawer>
    </Card>
  );
}
