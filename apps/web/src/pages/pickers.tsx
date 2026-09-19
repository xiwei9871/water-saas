import { App as AntdApp, Select, Tag, TreeSelect } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiErrorText } from '../api/client';
import type {
  AccountStatus,
  Customer,
  InstallationStatus,
  Meter,
  MeterStatus,
  OrgUnit,
  ReadingBook,
  SettleAccount,
  Staff,
  WaterAccount,
} from '../api/types';
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

/**
 * Selected-option label cache — remote search replaces `options`, and a
 * Select shows the raw uuid once the picked option scrolls out of the
 * refreshed list. Remember labels by value so the display never flashes ids.
 * (Stable Map via lazy useState — reading ref.current during render is not
 * React-Compiler-safe.)
 */
const useLabelCache = () => useState(() => new Map<string, string>())[0];

/** Merge the currently-selected option back into a refreshed list. */
const withSelected = (
  options: Option[],
  value: string | undefined,
  labelCache: Map<string, string>,
): Option[] => {
  if (!value || options.some((o) => o.value === value)) return options;
  const label = labelCache.get(value) ?? `${value.slice(0, 8)}…`;
  return [...options, { value, label }];
};

/** 客户选择：?name= 模糊搜索（label = 名称（客户编号））。 */
export function CustomerSelect({ value, onChange, placeholder, disabled }: PickerProps) {
  const { message } = AntdApp.useApp();
  const [options, setOptions] = useState<Option[]>([]);
  const [fetching, setFetching] = useState(false);
  const labelCache = useLabelCache();

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
      options={withSelected(options, value, labelCache)}
      value={value}
      onChange={(v: string | undefined, option) => {
        if (v) {
          const l = (option as Option | undefined)?.label;
          if (l) labelCache.set(v, l);
        }
        onChange?.(v);
      }}
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
  const labelCache = useLabelCache();

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
      options={withSelected(options, value, labelCache)}
      value={value}
      onChange={(v: string | undefined, option) => {
        if (v) {
          const l = (option as Option | undefined)?.label;
          if (l) labelCache.set(v, l);
        }
        onChange?.(v);
      }}
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
 * 水表选择：?q= 远程模糊搜索（表号/序列号/条码/品牌/型号），可叠加
 * ?status= —— 注册表数超出一页也能搜到。
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
  const labelCache = useLabelCache();

  const fetch = useCallback(
    async (kw: string) => {
      setFetching(true);
      try {
        const res = await api.get<Meter[]>('/meters', {
          params: {
            take: 50,
            ...(kw.trim() ? { q: kw.trim() } : {}),
            ...(status ? { status } : {}),
          },
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
    },
    [message, status],
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
      placeholder={placeholder ?? '搜索表号/品牌'}
      disabled={disabled}
      loading={fetching}
      options={withSelected(options, value, labelCache)}
      value={value}
      onChange={(v: string | undefined, option) => {
        if (v) {
          const l = (option as Option | undefined)?.label;
          if (l) labelCache.set(v, l);
        }
        onChange?.(v);
      }}
      onSearch={onSearch}
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
  const labelCache = useLabelCache();

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
      options={withSelected(options, value, labelCache)}
      value={value}
      onChange={(v: string | undefined, option) => {
        if (v) {
          const l = (option as Option | undefined)?.label;
          if (l) labelCache.set(v, l);
        }
        onChange?.(v);
      }}
      notFoundContent={fetching ? '加载中…' : '该客户暂无水表户'}
    />
  );
}

/**
 * 员工选择（抄表员等）：/iam/staff 需 iam:read —— 调用方应先
 * hasPerm('iam:read') 判断，没有权限时隐藏或退化（抄表册默认取
 * 当前用户所属组织时同样处理）。全量拉取后本地过滤。
 */
export function StaffSelect({ value, onChange, placeholder, disabled }: PickerProps) {
  const { message } = AntdApp.useApp();
  const [options, setOptions] = useState<Option[]>([]);
  const [fetching, setFetching] = useState(false);
  const labelCache = useLabelCache();

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => setFetching(true));
    api
      .get<Staff[]>('/iam/staff')
      .then((res) => {
        if (cancelled) return;
        setOptions(
          res.data
            .filter((s) => s.status === 'ACTIVE')
            .map((s) => ({ value: s.id, label: `${s.name}（${s.login}）` })),
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
  }, [message]);

  return (
    <Select
      showSearch
      allowClear
      optionFilterProp="label"
      placeholder={placeholder ?? '选择员工'}
      disabled={disabled}
      loading={fetching}
      options={withSelected(options, value, labelCache)}
      value={value}
      onChange={(v: string | undefined, option) => {
        if (v) {
          const l = (option as Option | undefined)?.label;
          if (l) labelCache.set(v, l);
        }
        onChange?.(v);
      }}
      notFoundContent={fetching ? '加载中…' : '暂无员工'}
    />
  );
}

/**
 * 组织选择：/iam/orgs 需 iam:read —— 同上由调用方决定降级策略。
 * 数据权限受限的用户拿到的列表顶部可能不是真正的根（parentId 指向
 * 列表外），按 Staff 页的约定把这些节点当作根渲染。
 */
export function OrgUnitTreeSelect({
  value,
  onChange,
  placeholder,
  disabled,
}: PickerProps) {
  const { message } = AntdApp.useApp();
  const [orgs, setOrgs] = useState<OrgUnit[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<OrgUnit[]>('/iam/orgs')
      .then((res) => {
        if (!cancelled) setOrgs(res.data);
      })
      .catch((err) => {
        if (!cancelled) message.error(apiErrorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [message]);

  const treeData = useMemo<DataNode[]>(() => {
    const ids = new Set(orgs.map((o) => o.id));
    const roots = orgs.filter(
      (o) => o.parentId === null || !ids.has(o.parentId),
    );
    const build = (list: OrgUnit[]): DataNode[] =>
      list.map((o) => ({
        key: o.id,
        value: o.id,
        title: o.name,
        children: build(orgs.filter((c) => c.parentId === o.id)),
      }));
    return build(roots);
  }, [orgs]);

  return (
    <TreeSelect
      allowClear
      treeDefaultExpandAll
      treeData={treeData}
      placeholder={placeholder ?? '选择组织'}
      disabled={disabled}
      value={value}
      onChange={(v: string | undefined) => onChange?.(v)}
    />
  );
}

/** 抄表册选择：?name= 远程模糊搜索（label = 名称（册号））。 */
export function ReadingBookSelect({
  value,
  onChange,
  placeholder,
  disabled,
}: PickerProps) {
  const { message } = AntdApp.useApp();
  const [options, setOptions] = useState<Option[]>([]);
  const [fetching, setFetching] = useState(false);
  const labelCache = useLabelCache();

  const fetch = useCallback(
    async (kw: string) => {
      setFetching(true);
      try {
        const res = await api.get<ReadingBook[]>('/reading-books', {
          params: { take: 50, ...(kw.trim() ? { name: kw.trim() } : {}) },
        });
        setOptions(
          res.data.map((b) => ({
            value: b.id,
            label: `${b.name}（${b.bookNo}）`,
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
      placeholder={placeholder ?? '搜索抄表册名称'}
      disabled={disabled}
      loading={fetching}
      options={withSelected(options, value, labelCache)}
      value={value}
      onChange={(v: string | undefined, option) => {
        if (v) {
          const l = (option as Option | undefined)?.label;
          if (l) labelCache.set(v, l);
        }
        onChange?.(v);
      }}
      onSearch={onSearch}
      notFoundContent={fetching ? '加载中…' : '无匹配抄表册'}
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
