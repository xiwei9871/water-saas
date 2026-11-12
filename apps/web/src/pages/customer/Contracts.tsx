import { useCallback, useEffect, useState } from 'react';
import { App as AntdApp, Button, Card, Form, Input, Modal, Table, Tabs, Tag } from 'antd';
import { api, apiErrorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';

/** P0-2/S1（1112v8）合同管理：施工合同 | 供用水合同 两页签分区录入。 */
interface ContractRow {
  id: string;
  applyNo: string | null;
  waterAccountId: string | null;
  contractType: 'CONSTRUCTION' | 'SUPPLY';
  contractNo: string;
  remark: string | null;
  createdAt: string;
}

const TYPE_LABEL: Record<string, string> = {
  CONSTRUCTION: '安装施工合同',
  SUPPLY: '供用水合同',
};

export default function Contracts() {
  const { message } = AntdApp.useApp();
  const { hasPerm } = useAuth();
  const canWrite = hasPerm('customer:write');
  const [tab, setTab] = useState<'CONSTRUCTION' | 'SUPPLY'>('CONSTRUCTION');
  const [rows, setRows] = useState<ContractRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(false);
  const [form] = Form.useForm<{ applyNo?: string; waterAccountId?: string; contractNo: string; remark?: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<ContractRow[]>('/contracts', { params: { contractType: tab, take: 200 } });
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      message.error(apiErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [tab, message]);

  useEffect(() => { void load(); }, [load]);

  return (
    <Card
      title="合同管理"
      extra={canWrite && (
        <Button type="primary" onClick={() => { form.resetFields(); setModal(true); }}>
          新建{TYPE_LABEL[tab]}
        </Button>
      )}
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as 'CONSTRUCTION' | 'SUPPLY')}
        items={[
          { key: 'CONSTRUCTION', label: '安装施工合同' },
          { key: 'SUPPLY', label: '供用水合同' },
        ]}
      />
      <Table<ContractRow>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        scroll={{ x: true }}
        columns={[
          { title: '合同编号', dataIndex: 'contractNo', width: 160, render: (v: string) => <Tag color="blue">{v}</Tag> },
          { title: '报装申请号', dataIndex: 'applyNo', width: 170, render: (v: string | null) => v ?? '—' },
          { title: '户号', dataIndex: 'waterAccountId', width: 170, render: (v: string | null) => v ? v.slice(0, 8) + '…' : '待转挂' },
          { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v: string | null) => v ?? '—' },
          { title: '录入时间', dataIndex: 'createdAt', width: 170, render: (v: string) => v?.replace('T', ' ').slice(0, 19) },
          ...(canWrite ? [{
            title: '操作', key: 'op', width: 80,
            render: (_: unknown, r: ContractRow) => (
              <Button size="small" danger onClick={async () => {
                try {
                  await api.delete(`/contracts/${r.id}`);
                  message.success('已删除'); void load();
                } catch (e) { message.error(apiErrorText(e)); }
              }}>删除</Button>
            ),
          }] : []),
        ]}
      />
      <Modal
        title={`新建${TYPE_LABEL[tab]}`}
        open={modal}
        onCancel={() => setModal(false)}
        onOk={async () => {
          const v = await form.validateFields();
          if (!v.applyNo?.trim() && !v.waterAccountId?.trim()) {
            message.warning('户号与报装申请号须二选一填写'); return;
          }
          try {
            await api.post('/contracts', {
              contractType: tab,
              contractNo: v.contractNo.trim(),
              applyNo: v.applyNo?.trim() || null,
              waterAccountId: v.waterAccountId?.trim() || null,
              remark: v.remark?.trim() || null,
            });
            message.success('已录入'); setModal(false); void load();
          } catch (e) { message.error(apiErrorText(e)); }
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="contractNo" label="合同编号" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder={tab === 'CONSTRUCTION' ? '如 SG-2026-001' : '如 GY-2026-001'} />
          </Form.Item>
          <Form.Item name="applyNo" label="报装申请号（与户号二选一）">
            <Input placeholder="如 BZ202611000001" />
          </Form.Item>
          <Form.Item name="waterAccountId" label="用水户 ID（与申请号二选一）">
            <Input placeholder="放号后生成的户号" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
