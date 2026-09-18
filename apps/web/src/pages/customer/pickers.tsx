import { App as AntdApp, Select, Tag } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import type {
  AccountStatus,
  Customer,
  InstallationStatus,
  Meter,
  MeterStatus,
  SettleAccount,
  WaterAccount,
} from '../../api/types';
import {
  ACCOUNT_STATUS_COLORS,
  ACCOUNT_STATUS_LABELS,
  INSTALLATION_STATUS_COLORS,
  INSTALLATION_STATUS_LABELS,
  METER_STATUS_COLORS,
  METER_STATUS_LABELS,
} from './common';

/**
 * uuid 选择器约定：绝不让用户手填 uuid —— 客户/结算户走后端模糊搜索
 * （?name= 子串匹配），水表/水表户取一页数据后由 Select 本地过滤。
 */

interface PickerProps {
  value?: string;
  onChange?: (value: string | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
}

interface Option {
  value: string;
  label: string;
}

/** Debounce a search callback so a request doesn't fire per keystroke. */
const useDebounced = (fn: (kw: string) => void, ms = 300) => {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(
    (kw: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fn(kw), ms);
    },
    [fn, ms],
  );
};

/** 客户选择：?name= 模糊搜索（label = 名称（客户编号））。 */
export function CustomerSelect({ value, onChange, placeholder, disabled }: PickerProps) {
  const { message } = AntdApp.useApp();
  const [options, setOptions] = useState<Option[]>([]);
  const [fetching, setFetching] = useState(false);

  const fetch = useCallback(
    async (kw: string) => {
      setFetching(true);
      try {
        const res = await api.get<Customer[]>('/customers', {
          params: { take: 50, ...(kw.trim() ? { name: kw.trim() } : {}) },
        });
        setOptions(
          res.data.map((c) => ({
            value: c.id,
            label: `${c.name}（${c.customerNo}）`,
          })),
        );
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setFetching(false);
      }
    },
    [message],
  );

  useEffect(() => {
    // Defer to a microtask — setState must not run synchronously in effects.
    queueMicrotask(() => void fetch(''));
  }, [fetch]);
  const onSearch = useDebounced((kw) => void fetch(kw));

  return (
    <Select
      showSearch
      allowClear
      filterOption={false}
      placeholder={placeholder ?? '搜索客户名称'}
      disabled={disabled}
      loading={fetching}
      options={options}
      value={value}
      onChange={(v: string | undefined) => onChange?.(v)}
      onSearch={onSearch}
      notFoundContent={fetching ? '加载中…' : '无匹配客户'}
    />
  );
}

/** 结算户选择：?name= 模糊搜索（label = 名称（结算号））。 */
export function SettleAccountSelect({
  value,
  onChange,
  placeholder,
  disabled,
}: PickerProps) {
  const { message } = AntdApp.useApp();
  const [options, setOptions] = useState<Option[]>([]);
  const [fetching, setFetching] = useState(false);

  const fetch = useCallback(
    async (kw: string) => {
      setFetching(true);
      try {
        const res = await api.get<SettleAccount[]>('/settle-accounts', {
          params: { take: 50, ...(kw.trim() ? { name: kw.trim() } : {}) },
        });
        setOptions(
          res.data.map((s) => ({
            value: s.id,
            label: `${s.name}（${s.settleNo}）`,
          })),
        );
      } catch (err) {
        message.error(apiErrorText(err));
      } finally {
        setFetching(false);
      }
    },
    [message],
  );

  useEffect(() => {
    queueMicrotask(() => void fetch(''));
  }, [fetch]);
  const onSearch = useDebounced((kw) => void fetch(kw));

  return (
    <Select
      showSearch
      allowClear
      filterOption={false}
      placeholder={placeholder ?? '搜索结算户名称'}
      disabled={disabled}
      loading={fetching}
      options={options}
      value={value}
      onChange={(v: string | undefined) => onChange?.(v)}
      onSearch={onSearch}
      notFoundContent={fetching ? '加载中…' : '无匹配结算户'}
    />
  );
}

interface MeterSelectProps extends PickerProps {
  /** Limit the fetched page to one status (e.g. AVAILABLE for install). */
  status?: MeterStatus;
}

/**
 * 水表选择：列表接口只有 ?status= 过滤 —— 取一页（200）后用 Select 的
 * optionFilterProp 按 label（表号/品牌/型号/口径）本地过滤。
 */
export function MeterSelect({
  value,
  onChange,
  placeholder,
  disabled,
  status,
}: MeterSelectProps) {
  const { message } = AntdApp.useApp();
  const [options, setOptions] = useState<Option[]>([]);
  const [fetching, setFetching] = useState(false);

  const fetch = useCallback(async () => {
    setFetching(true);
    try {
      const res = await api.get<Meter[]>('/meters', {
        params: { take: 200, ...(status ? { status } : {}) },
      });
      setOptions(
        res.data.map((m) => ({
          value: m.id,
          label: [m.meterNo, m.brand, m.model, m.caliber]
            .filter(Boolean)
            .join(' · '),
        })),
      );
    } catch (err) {
      message.error(apiErrorText(err));
    } finally {
      setFetching(false);
    }
  }, [message, status]);

  useEffect(() => {
    queueMicrotask(() => void fetch());
  }, [fetch]);

  return (
    <Select
      showSearch
      allowClear
      optionFilterProp="label"
      placeholder={placeholder ?? '搜索表号/品牌'}
      disabled={disabled}
      loading={fetching}
      options={options}
      value={value}
      onChange={(v: string | undefined) => onChange?.(v)}
      notFoundContent={fetching ? '加载中…' : '无匹配水表'}
    />
  );
}

interface WaterAccountSelectProps extends PickerProps {
  /** Options = this customer's accounts; empty/disabled until set. */
  customerId?: string;
}

/**
 * 水表户选择：户号过滤是精确匹配，不适合远程搜索 —— 改为级联：先选客户，
 * 再拉取其名下全部水表户（?customerId=）本地过滤。
 */
export function WaterAccountSelect({
  value,
  onChange,
  placeholder,
  disabled,
  customerId,
}: WaterAccountSelectProps) {
  const { message } = AntdApp.useApp();
  const [options, setOptions] = useState<Option[]>([]);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (!customerId) {
      queueMicrotask(() => setOptions([]));
      return;
    }
    let cancelled = false;
    queueMicrotask(() => setFetching(true));
    api
      .get<WaterAccount[]>('/water-accounts', {
        params: { customerId, take: 200 },
      })
      .then((res) => {
        if (cancelled) return;
        setOptions(
          res.data.map((a) => ({
            value: a.id,
            label: `${a.accountNo} · ${a.usageCategory} · ${a.addr}`,
          })),
        );
      })
      .catch((err) => {
        if (!cancelled) message.error(apiErrorText(err));
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, message]);

  return (
    <Select
      showSearch
      allowClear
      optionFilterProp="label"
      placeholder={
        customerId ? (placeholder ?? '选择水表户') : '请先选择客户'
      }
      disabled={disabled || !customerId}
      loading={fetching}
      options={options}
      value={value}
      onChange={(v: string | undefined) => onChange?.(v)}
      notFoundContent={fetching ? '加载中…' : '该客户暂无水表户'}
    />
  );
}

/* ---- enum → 中文 Tag ---- */

export function AccountStatusTag({ status }: { status: AccountStatus }) {
  return (
    <Tag color={ACCOUNT_STATUS_COLORS[status]}>
      {ACCOUNT_STATUS_LABELS[status]}
    </Tag>
  );
}

export function MeterStatusTag({ status }: { status: MeterStatus }) {
  return (
    <Tag color={METER_STATUS_COLORS[status]}>{METER_STATUS_LABELS[status]}</Tag>
  );
}

export function InstallationStatusTag({
  status,
}: {
  status: InstallationStatus;
}) {
  return (
    <Tag color={INSTALLATION_STATUS_COLORS[status]}>
      {INSTALLATION_STATUS_LABELS[status]}
    </Tag>
  );
}
