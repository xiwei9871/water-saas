import {
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Radio,
  Result,
  Select,
  Space,
  Steps,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiErrorText } from '../../api/client';
import type { InstallReason, OnboardResult } from '../../api/types';
import {
  CUST_TYPE_LABELS,
  DECIMAL_RULE,
  INSTALL_REASON_LABELS,
  cleanBody,
  newIdemKey,
} from '../common';
import { CustomerSelect, MeterSelect, SettleAccountSelect } from '../pickers';

import UsageCategoryInput from './UsageCategoryInput';

type CustMode = 'new' | 'existing';
type SettleMode = 'default' | 'new' | 'existing';
type MeterMode = 'new' | 'existing';

interface WizardValues {
  custMode: CustMode;
  customerId?: string;
  custName?: string;
  custType?: 'PERSONAL' | 'ORG';
  custIdType?: string;
  custIdNo?: string;
  custPhone?: string;
  custAddr?: string;
  settleMode: SettleMode;
  settleAccountId?: string;
  settleName?: string;
  settlePhone?: string;
  acctUsageCategory: string;
  acctAddr: string;
  acctAccountNo?: string;
  acctOpenedAt?: dayjs.Dayjs;
  meterMode: MeterMode;
  meterId?: string;
  meterNo?: string;
  serialNo?: string;
  barcode?: string;
  brand?: string;
  model?: string;
  caliber?: string;
  maxDial?: string;
  initialReading: string;
  installedAt?: dayjs.Dayjs;
  reason?: InstallReason;
}

const STEPS = [
  { title: '客户', description: '新建或选择已有客户' },
  { title: '结算户', description: '默认同户主 / 新建 / 已有' },
  { title: '水表户', description: '用水类别与地址' },
  { title: '水表安装', description: '挂表与初始读数' },
];

/**
 * 立户向导：一条事务建出 客户 + 结算户 + 水表户 + 水表 + ACTIVE 装表记录。
 * Idempotency-Key 在向导挂载时生成一次 —— 重复提交/双击复用同一键，服务端
 * 按相同 body 直接回放首次响应，绝不会重复立户；新一轮向导才换新键。
 */
export default function Onboard() {
  const { message } = AntdApp.useApp();
  // One Idempotency-Key per wizard MOUNT (lazy useState init) — a retried
  // submit reuses it; only resetWizard mints a fresh one.
  const [idemKey, setIdemKey] = useState(newIdemKey);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OnboardResult | null>(null);
  const [form] = Form.useForm<WizardValues>();

  const custMode = Form.useWatch('custMode', form) ?? 'new';
  const settleMode = Form.useWatch('settleMode', form) ?? 'default';
  const meterMode = Form.useWatch('meterMode', form) ?? 'new';

  /** Fields to validate per step, given the currently selected modes. */
  const stepFields = (s: number): (keyof WizardValues)[] => {
    switch (s) {
      case 0:
        return custMode === 'new'
          ? ['custName', 'custType', 'custIdType', 'custIdNo', 'custPhone', 'custAddr']
          : ['customerId'];
      case 1:
        return settleMode === 'new'
          ? ['settleName', 'settlePhone']
          : settleMode === 'existing'
            ? ['settleAccountId']
            : [];
      case 2:
        return ['acctUsageCategory', 'acctAddr', 'acctAccountNo', 'acctOpenedAt'];
      default:
        return [
          ...(meterMode === 'new'
            ? (['meterNo', 'serialNo', 'barcode', 'brand', 'model', 'caliber', 'maxDial'] as const)
            : (['meterId'] as const)),
          'initialReading',
          'installedAt',
          'reason',
        ];
    }
  };

  const next = async () => {
    try {
      await form.validateFields(stepFields(step));
    } catch {
      return; // inline field errors are already shown
    }
    setStep((s) => s + 1);
  };

  const submit = async () => {
    let values: WizardValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const body: Record<string, unknown> = {
      account: cleanBody({
        usageCategory: values.acctUsageCategory,
        addr: values.acctAddr,
        accountNo: values.acctAccountNo,
        openedAt: values.acctOpenedAt?.format('YYYY-MM-DD'),
      }),
      installation: cleanBody({
        initialReading: values.initialReading,
        installedAt: values.installedAt?.format('YYYY-MM-DD'),
        reason: values.reason,
      }),
    };
    // 客户二选一：新建 payload 或引用已有 customerId
    if (custMode === 'new') {
      body.customer = cleanBody({
        name: values.custName,
        custType: values.custType,
        idType: values.custIdType,
        idNo: values.custIdNo,
        phone: values.custPhone,
        addr: values.custAddr,
      });
    } else {
      body.customerId = values.customerId;
    }
    // 结算户：default → 两个字段都不带（服务端按户主姓名/电话自动开立）
    if (settleMode === 'new') {
      body.settleAccount = cleanBody({
        name: values.settleName,
        phone: values.settlePhone,
      });
    } else if (settleMode === 'existing') {
      body.settleAccountId = values.settleAccountId;
    }
    // 水表二选一：登记新表或引用已有 AVAILABLE 表
    if (meterMode === 'new') {
      body.meter = cleanBody({
        meterNo: values.meterNo,
        serialNo: values.serialNo,
        barcode: values.barcode,
        brand: values.brand,
        model: values.model,
        caliber: values.caliber,
        maxDial: values.maxDial,
      });
    } else {
      body.meterId = values.meterId;
    }

    setSubmitting(true);
    try {
      const res = await api.post<OnboardResult>('/water-accounts/onboard', body, {
        headers: { 'Idempotency-Key': idemKey },
      });
      setResult(res.data);
      message.success('立户完成');
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  /** 新一轮立户：清表、回到第一步并换新幂等键。 */
  const resetWizard = () => {
    form.resetFields();
    setIdemKey(newIdemKey());
    setStep(0);
    setResult(null);
  };

  if (result) {
    return (
      <Card title="立户向导">
        <Result
          status="success"
          title="立户完成"
          subTitle="客户、结算户、水表户与水表已在同一事务中建好。"
          extra={[
            <Button type="primary" key="again" onClick={resetWizard}>
              继续立户
            </Button>,
            <Link
              key="view"
              to={`/customer/water-accounts?accountNo=${encodeURIComponent(result.waterAccount.accountNo)}`}
            >
              <Button>查看水表户</Button>
            </Link>,
          ]}
        />
        <Descriptions
          bordered
          size="small"
          column={{ xs: 1, md: 2 }}
          items={[
            {
              key: 'cust',
              label: '客户',
              children: `${result.customer.name}（${result.customer.customerNo}）`,
            },
            {
              key: 'settle',
              label: '结算户',
              children: `${result.settleAccount.name}（${result.settleAccount.settleNo}）`,
            },
            { key: 'acct', label: '户号', children: result.waterAccount.accountNo },
            { key: 'meter', label: '表号', children: result.meter.meterNo },
            {
              key: 'reading',
              label: '初始读数',
              children: result.installation.initialReading,
            },
            {
              key: 'installed',
              label: '装表时间',
              children: dayjs(result.installation.installedAt).format('YYYY-MM-DD HH:mm'),
            },
          ]}
        />
      </Card>
    );
  }

  return (
    <Card title="立户向导">
      <Steps current={step} items={STEPS} style={{ marginBottom: 24 }} />
      {/* 各步常驻挂载（隐藏而非卸载），提交时 validateFields 才能覆盖全部字段；
          模式互斥的字段仍随 radio 卸载，从而不被误校验。 */}
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          custMode: 'new',
          custType: 'PERSONAL',
          settleMode: 'default',
          meterMode: 'new',
          reason: 'NEW',
        }}
      >
        <div style={{ display: step === 0 ? 'block' : 'none' }}>
          <Form.Item name="custMode" label="客户来源">
            <Radio.Group
              options={[
                { value: 'new', label: '新建客户' },
                { value: 'existing', label: '选择已有客户' },
              ]}
              optionType="button"
            />
          </Form.Item>
          {custMode === 'existing' ? (
            <Form.Item
              name="customerId"
              label="已有客户"
              rules={[{ required: true, message: '请选择客户' }]}
            >
              <CustomerSelect />
            </Form.Item>
          ) : (
            <>
              <Form.Item
                name="custName"
                label="客户名称"
                rules={[{ required: true, message: '请输入客户名称' }]}
              >
                <Input />
              </Form.Item>
              <Form.Item
                name="custType"
                label="客户类型"
                rules={[{ required: true, message: '请选择客户类型' }]}
              >
                <Select
                  options={(['PERSONAL', 'ORG'] as const).map((t) => ({
                    value: t,
                    label: CUST_TYPE_LABELS[t],
                  }))}
                />
              </Form.Item>
              <Form.Item name="custIdType" label="证件类型">
                <Input placeholder="如 身份证 / 统一社会信用代码" />
              </Form.Item>
              <Form.Item name="custIdNo" label="证件号码">
                <Input />
              </Form.Item>
              <Form.Item name="custPhone" label="联系电话">
                <Input />
              </Form.Item>
              <Form.Item name="custAddr" label="联系地址">
                <Input />
              </Form.Item>
            </>
          )}
        </div>

        <div style={{ display: step === 1 ? 'block' : 'none' }}>
          <Form.Item name="settleMode" label="结算户">
            <Radio.Group
              options={[
                { value: 'default', label: '默认与户主一致' },
                { value: 'new', label: '新建结算户' },
                { value: 'existing', label: '选择已有结算户' },
              ]}
              optionType="button"
            />
          </Form.Item>
          {settleMode === 'default' && (
            <p style={{ color: '#888' }}>
              系统将按客户的姓名与联系电话自动开立同名结算户。
            </p>
          )}
          {settleMode === 'new' && (
            <>
              <Form.Item
                name="settleName"
                label="结算户名称"
                rules={[{ required: true, message: '请输入结算户名称' }]}
              >
                <Input />
              </Form.Item>
              <Form.Item name="settlePhone" label="联系电话">
                <Input />
              </Form.Item>
            </>
          )}
          {settleMode === 'existing' && (
            <Form.Item
              name="settleAccountId"
              label="已有结算户"
              rules={[{ required: true, message: '请选择结算户' }]}
            >
              <SettleAccountSelect />
            </Form.Item>
          )}
        </div>

        <div style={{ display: step === 2 ? 'block' : 'none' }}>
          <Form.Item
            name="acctUsageCategory"
            label="用水类别"
            rules={[{ required: true, message: '请输入用水类别' }]}
          >
            <UsageCategoryInput />
          </Form.Item>
          <Form.Item
            name="acctAddr"
            label="用水地址"
            rules={[{ required: true, message: '请输入用水地址' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="acctAccountNo"
            label="户号"
            extra="留空则由系统自动生成"
          >
            <Input />
          </Form.Item>
          <Form.Item name="acctOpenedAt" label="开户日期">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </div>

        <div style={{ display: step === 3 ? 'block' : 'none' }}>
          <Form.Item name="meterMode" label="水表">
            <Radio.Group
              options={[
                { value: 'new', label: '登记新表' },
                { value: 'existing', label: '选择库存可用表' },
              ]}
              optionType="button"
            />
          </Form.Item>
          {meterMode === 'existing' ? (
            <Form.Item
              name="meterId"
              label="库存水表"
              rules={[{ required: true, message: '请选择水表' }]}
            >
              <MeterSelect status="AVAILABLE" placeholder="仅列出可用水表" />
            </Form.Item>
          ) : (
            <>
              <Form.Item name="meterNo" label="表号" extra="留空则由系统自动生成">
                <Input />
              </Form.Item>
              <Form.Item name="serialNo" label="出厂编号">
                <Input />
              </Form.Item>
              <Form.Item name="barcode" label="条码">
                <Input />
              </Form.Item>
              <Form.Item name="brand" label="品牌">
                <Input />
              </Form.Item>
              <Form.Item name="model" label="型号">
                <Input />
              </Form.Item>
              <Form.Item name="caliber" label="口径">
                <Input placeholder="如 DN15" />
              </Form.Item>
              <Form.Item
                name="maxDial"
                label="最大读数（表位）"
                rules={[DECIMAL_RULE]}
              >
                <Input placeholder="如 99999" />
              </Form.Item>
            </>
          )}
          <Form.Item
            name="initialReading"
            label="装表初始读数"
            rules={[{ required: true, message: '请输入初始读数' }, DECIMAL_RULE]}
          >
            <Input placeholder="如 0" />
          </Form.Item>
          <Form.Item name="installedAt" label="装表日期">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reason" label="装表原因">
            <Select
              options={(
                ['NEW', 'REPLACE', 'FAULT', 'PERIODIC_CHECK'] as const
              ).map((r) => ({ value: r, label: INSTALL_REASON_LABELS[r] }))}
            />
          </Form.Item>
        </div>
      </Form>

      <Space style={{ marginTop: 8 }}>
        {step > 0 && <Button onClick={() => setStep((s) => s - 1)}>上一步</Button>}
        {step < STEPS.length - 1 && (
          <Button type="primary" onClick={() => void next()}>
            下一步
          </Button>
        )}
        {step === STEPS.length - 1 && (
          <Button type="primary" loading={submitting} onClick={() => void submit()}>
            提交立户
          </Button>
        )}
      </Space>
    </Card>
  );
}
