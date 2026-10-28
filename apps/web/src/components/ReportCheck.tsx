import { useMemo, useState } from 'react';
import { Badge, Descriptions, Drawer, Empty, Table, Tag, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, WarningFilled } from '@ant-design/icons';

/**
 * 报表数据自检（20261028 v3）：标题旁常驻「数据自检」状态徽章，
 * 点击滑出明细抽屉——阻断置顶标红，逐项列 规则+公式+实际/期望/差额+结论。
 */

export interface CheckResult {
  rule: string;
  name: string;
  level: 'BLOCK' | 'WARN';
  passed: boolean;
  actual: string | null;
  expected: string | null;
  diff: string | null;
  message: string;
  target?: string;
}

const levelOf = (r: CheckResult) =>
  r.passed ? 'PASS' : r.level;

export function ReportCheckBadge({ results }: { results?: CheckResult[] }) {
  const [open, setOpen] = useState(false);
  const { blocks, warns } = useMemo(() => {
    const fails = (results ?? []).filter((r) => !r.passed);
    return {
      blocks: fails.filter((r) => r.level === 'BLOCK'),
      warns: fails.filter((r) => r.level === 'WARN'),
    };
  }, [results]);
  if (!results || results.length === 0) return null;

  const badge =
    blocks.length > 0 ? (
      <Tag color="red" icon={<CloseCircleFilled />} style={{ cursor: 'pointer' }}>
        数据自检 ✗ {blocks.length} 项阻断性异常
      </Tag>
    ) : warns.length > 0 ? (
      <Tag color="orange" icon={<WarningFilled />} style={{ cursor: 'pointer' }}>
        数据自检 ⚠ {warns.length} 项警告
      </Tag>
    ) : (
      <Tag color="green" icon={<CheckCircleFilled />} style={{ cursor: 'pointer' }}>
        数据自检 ✓ 通过
      </Tag>
    );

  const sorted = [...blocks, ...warns, ...results.filter((r) => r.passed)];

  return (
    <>
      <Badge
        count={blocks.length}
        size="small"
        offset={[2, -4]}
        onClick={() => setOpen(true)}
      >
        {badge}
      </Badge>
      {blocks.length > 0 && (
        <Typography.Text type="danger" style={{ fontSize: 12, marginLeft: 6 }}>
          数据存在阻断性异常，请处理后复核
        </Typography.Text>
      )}
      <Drawer
        title="报表数据自检明细"
        open={open}
        width={720}
        onClose={() => setOpen(false)}
      >
        {sorted.length === 0 && <Empty description="无校验项" />}
        <Table<CheckResult>
          rowKey="rule"
          size="small"
          pagination={false}
          dataSource={sorted}
          rowClassName={(r) => (!r.passed && r.level === 'BLOCK' ? 'check-row-block' : '')}
          columns={[
            {
              title: '结论',
              width: 64,
              render: (_, r) =>
                levelOf(r) === 'PASS' ? (
                  <Tag color="green">✓ 通过</Tag>
                ) : r.level === 'BLOCK' ? (
                  <Tag color="red">✗ 阻断</Tag>
                ) : (
                  <Tag color="orange">⚠ 警告</Tag>
                ),
            },
            { title: '规则', dataIndex: 'rule', width: 56 },
            {
              title: '规则与公式',
              render: (_, r) => (
                <div>
                  <div style={{ fontWeight: r.passed ? 400 : 600 }}>{r.name}</div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{r.message}</div>
                </div>
              ),
            },
            {
              title: '实际 / 期望 / 差额',
              width: 220,
              render: (_, r) => (
                <Descriptions column={1} size="small" style={{ fontSize: 12 }}>
                  <Descriptions.Item label="实际">{r.actual ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="期望">{r.expected ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="差额">{r.diff ?? '—'}</Descriptions.Item>
                </Descriptions>
              ),
            },
          ]}
        />
        <style>{`.check-row-block td { background: #fff1f0 !important; }`}</style>
      </Drawer>
    </>
  );
}
