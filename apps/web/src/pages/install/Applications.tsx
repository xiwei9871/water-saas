import { CloseOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Card, DatePicker, Drawer, Descriptions, Form, Image, Input, InputNumber, Modal, Select, Space, Steps, Tag, Typography, Upload } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState, useRef } from 'react';
import { api, apiErrorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { fmtDate, USAGE_CATEGORY_OPTIONS } from '../common';
import { Link, useNavigate } from 'react-router-dom';
import {
  FOCUS_ROW_CLASS,
  FocusTaskBar,
  useFocusList,
  useFocusParams,
  useTaskGroup,
} from '../../components/TaskFocus';
import Table from '../../components/PageTable';


type ApplyStatus = 'SUBMITTED' | 'SURVEYED' | 'APPROVED' | 'INSTALLING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';

interface Apply {
  id: string;
  applyNo: string;
  applicantName: string;
  custType: string;
  contactPhone: string | null;
  addr: string;
  usageCategory: string;
  caliberReq: string | null;
  remark: string | null;
  status: ApplyStatus;
  surveyNote: string | null;
  installNote: string | null;
  installInitialReading?: string | null;
  contractNo?: string | null;
  settleAccountId?: string | null;
  settleNo?: string | null;
  meterNo?: string | null;
  installMeterNo?: string | null;
  installCaliber?: string | null;
  installCompletedAt?: string | null;
  feeRequired?: string | null;
  feeReceived?: string | null;
  feeNote?: string | null;
  contractScan?: string[] | null;
  certType?: string | null;
  certNo?: string | null;
  certPhoto?: string[] | null;
  rejectReason: string | null;
  waterAccountId: string | null;
  waterAccountNo?: string | null;
  createdAt: string;
}

const STATUS_LABELS: Record<ApplyStatus, string> = {
  SUBMITTED: '已提交', SURVEYED: '已勘察', APPROVED: '已审批',
  INSTALLING: '装表中', COMPLETED: '已归档', REJECTED: '已驳回', CANCELLED: '已取消',
};
const STATUS_STEP: Record<ApplyStatus, number> = {
  SUBMITTED: 0, SURVEYED: 1, APPROVED: 2, INSTALLING: 3, COMPLETED: 4,
  REJECTED: 0, CANCELLED: 0,
};
const CERT_TYPE_LABELS: Record<string, string> = { ID_CARD: '居民身份证', BUSINESS_LICENSE: '营业执照', PASSPORT: '护照', OTHER: '其他证件' };

const STATUS_COLORS: Record<ApplyStatus, string> = {
  SUBMITTED: 'processing', SURVEYED: 'cyan', APPROVED: 'geekblue',
  INSTALLING: 'gold', COMPLETED: 'green', REJECTED: 'red', CANCELLED: 'default',
};
const NEXT_ACTIONS: Partial<Record<ApplyStatus, { to: ApplyStatus; label: string; noteField?: 'survey' | 'install' }[]>> = {
  SUBMITTED: [
    { to: 'SURVEYED', label: '勘察完成', noteField: 'survey' },
    { to: 'REJECTED', label: '驳回' },
  ],
  SURVEYED: [
    { to: 'APPROVED', label: '审批通过' },
    { to: 'REJECTED', label: '驳回' },
  ],
  APPROVED: [
    { to: 'INSTALLING', label: '开始装表', noteField: 'install' },
    { to: 'REJECTED', label: '驳回' },
  ],
  INSTALLING: [{ to: 'CANCELLED', label: '取消' }],
};

/** S1 报装管理（独立域）：申请→勘察→审批→装表→归档立户。 */
export default function InstallApplications() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const [rows, setRows] = useState<Apply[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<Apply | null>(null);
  const [noteFor, setNoteFor] = useState<{ app: Apply; to: ApplyStatus; label: string; noteField?: string } | null>(null);
  /** V6 合同扫描件草稿（详情抽屉内编辑，保存才落库）。 */
  const [scans, setScans] = useState<string[]>([]);
  const [certPhotos, setCertPhotos] = useState<string[]>([]);
  const [scanSaving, setScanSaving] = useState(false);
  const [form] = Form.useForm();
  const [noteForm] = Form.useForm();
  const canWrite = hasPerm('install:write');
  const { focusId, clear: clearFocus } = useFocusParams();
  const focusDone = useRef<string | null>(null);
  const [focusRecord, setFocusRecord] = useState<Apply | null>(null);

  // U1 任务直达 ?focusId= → 置顶警示条 + 行高亮 + 打开该申请详情抽屉。
  useEffect(() => {
    if (!focusId) {
      setFocusRecord(null);
      focusDone.current = null;
      return;
    }
    if (focusDone.current === focusId) return;
    focusDone.current = focusId;
    void (async () => {
      try {
        const res = await api.get<Apply>(`/install/applications/${focusId}`);
        setFocusRecord(res.data);
        setDetail(res.data);
      } catch {
        /* 详情拉取失败时停留在列表 */
      }
    })();
  }, [focusId]);

  // A3 任务三态分组：报装任务挂在申请单上。
  const taskGroup = useTaskGroup<Apply>('INSTALL_APPLICATION', rows, (r) => r.id);
  const focusList = useFocusList<Apply>(
    focusId,
    taskGroup.filtered,
    focusId ? (r) => r.id === focusId : null,
    { extraRecord: focusRecord },
  );
  const shownRows = focusList.shown;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<Apply[]>('/install/applications', {
        params: status ? { status } : {},
      });
      setRows(res.data);
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [message, status]);
  useEffect(() => void load(), [load]);

  const create = async () => {
    const v = await form.validateFields();
    try {
      await api.post('/install/applications', { ...v, certPhoto: certPhotos });
      message.success('申请已提交，审批任务已生成');
      setCreateOpen(false);
      setCertPhotos([]);
      form.resetFields();
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const transition = async () => {
    const note = noteForm.getFieldValue('note') as string | undefined;
    const iir = noteForm.getFieldValue('installInitialReading') as number | undefined;
    try {
      const res = await api.post(`/install/applications/${noteFor!.app.id}/transition`, {
        to: noteFor!.to,
        note,
        ...(noteFor!.to === 'INSTALLING'
          ? {
              ...(iir !== undefined && iir !== null ? { installInitialReading: iir } : {}),
              installMeterNo: noteForm.getFieldValue('installMeterNo') || undefined,
              installCaliber: noteForm.getFieldValue('installCaliber') || undefined,
              installCompletedAt:
                (noteForm.getFieldValue('installCompletedAt') as { format?: (f: string) => string } | undefined)?.format?.('YYYY-MM-DD') || undefined,
              feeRequired: noteForm.getFieldValue('feeRequired') ?? undefined,
              feeReceived: noteForm.getFieldValue('feeReceived') ?? undefined,
              feeNote: noteForm.getFieldValue('feeNote') || undefined,
            }
          : {}),
      }).then((r) => r.data as { refundDue?: number });
      if (res.refundDue) {
        message.warning(`已取消——该申请已收工程费 ¥${res.refundDue.toFixed(2)}，请线下办理退款并留痕`);
      } else {
        message.success(`已流转至「${STATUS_LABELS[noteFor!.to]}」`);
      }
      setNoteFor(null);
      noteForm.resetFields();
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    }
  };

  const nav = useNavigate();
  const [contractNoDraft, setContractNoDraft] = useState('');
  const [contractSaving, setContractSaving] = useState(false);
  // Q5：装表完成后、归档立户前在详情页录入/修正供用水合同编号。
  const saveContractNo = async () => {
    if (!detail) return;
    setContractSaving(true);
    try {
      const res = await api.patch<Apply>(`/install/applications/${detail.id}/contract`, {
        contractNo: contractNoDraft.trim() || null,
      });
      setDetail((d) => (d ? { ...d, contractNo: res.data.contractNo } : d));
      message.success('合同编号已保存');
      void load();
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setContractSaving(false);
    }
  };

  // R1：归档立户 → 跳立户向导（唯一立户入口），来源报装单自动预填并办结。
  const goOnboard = (app: Apply) => {
    nav(`/customer/onboard?applyNo=${encodeURIComponent(app.applyNo)}`);
  };

  const cols: ColumnsType<Apply> = [
    { title: '申请号', dataIndex: 'applyNo', width: 150 },
    { title: '合同号', dataIndex: 'contractNo', width: 140, render: (v: string | null) => v ?? '—' },
    { title: '申请人', dataIndex: 'applicantName', width: 120 },
    { title: '联系电话', dataIndex: 'contactPhone', width: 120, render: (v: string | null) => v ?? '—' },
    { title: '用水性质', dataIndex: 'usageCategory', width: 100, render: (v: string) => USAGE_CATEGORY_OPTIONS.find((c) => c.value === v)?.label ?? v },
    { title: '地址', dataIndex: 'addr', ellipsis: true },
    { title: '申请口径', dataIndex: 'caliberReq', width: 90, render: (v: string | null) => v ?? '—' },
    { title: '状态', dataIndex: 'status', width: 90, render: (s: ApplyStatus) => <Tag color={STATUS_COLORS[s]}>{STATUS_LABELS[s]}</Tag> },
    {
      title: '已立户',
      width: 180,
      render: (_, r) =>
        r.waterAccountNo ? (
          <Space size={4} direction="vertical" style={{ lineHeight: 1.2 }}>
            <Link to={`/customer/water-accounts?accountNo=${encodeURIComponent(r.waterAccountNo)}`}>{r.waterAccountNo}</Link>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.settleNo ?? '—'}{r.meterNo ? ` · ${r.meterNo}` : ''}
            </Typography.Text>
          </Space>
        ) : (
          '—'
        ),
    },
    { title: '申请时间', dataIndex: 'createdAt', width: 160, render: (v: string) => fmtDate(v.slice(0, 10)) },
    {
      title: '操作',
      width: 220,
      render: (_, r) => (
        <Space size={4} wrap>
          <Button size="small" onClick={() => { setDetail(r); setScans(r.contractScan ?? []); setContractNoDraft(r.contractNo ?? ''); }}>详情</Button>
          {canWrite &&
            (NEXT_ACTIONS[r.status] ?? []).map((a) => (
              <Button key={a.to} size="small" danger={a.to === 'REJECTED' || a.to === 'CANCELLED'} onClick={() => setNoteFor({ app: r, ...a })}>
                {a.label}
              </Button>
            ))}
          {canWrite && (r.status === 'INSTALLING' || r.status === 'APPROVED') && (
            <Button size="small" type="primary" onClick={() => goOnboard(r)}>归档立户</Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="报装申请"
      size="small"
      extra={
        <Space>
          <Select
                    showSearch
                    optionFilterProp="label"
            allowClear
            placeholder="状态"
            style={{ width: 130 }}
            onChange={setStatus}
            options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          />
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建申请</Button>
          )}
        </Space>
      }
    >
      {focusId && (
        <FocusTaskBar
          focusId={focusId}
          summary={
            focusRecord ? (
              <span>
                申请 {focusRecord.applyNo} · {focusRecord.applicantName} · {focusRecord.addr}
              </span>
            ) : (
              <span>该申请已定位</span>
            )
          }
          showAll={focusList.showAll}
          onToggleAll={focusList.toggleAll}
          onClose={clearFocus}
        />
      )}
      {!focusList.focusing && taskGroup.tabs}
      <Table scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }} rowKey="id" size="small" columns={cols} dataSource={shownRows} loading={loading} pagination={false} rowClassName={(r: Apply) => (r.id === focusId ? FOCUS_ROW_CLASS : '')} />

      <Modal title="新建报装申请" open={createOpen} onOk={() => void create()} onCancel={() => setCreateOpen(false)} destroyOnHidden>
        <Form form={form} layout="vertical" initialValues={{ custType: 'PERSONAL', usageCategory: 'RES_METERED' }}>
          <Form.Item name="applicantName" label="申请人名称" rules={[{ required: true }]}>
            <Input maxLength={60} />
          </Form.Item>
          <Space>
            <Form.Item name="custType" label="客户类型" rules={[{ required: true }]}>
              <Select style={{ width: 140 }} options={[{ value: 'PERSONAL', label: '个人' }, { value: 'ORG', label: '单位' }]} />
            </Form.Item>
            <Form.Item name="contactPhone" label="联系电话">
              <Input maxLength={30} style={{ width: 180 }} />
            </Form.Item>
          </Space>
          <Space>
            <Form.Item name="certType" label="证件类型">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: 160 }}
                options={[
                  { value: 'ID_CARD', label: '居民身份证' },
                  { value: 'BUSINESS_LICENSE', label: '营业执照' },
                  { value: 'PASSPORT', label: '护照' },
                  { value: 'OTHER', label: '其他证件' },
                ]}
              />
            </Form.Item>
            <Form.Item name="certNo" label="证件号码">
              <Input maxLength={40} style={{ width: 220 }} />
            </Form.Item>
          </Space>
          <Form.Item label="证件照片/扫描件">
            <Space wrap>
              {certPhotos.map((p, i) => (
                <span key={i} style={{ position: 'relative', display: 'inline-block' }}>
                  <Image src={p} width={56} height={56} style={{ objectFit: 'cover' }} />
                  <Button
                    size="small" type="text" danger icon={<CloseOutlined />}
                    style={{ position: 'absolute', top: 0, right: 0 }}
                    onClick={() => setCertPhotos((xs) => xs.filter((_, j) => j !== i))}
                  />
                </span>
              ))}
              <Upload
                accept="image/*"
                showUploadList={false}
                beforeUpload={(f) => {
                  if (certPhotos.length >= 3) {
                    message.warning('最多 3 张');
                    return false;
                  }
                  const rd = new FileReader();
                  rd.onload = () => setCertPhotos((xs) => [...xs, String(rd.result)]);
                  rd.readAsDataURL(f);
                  return false;
                }}
              >
                <Button size="small" icon={<UploadOutlined />}>上传/拍照</Button>
              </Upload>
            </Space>
          </Form.Item>
          <Form.Item name="addr" label="安装地址" rules={[{ required: true }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Space>
            <Form.Item name="usageCategory" label="用水性质" rules={[{ required: true }]}>
              <Select style={{ width: 160 }} options={USAGE_CATEGORY_OPTIONS} />
            </Form.Item>
            <Form.Item name="caliberReq" label="申请口径">
              <Select allowClear style={{ width: 140 }} options={['DN15', 'DN20', 'DN25', 'DN40', 'DN50', 'DN100'].map((v) => ({ value: v, label: v }))} />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={300} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={noteFor ? `${noteFor.label}：${noteFor.app.applyNo}` : ''}
        open={!!noteFor}
        onOk={() => void transition()}
        onCancel={() => setNoteFor(null)}
        destroyOnHidden
      >
        <Form form={noteForm} layout="vertical">
          {noteFor?.to === 'INSTALLING' && (
            <>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
                接收装表完成信息——表号/口径/完成日期/工程费随本步登记，归档立户时自动带入。
              </Typography.Paragraph>
              <Space wrap>
                <Form.Item name="installMeterNo" label="安装表号">
                  <Input style={{ width: 160 }} placeholder="装上的表号" maxLength={40} />
                </Form.Item>
                <Form.Item name="installCaliber" label="实际口径">
                  <Select allowClear style={{ width: 120 }} options={['DN15', 'DN20', 'DN25', 'DN40', 'DN50', 'DN100'].map((v) => ({ value: v, label: v }))} />
                </Form.Item>
                <Form.Item name="installCompletedAt" label="装表完成日期">
                  <DatePicker style={{ width: 150 }} />
                </Form.Item>
              </Space>
              <Form.Item
                name="installInitialReading"
                label="装表初始读数（m³）"
                tooltip="装表完成那一刻的表码。立户时会与「水表起始读数」对比，若起始读数更大将提示核实装表后至立户期间的用水量。"
              >
                <InputNumber min={0} precision={2} style={{ width: 200 }} placeholder="如 0" />
              </Form.Item>
              <Space wrap>
                <Form.Item name="feeRequired" label="工程费应收（元）" tooltip="勘察核定应收的工程费；未收齐将在归档后进入应收补收。">
                  <InputNumber min={0} precision={2} style={{ width: 160 }} />
                </Form.Item>
                <Form.Item name="feeReceived" label="工程费实收（元）">
                  <InputNumber min={0} precision={2} style={{ width: 160 }} />
                </Form.Item>
                <Form.Item name="feeNote" label="费用说明">
                  <Input style={{ width: 200 }} maxLength={100} />
                </Form.Item>
              </Space>
            </>
          )}
          <Form.Item name="note" label={noteFor?.to === 'REJECTED' ? '驳回原因' : '办理备注'} rules={noteFor?.to === 'REJECTED' ? [{ required: true }] : []}>
            <Input.TextArea rows={3} maxLength={300} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title={`申请详情 ${detail?.applyNo ?? ''}`} open={!!detail} onClose={() => setDetail(null)} width={520}>
        {detail && (
          <>
            <Steps
              size="small"
              style={{ marginBottom: 16 }}
              current={STATUS_STEP[detail.status] ?? 0}
              status={['REJECTED', 'CANCELLED'].includes(detail.status) ? 'error' : 'process'}
              items={[
                { title: '申请', description: '提交报装' },
                { title: '勘察', description: '现场勘察' },
                { title: '审批', description: '审核批准' },
                { title: '装表', description: '安装水表' },
                { title: '归档', description: '立户归档' },
              ]}
            />
            {['REJECTED', 'CANCELLED'].includes(detail.status) && (
              <Typography.Text type="danger" style={{ display: 'block', marginBottom: 12 }}>
                流程已{detail.status === 'REJECTED' ? '驳回' : '取消'}
                {detail.rejectReason ? `：${detail.rejectReason}` : ''}
              </Typography.Text>
            )}
          </>
        )}
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="申请人">{detail.applicantName}</Descriptions.Item>
            <Descriptions.Item label="合同号">
              {canWrite && ['INSTALLING', 'APPROVED'].includes(detail.status) ? (
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    size="small"
                    value={contractNoDraft}
                    placeholder="供用水合同编号（可手填/自动生成）"
                    onChange={(e) => setContractNoDraft(e.target.value)}
                  />
                  <Button
                    size="small"
                    type="primary"
                    loading={contractSaving}
                    disabled={contractNoDraft === (detail.contractNo ?? '')}
                    onClick={() => void saveContractNo()}
                  >
                    保存
                  </Button>
                </Space.Compact>
              ) : (
                detail.contractNo ?? '—'
              )}
            </Descriptions.Item>
            <Descriptions.Item label="联系电话">{detail.contactPhone ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="证件">{detail.certType ? (CERT_TYPE_LABELS[detail.certType] ?? detail.certType) : '—'}{detail.certNo ? ` ${detail.certNo}` : ''}</Descriptions.Item>
            {Array.isArray(detail.certPhoto) && detail.certPhoto.length > 0 && (
              <Descriptions.Item label="证件照片">
                <Space>{(detail.certPhoto as string[]).map((p, i) => <Image key={i} src={p} width={48} height={48} style={{ objectFit: 'cover' }} />)}</Space>
              </Descriptions.Item>
            )}
            <Descriptions.Item label="地址">{detail.addr}</Descriptions.Item>
            <Descriptions.Item label="用水性质">{USAGE_CATEGORY_OPTIONS.find((c) => c.value === detail.usageCategory)?.label ?? detail.usageCategory}</Descriptions.Item>
            <Descriptions.Item label="状态"><Tag color={STATUS_COLORS[detail.status]}>{STATUS_LABELS[detail.status]}</Tag></Descriptions.Item>
            {detail.surveyNote && <Descriptions.Item label="勘察备注">{detail.surveyNote}</Descriptions.Item>}
            {detail.installNote && <Descriptions.Item label="装表备注">{detail.installNote}</Descriptions.Item>}
            {detail.installInitialReading != null && (
              <Descriptions.Item label="装表初始读数">{detail.installInitialReading} m³</Descriptions.Item>
            )}
            {(detail.installMeterNo || detail.installCaliber || detail.installCompletedAt) && (
              <Descriptions.Item label="装表完成信息">
                {[
                  detail.installMeterNo ? `表号 ${detail.installMeterNo}` : null,
                  detail.installCaliber ? `口径 ${detail.installCaliber}` : null,
                  detail.installCompletedAt ? `完成 ${String(detail.installCompletedAt).slice(0, 10)}` : null,
                ].filter(Boolean).join(' · ')}
              </Descriptions.Item>
            )}
            {(detail.feeRequired != null || detail.feeReceived != null) && (
              <Descriptions.Item label="工程费">
                应收 {detail.feeRequired ?? '—'} 元 · 实收 {detail.feeReceived ?? '—'} 元
                {detail.feeNote ? `（${detail.feeNote}）` : ''}
              </Descriptions.Item>
            )}
            {detail.rejectReason && <Descriptions.Item label="驳回原因">{detail.rejectReason}</Descriptions.Item>}
            {detail.waterAccountId && (
              <Descriptions.Item label="已立户">
                {[detail.waterAccountNo, detail.settleNo, detail.meterNo].filter(Boolean).join(' · ') ||
                  detail.waterAccountId}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="合同扫描件">
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Space wrap>
                  {scans.map((s, i) => (
                    <span key={i} style={{ position: 'relative', display: 'inline-block' }}>
                      <Image src={s} width={88} height={118} style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #eee' }} />
                      {canWrite && (
                        <Button
                          size="small" type="text" danger icon={<CloseOutlined />}
                          style={{ position: 'absolute', top: 0, right: 0 }}
                          onClick={() => setScans((xs) => xs.filter((_, j) => j !== i))}
                        />
                      )}
                    </span>
                  ))}
                  {!scans.length && <Typography.Text type="secondary">未上传</Typography.Text>}
                </Space>
                {canWrite && (
                  <Space>
                    <Upload
                      accept="image/*"
                      showUploadList={false}
                      beforeUpload={(f) => {
                        if (scans.length >= 3) {
                          message.warning('最多 3 张');
                          return false;
                        }
                        const rd = new FileReader();
                        rd.onload = () => setScans((xs) => [...xs, String(rd.result)]);
                        rd.readAsDataURL(f);
                        return false;
                      }}
                    >
                      <Button size="small" icon={<UploadOutlined />}>上传扫描件</Button>
                    </Upload>
                    <Button
                      size="small" type="primary" loading={scanSaving}
                      disabled={JSON.stringify(scans) === JSON.stringify(detail.contractScan ?? [])}
                      onClick={async () => {
                        setScanSaving(true);
                        try {
                          const res = await api.post<Apply>(`/install/applications/${detail.id}/contract-scan`, { scans });
                          setDetail((d) => (d ? { ...d, contractScan: res.data.contractScan } : d));
                          message.success('扫描件已保存');
                        } catch (err) {
                          message.error(apiErrorText(err));
                        } finally {
                          setScanSaving(false);
                        }
                      }}
                    >
                      保存
                    </Button>
                  </Space>
                )}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="备注">{detail.remark ?? '—'}</Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>
    </Card>
  );
}
