import {
  DashboardOutlined,
  FileTextOutlined,
  GoldOutlined,
  PayCircleOutlined,
  ReadOutlined,
  SettingOutlined,
  TeamOutlined,
  TransactionOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import Workbench from './pages/Workbench';
import Customers from './pages/customer/Customers';
import Meters from './pages/customer/Meters';
import Onboard from './pages/customer/Onboard';
import SettleAccounts from './pages/customer/SettleAccounts';
import WaterAccounts from './pages/customer/WaterAccounts';
import MeterReadings from './pages/metering/MeterReadings';
import ReadingBooks from './pages/metering/ReadingBooks';
import ReadingPlans from './pages/metering/ReadingPlans';
import Reconciliations from './pages/settlement/Reconciliations';
import Settlements from './pages/settlement/Settlements';
import AuditLogs from './pages/system/AuditLogs';
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
    element: <Workbench />,
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
        label: '水表户',
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
        label: '水表档案',
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
  },
  {
    key: 'payment',
    path: '/payment',
    label: '收费管理',
    icon: <PayCircleOutlined />,
    perms: ['payment:read'],
  },
  {
    key: 'report',
    path: '/report',
    label: '报表',
    icon: <FileTextOutlined />,
    perms: ['report:read'],
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
