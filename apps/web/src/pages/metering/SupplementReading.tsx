import { Alert, App as AntdApp, Button, Card, DatePicker, Descriptions, Form, Input, Space, Steps, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import {
  type ReadingBook,
  type ReadingPlan,
  type WaterAccount,
} from '../../api/types';
import { USAGE_CATEGORY_LABELS, enumLabel, fmtDate, fmtPeriod, newIdemKey } from '../common';
import { PLAN_STATUS_COLORS, PLAN_STATUS_LABELS } from './common';
import { StaffSelect, WaterAccountSearchSelect } from '../pickers';
import Table from '../../components/PageTable';


interface SupplementResponse extends ReadingPlan {
  taskId: string | null;
  deduped: boolean;
}

/**
 * 20261026 追加抄表独立功能：计划/任务层主动发起（未抄先派单）。
 * 搜户 → 带出所属册+默认抄表员 → 确认抄表员/账期 → 下达 →
 * 单户 SUPPLEMENT 计划 + SUPPLEMENT_READING 任务直接指派给抄表员。
 * 与读数层「抄表记录→更正→追加」并存（本页为主入口）。
 */
export default function SupplementReading() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [account, setAccount] = useState<WaterAccount | null>(null);
  const [books, setBooks] = useState<ReadingBook[]>([]);
  const [booksLoading, setBooksLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [idemKey, setIdemKey] = useState(newIdemKey());
  const [recent, setRecent] = useState<SupplementResponse[]>([]);

  const loadRecent = useCallback(async () => {
    try {
      const res = await api.get<SupplementResponse[]>('/reading-plans', {
        params: { take: 20, planType: 'SUPPLEMENT' },
      });
      setRecent(res.data.filter((p) => p.planType === 'SUPPLEMENT'));
    } catch {
      // 列表接口旧版无 planType 参数时降级为不显示
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void loadRecent());
  }, [loadRecent]);

  /** 选户 → 反查所属册与默认抄表员（GET /reading-books?waterAccountId=）。 */
  const onAccount = async (acc: WaterAccount | undefined) => {
    setAccount(acc ?? null);
    setBooks([]);
    if (!acc) {
      form.setFieldsValue({ readerId: undefined });
      return;
    }
    setBooksLoading(true);
    try {
      const res = await api.get<ReadingBook[]>('/reading-books', {
        params: { waterAccountId: acc.id, take: 20 },
      });
      setBooks(res.data);
      // 默认抄表员 = 第一所属册的册默认抄表员；无册/无默认 → 置空强制手选。
      const reader = res.data.find((b) => b.readerId)?.readerId ?? undefined;
      form.setFieldsValue({ readerId: reader });
    } catch (e) {
      message.error(apiErrorText(e));
    } finally {
      setBooksLoading(false);
    }
  };

  const submit = async () => {
    const v = await form.validateFields();
    if (!account) {
      message.warning('请先选择目标用水户');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<SupplementResponse>(
        '/reading-plans/supplement',
        {
          waterAccountId: account.id,
          period: v.period.format('YYYYMM'),
          planDate: v.planDate?.format('YYYY-MM-DD'),
          readerId: v.readerId,
          remark: v.remark || undefined,
        },
        { headers: { 'Idempotency-Key': idemKey } },
      );
      message.success(
        res.data.deduped
          ? '该户该账期已有在途追加计划，已复用原计划与任务'
          : '追加抄表计划与任务已下达，抄表员可在待办领取执行',
      );
      form.resetFields(['remark']);
      setIdemKey(newIdemKey());
      void loadRecent();
    } catch (e) {
      message.error(apiErrorText(e));
    } finally {
      setSaving(false);
    }
  };

  const recentCols: ColumnsType<SupplementResponse> = [
    { title: '账期', dataIndex: 'period', width: 100, render: fmtPeriod },
    {
      title: '抄表册',
      width: 180,
      render: (_, r) => (r.bookName ? `${r.bookName}（${r.bookNo}）` : '—'),
    },
    {
      title: '抄表员',
      dataIndex: 'readerName',
      width: 120,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <Tag color={PLAN_STATUS_COLORS[s as keyof typeof PLAN_STATUS_COLORS]}>
          {enumLabel(PLAN_STATUS_LABELS, s)}
        </Tag>
      ),
    },
    { title: '下达时间', dataIndex: 'createdAt', width: 160, render: fmtDate },
  ];

  return (
    <Card title="追加抄表（主动发起）" style={{ maxWidth: 960 }}>
      <Steps
        size="small"
        current={account ? 2 : 0}
        style={{ marginBottom: 20 }}
        items={[
          { title: '选择用水户' },
          { title: '确认册 / 抄表员' },
          { title: '确认账期并下达' },
        ]}
      />
      <Form
        form={form}
        layout="vertical"
        initialValues={{ period: dayjs(), planDate: dayjs() }}
      >
        <Form.Item label="目标用水户" required>
          <WaterAccountSearchSelect
            placeholder="输入户号 / 客户名 / 地址搜索"
            onSelect={(a) => void onAccount(a)}
          />
        </Form.Item>
        {account && (
          <Descriptions
            size="small"
            column={3}
            bordered
            style={{ marginBottom: 16 }}
            items={[
              { key: 'no', label: '户号', children: account.accountNo },
              {
                key: 'cust',
                label: '户名',
                children: account.customer?.name ?? '—',
              },
              {
                key: 'cat',
                label: '用水类别',
                children: USAGE_CATEGORY_LABELS[account.usageCategory] ?? account.usageCategory,
              },
              { key: 'addr', label: '地址', children: account.addr, span: 2 },
              {
                key: 'meter',
                label: '在装表',
                children: account.currentMeterNo ?? '无在装表',
              },
              {
                key: 'book',
                label: '所属抄表册',
                span: 3,
                children: booksLoading
                  ? '查询中…'
                  : books.length
                    ? books.map((b) => `${b.name}（${b.bookNo}）`).join('、')
                    : '未纳入任何抄表册',
              },
            ]}
          />
        )}
        {account && !booksLoading && books.length === 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="该户未纳入任何抄表册，无默认抄表员——请手动指定抄表员后再下达"
          />
        )}
        <Space size={16} wrap align="start" style={{ display: 'flex' }}>
          <Form.Item
            name="readerId"
            label="抄表员"
            rules={[{ required: true, message: '请选择抄表员' }]}
            tooltip="默认带出所属册的默认抄表员；未入册户必须手动指定"
          >
            <StaffSelect placeholder="选择执行抄表的员工" />
          </Form.Item>
          <Form.Item
            name="period"
            label="账期"
            rules={[{ required: true, message: '请选择账期' }]}
            tooltip="默认当月，可改为需要补抄的历史/未来账期"
          >
            <DatePicker picker="month" allowClear={false} />
          </Form.Item>
          <Form.Item name="planDate" label="计划抄表日" tooltip="默认当天，可改">
            <DatePicker allowClear={false} />
          </Form.Item>
        </Space>
        <Form.Item name="remark" label="备注（选填）">
          <Input.TextArea
            rows={2}
            maxLength={200}
            placeholder="下达原因、现场提示等，将进入任务要素"
          />
        </Form.Item>
        <Button
          type="primary"
          size="large"
          disabled={!account}
          loading={saving}
          onClick={() => void submit()}
        >
          下达追加抄表
        </Button>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
          下达后生成「追加抄表计划 + 追加抄表任务」，任务直接指派给抄表员待办；
          抄表员现场回填读数走质检链路。该期未开账：追加读数作为本期最新读数生效；
          已开账：作为独立读数记录，走补差结算（与「抄表记录→更正→追加」同口径）。
        </Typography.Paragraph>
      </Form>

      {recent.length > 0 && (
        <>
          <Typography.Title level={5} style={{ marginTop: 24 }}>
            近期追加计划
          </Typography.Title>
          <Table<SupplementResponse> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
            rowKey="id"
            size="small"
            columns={recentCols}
            dataSource={recent}
            pagination={false}
          />
        </>
      )}
    </Card>
  );
}
