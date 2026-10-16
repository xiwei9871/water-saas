import {
  AlertOutlined,
  DashboardOutlined,
  FileTextOutlined,
  GoldOutlined,
  PayCircleOutlined,
  ReadOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  TransactionOutlined,
} from '@ant-design/icons';

import type { ReactNode } from 'react';
import Home from './pages/Home';
import BillingRuns from './pages/billing/BillingRuns';
import Bills from './pages/billing/Bills';
import FeeItems from './pages/billing/FeeItems';
import Tariffs from './pages/billing/Tariffs';
import Customers from './pages/customer/Customers';
import Meters from './pages/customer/Meters';
import Onboard from './pages/customer/Onboard';
import SettleAccounts from './pages/customer/SettleAccounts';
import WaterAccounts from './pages/customer/WaterAccounts';
import Exceptions from './pages/exception/Exceptions';
import MeterReadings from './pages/metering/MeterReadings';
import ReadingBooks from './pages/metering/ReadingBooks';
import ReadingPlans from './pages/metering/ReadingPlans';
import RemoteDevices from './pages/metering/RemoteDevices';
import RemoteEvents from './pages/metering/RemoteEvents';
import RemoteSources from './pages/metering/RemoteSources';
import Cashier from './pages/payment/Cashier';
import CollectionNotices from './pages/payment/CollectionNotices';
import DayClose from './pages/payment/DayClose';
import Payments from './pages/payment/Payments';
import Prepayments from './pages/payment/Prepayments';
import ReceiptDocs from './pages/payment/ReceiptDocs';
import Recon from './pages/payment/Recon';
import Writeoffs from './pages/payment/Writeoffs';
import InstallApplications from './pages/install/Applications';
import Analysis from './pages/report/Analysis';
import MetricDict from './pages/report/MetricDict';
import MetricQuery from './pages/report/MetricQuery';
import OpsMonthly from './pages/report/OpsMonthly';
import OpsYearly from './pages/report/OpsYearly';
import UnifiedQuery from './pages/report/UnifiedQuery';
import Tasks from './pages/tasks/Tasks';
import Reconciliations from './pages/settlement/Reconciliations';
import Settlements from './pages/settlement/Settlements';
import AuditLogs from './pages/system/AuditLogs';
import Dicts from './pages/system/Dicts';
import Orgs from './pages/system/Orgs';
import Roles from './pages/system/Roles';
import Staff from './pages/system/Staff';
import TenantParams from './pages/system/TenantParams';

/**
 * THE menu + route source of truth.
 *
 * - `perms`: ANY listed code grants visibility ('*' users see everything);
 *   undefined = always visible.
 * - `element`: page component. Entries WITHOUT an element render the shared
 *   "建设中" placeholder — T15/T16 fill them in by setting `element` here
 *   (and, for the group pages, replacing the single placeholder path with a
 *   `children` list).
 * - `children` turn the entry into a menu submenu; child paths are absolute.
 */
export interface AppRoute {
  key: string;
  path: string;
  label: string;
  icon?: ReactNode;
  perms?: string[];
  element?: ReactNode;
  children?: AppRoute[];
}

export const APP_ROUTES: AppRoute[] = [
  {
    key: 'workbench',
    path: '/',
    label: '工作台',
    icon: <DashboardOutlined />,
    element: <Home />,
  },
  {
    key: 'exceptions',
    path: '/exceptions',
    label: '异常中心',
    icon: <AlertOutlined />,
    perms: ['exception:read'],
    element: <Exceptions />,
  },
  {
    key: 'tasks',
    path: '/tasks',
    label: '待办中心',
    icon: <FileTextOutlined />,
    element: <Tasks />,
  },
  {
    key: 'customer',
    path: '/customer',
    label: '客户管理',
    icon: <TeamOutlined />,
    perms: ['customer:read'],
    children: [
      // 立户是纯写操作 —— 只读用户从菜单隐藏（路由层 PermRoute 同样拦截）。
      {
        key: 'customer-onboard',
        path: '/customer/onboard',
        label: '立户向导',
        perms: ['customer:write'],
        element: <Onboard />,
      },
      {
        key: 'customer-customers',
        path: '/customer/customers',
        label: '客户列表',
        element: <Customers />,
      },
      {
        key: 'customer-water-accounts',
        path: '/customer/water-accounts',
        label: '用水户',
        element: <WaterAccounts />,
      },
      {
        key: 'customer-settle-accounts',
        path: '/customer/settle-accounts',
        label: '结算户',
        element: <SettleAccounts />,
      },
      {
        key: 'customer-meters',
        path: '/customer/meters',
        label: '水表管理',
        element: <Meters />,
      },
    ],
  },
  {
    key: 'metering',
    path: '/metering',
    label: '抄表管理',
    icon: <ReadOutlined />,
    perms: ['metering:read'],
    children: [
      {
        key: 'metering-books',
        path: '/metering/books',
        label: '抄表册',
        element: <ReadingBooks />,
      },
      {
        key: 'metering-plans',
        path: '/metering/plans',
        label: '抄表计划',
        element: <ReadingPlans />,
      },
      {
        key: 'metering-readings',
        path: '/metering/readings',
        label: '抄表记录',
        element: <MeterReadings />,
      },
      {
        key: 'metering-remote-sources',
        path: '/metering/remote-sources',
        label: '远传数据源',
        element: <RemoteSources />,
      },
      {
        key: 'metering-remote-devices',
        path: '/metering/remote-devices',
        label: '远传设备',
        element: <RemoteDevices />,
      },
      {
        key: 'metering-remote-events',
        path: '/metering/remote-events',
        label: '远传事件',
        element: <RemoteEvents />,
      },
    ],
  },
  {
    key: 'settlement',
    path: '/settlement',
    label: '结算补差',
    icon: <TransactionOutlined />,
    // settlement 列表归 metering，reconciliation 归 billing — 任一可读即显示。
    perms: ['metering:read', 'billing:read'],
    children: [
      {
        key: 'settlement-list',
        path: '/settlement/list',
        label: '结算水量',
        perms: ['metering:read'],
        element: <Settlements />,
      },
      {
        key: 'settlement-reconciliations',
        path: '/settlement/reconciliations',
        label: '补差管理',
        perms: ['billing:read'],
        element: <Reconciliations />,
      },
    ],
  },
  {
    key: 'billing',
    path: '/billing',
    label: '计费管理',
    icon: <GoldOutlined />,
    perms: ['billing:read'],
    children: [
      {
        key: 'billing-tariffs',
        path: '/billing/tariffs',
        label: '资费计划',
        element: <Tariffs />,
      },
      {
        key: 'billing-fee-items',
        path: '/billing/fee-items',
        label: '费用项',
        element: <FeeItems />,
      },
      {
        key: 'billing-runs',
        path: '/billing/runs',
        label: '开账批次',
        element: <BillingRuns />,
      },
      {
        key: 'billing-bills',
        path: '/billing/bills',
        label: '账单',
        element: <Bills />,
      },
    ],
  },
  {
    key: 'payment',
    path: '/payment',
    label: '收费管理',
    icon: <PayCircleOutlined />,
    perms: ['payment:read'],
    children: [
      // 收费台以 payment:write 为主（查欠费只读可看，收款动作再按写权限隐藏）。
      {
        key: 'payment-counter',
        path: '/payment/counter',
        label: '收费台',
        element: <Cashier />,
      },
      {
        key: 'payment-payments',
        path: '/payment/payments',
        label: '收款记录',
        element: <Payments />,
      },
      {
        key: 'payment-prepayments',
        path: '/payment/prepayments',
        label: '预存管理',
        element: <Prepayments />,
      },
      {
        key: 'payment-day-close',
        path: '/payment/day-close',
        label: '收费员日结',
        element: <DayClose />,
      },
      {
        key: 'payment-writeoffs',
        path: '/payment/writeoffs',
        label: '坏账核销',
        element: <Writeoffs />,
      },
      {
        key: 'payment-notices',
        path: '/payment/collection-notices',
        label: '催缴通知',
        element: <CollectionNotices />,
      },
      {
        key: 'payment-recon',
        path: '/payment/recon',
        label: '渠道对账',
        element: <Recon />,
      },
      {
        key: 'payment-receipt-docs',
        path: '/payment/receipt-docs',
        label: '票据台账',
        element: <ReceiptDocs />,
      },
    ],
  },
  // S1 报装管理：独立于营销菜单组的业扩域（申请→勘察→审批→装表→归档）。
  {
    key: 'install',
    path: '/install',
    label: '报装管理',
    icon: <FileTextOutlined />,
    perms: ['install:read'],
    children: [
      {
        key: 'install-applications',
        path: '/install/applications',
        label: '报装申请',
        perms: ['install:read'],
        element: <InstallApplications />,
      },
    ],
  },
  {
    key: 'report',
    path: '/report',
    label: '报表',
    icon: <FileTextOutlined />,
    perms: ['report:read'],
    children: [
      // 需求§三：报表 = 日报/月报/年报 3 张（总量+分类+异常明细），
      // 明细查询与指标字典不属于报表（整改报告 2026-10-14）。
      {
        key: 'report-ops-daily',
        path: '/report/ops-daily',
        label: '日报',
        element: <Analysis key="ops-daily" kind="ops-daily" />,
      },
      {
        key: 'report-analysis-monthly',
        path: '/report/analysis-monthly',
        label: '月报',
        element: <OpsMonthly />,
      },
      {
        key: 'report-analysis-yearly',
        path: '/report/analysis-yearly',
        label: '年报',
        element: <OpsYearly />,
      },
    ],
  },
  {
    key: 'query',
    path: '/query',
    label: '数据查询',
    icon: <SearchOutlined />,
    perms: ['report:read'],
    children: [
      {
        key: 'query-unified',
        path: '/report/query/unified',
        label: '统一查询',
        element: <UnifiedQuery />,
      },
      {
        key: 'query-metrics',
        path: '/report/query/metrics',
        label: '指标查询',
        element: <MetricQuery />,
      },
    ],
  },
  {
    key: 'system',
    path: '/system',
    label: '系统管理',
    icon: <SettingOutlined />,
    perms: ['iam:read'],
    children: [
      { key: 'system-orgs', path: '/system/orgs', label: '组织管理', element: <Orgs /> },
      { key: 'system-staff', path: '/system/staff', label: '用户管理', element: <Staff /> },
      { key: 'system-roles', path: '/system/roles', label: '角色权限', element: <Roles /> },
      { key: 'system-params', path: '/system/params', label: '租户参数', element: <TenantParams /> },
      { key: 'system-dicts', path: '/system/dicts', label: '字典管理', element: <Dicts /> },
      {
        key: 'system-metric-dict',
        path: '/report/metric-dict',
        label: '指标字典',
        element: <MetricDict />,
        // 报表读者也要看口径，不被系统管理组的 iam:read 继承遮蔽
        perms: ['report:read'],
      },
      { key: 'system-audit', path: '/system/audit-logs', label: '操作日志', element: <AuditLogs /> },
    ],
  },
];

/**
 * Flat leaf routes (children spliced in place of their parent). A child
 * without its own `perms` inherits the parent's — the same visibility rule
 * the menu applies implicitly by hiding the whole group.
 */
export const leafRoutes = (
  routes: AppRoute[] = APP_ROUTES,
  inherited?: string[],
): AppRoute[] =>
  routes.flatMap((r) => {
    const perms = r.perms ?? inherited;
    if (r.children) return leafRoutes(r.children, perms);
    return [{ ...r, perms }];
  });
