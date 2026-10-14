import { BellOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { Badge, Button, Layout, Menu, Space, Spin, Tag } from 'antd';
import type { MenuProps } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { APP_ROUTES, leafRoutes } from '../routes';
import type { AppRoute } from '../routes';

const { Sider, Header, Content } = Layout;

type MenuItem = Required<MenuProps>['items'][number];

/** Route tree → AntD menu items, filtered by permission.
 *  异常徽标按处置页（byPage）挂到叶子子栏目，父组显示后代合计；
 *  徽标跟在文字后面内联渲染，不再包住文字造成遮挡。 */
const toMenuItems = (
  routes: AppRoute[],
  hasPerm: (...codes: string[]) => boolean,
  badge?: { total: number; byPage: Record<string, number> },
): MenuItem[] =>
  routes
    .filter((r) => !r.perms || hasPerm(...r.perms))
    .map((r) => {
      const leafCount = (path: string): number =>
        path === '/exceptions' ? (badge?.total ?? 0) : (badge?.byPage?.[path] ?? 0);
      const subtreeCount = (node: AppRoute): number =>
        (leafCount(node.path) || 0) +
        (node.children ?? []).reduce((s, c) => s + subtreeCount(c), 0);
      const n = subtreeCount(r);
      const label =
        n > 0 ? (
          <span>
            {r.label}
            <Badge count={n} size="small" style={{ marginLeft: 8 }} />
          </span>
        ) : (
          r.label
        );
      return {
        key: r.path,
        icon: r.icon,
        label,
        children: r.children ? toMenuItems(r.children, hasPerm, badge) : undefined,
      };
    });

/** Best matching menu key for the current location (longest path wins). */
const selectedKeyOf = (pathname: string): string => {
  const match = leafRoutes()
    .filter((r) => pathname === r.path || pathname.startsWith(`${r.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return match?.path ?? '/';
};

/**
 * Authenticated shell: left sider menu (permission-filtered), header with
 * tenant + staff + logout, routed content. Unauthenticated visitors are
 * bounced to /login (with a `from` so login can send them back).
 */
export default function AdminLayout() {
  const { user, loading, tenantCode, hasPerm, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [badge, setBadge] = useState<{
    total: number;
    byDomain: Record<string, number>;
    byPage?: Record<string, number>;
  } | null>(null);
  const [taskBadge, setTaskBadge] = useState<{ todo: number; escalated: number; alerts: number } | null>(null);

  useEffect(() => {
    if (!user) return;
    let stopped = false;
    const load = () => {
      if (hasPerm('exception:read')) {
        api
          .get<{ total: number; byDomain: Record<string, number>; byPage?: Record<string, number> }>(
            '/exceptions/badge',
          )
          .then((r) => {
            if (!stopped) setBadge(r.data);
          })
          .catch(() => undefined);
      }
      api
        .get<{ todo: number; escalated: number; alerts: number }>('/tasks/badge')
        .then((r) => {
          if (!stopped) setTaskBadge(r.data);
        })
        .catch(() => undefined);
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [user, hasPerm]);

  const items = useMemo(
    () =>
      toMenuItems(
        APP_ROUTES,
        hasPerm,
        badge ? { total: badge.total, byPage: badge.byPage ?? {} } : undefined,
      ),
    [hasPerm, badge],
  );

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spin size="large" />
        <div style={{ marginTop: 16, color: '#888' }}>正在恢复登录状态…</div>
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark">
        <div
          style={{
            height: 48,
            margin: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: 2,
          }}
        >
          水务 SaaS
        </div>
        <Menu
          theme="dark"
          mode="inline"
          items={items}
          selectedKeys={[selectedKeyOf(location.pathname)]}
          defaultOpenKeys={['/customer', '/metering', '/settlement', '/system']}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 500 }}>供水营收管理系统</span>
          <Space size="middle">
            <Badge
              count={(taskBadge?.todo ?? 0) + (taskBadge?.alerts ?? 0)}
              size="small"
              title="待办任务"
            >
              <Button
                type="text"
                icon={<BellOutlined style={{ fontSize: 18 }} />}
                onClick={() => navigate('/tasks')}
              />
            </Badge>
            {tenantCode && <Tag color="blue">{tenantCode}</Tag>}
            <span>
              <UserOutlined style={{ marginRight: 6 }} />
              {user.name}
              {user.roles.length > 0 && (
                <span style={{ color: '#888', marginLeft: 6 }}>
                  （{user.roles.map((r) => r.name).join('、')}）
                </span>
              )}
            </span>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              onClick={() => {
                logout();
                navigate('/login', { replace: true });
              }}
            >
              退出
            </Button>
          </Space>
        </Header>
        <Content className="page-content" style={{ margin: 16 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
