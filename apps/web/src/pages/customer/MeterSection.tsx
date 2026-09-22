import { SwapOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Space, Table } from 'antd';
import type { AccountInstallation, InstallReason, WaterAccountDetail } from '../../api/types';
import { fmtDate, INSTALL_REASON_LABELS } from '../common';
import { InstallationStatusTag } from '../pickers';

export function MeterSection({
  detail,
  canWrite,
  onInstall,
  onRemove,
  onReplace,
}: {
  detail: WaterAccountDetail;
  canWrite: boolean;
  onInstall: () => void;
  onRemove: (inst: AccountInstallation) => void;
  onReplace: (inst: AccountInstallation) => void;
}) {
  const installations = detail.meterInstallations ?? [];
  const actives = installations.filter((i) => i.status === 'ACTIVE');
  const current = actives[0]; // installed_at DESC — the newest
  const closed = detail.status === 'CLOSED';

  return (
    <>
      {actives.length > 1 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`该户存在 ${actives.length} 只在册水表`}
          description="一户多表为异常数据（多为历史遗留）。已全部如实展示，当前表按装表时间最新的一块解析；请在核实后拆除多余安装记录。"
        />
      )}
      {current ? (
        <Descriptions
          column={2}
          size="small"
          bordered
          title="当前表"
          style={{ marginBottom: 16 }}
        >
          <Descriptions.Item label="表号">
            {current.meter.meterNo}
          </Descriptions.Item>
          <Descriptions.Item label="品牌/口径">
            {[current.meter.brand, current.meter.caliber]
              .filter(Boolean)
              .join(' ') || '—'}
          </Descriptions.Item>
          <Descriptions.Item label="装表时间">
            {fmtDate(current.installedAt)}
          </Descriptions.Item>
          <Descriptions.Item label="装表始码">
            {current.initialReading}
          </Descriptions.Item>
        </Descriptions>
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="该户当前没有在册水表"
        />
      )}
      {canWrite && !closed && (
        <Space style={{ marginBottom: 16 }}>
          {actives.length === 0 && (
            <Button type="primary" onClick={onInstall}>
              装表
            </Button>
          )}
          {current && (
            <>
              <Button icon={<SwapOutlined />} onClick={() => onReplace(current)}>
                换表
              </Button>
              <Button danger onClick={() => onRemove(current)}>
                拆表
              </Button>
            </>
          )}
        </Space>
      )}
      <Table<AccountInstallation>
        rowKey="id"
        size="small"
        dataSource={installations}
        pagination={false}
        locale={{ emptyText: '暂无安装记录' }}
        columns={[
          {
            title: '表号',
            key: 'meterNo',
            render: (_: unknown, r) => r.meter.meterNo,
          },
          {
            title: '装表时间',
            dataIndex: 'installedAt',
            render: (v: string) => fmtDate(v),
          },
          {
            title: '拆表时间',
            dataIndex: 'removedAt',
            render: (v: string | null) => fmtDate(v),
          },
          { title: '始码', dataIndex: 'initialReading' },
          {
            title: '止码',
            dataIndex: 'finalReading',
            render: (v: string | null) => v ?? '—',
          },
          {
            title: '原因',
            dataIndex: 'reason',
            render: (r: InstallReason) => INSTALL_REASON_LABELS[r],
          },
          {
            title: '状态',
            dataIndex: 'status',
            render: (s) => <InstallationStatusTag status={s} />,
          },
          ...(canWrite && !closed && actives.length > 1
            ? [
                {
                  title: '操作',
                  key: 'actions',
                  render: (_: unknown, r: AccountInstallation) =>
                    r.status === 'ACTIVE' && r.id !== current?.id ? (
                      <Button size="small" danger onClick={() => onRemove(r)}>
                        拆除
                      </Button>
                    ) : null,
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

