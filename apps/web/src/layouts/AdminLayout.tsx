import { LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { Button, Layout, Menu, Space, Spin, Tag } from 'antd';
import type { MenuProps } from 'antd';
import { useMemo } from 'react';
import {
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { APP_ROUTES, leafRoutes } from '../routes';
import type { AppRoute } from '../routes';

const { Sider, Header, Content } = Layout;

type MenuItem = Required<MenuProps>['items'][number];

/** Route tree → AntD menu items, filtered by permission. */
const toMenuItems = (
  routes: AppRoute[],
  hasPerm: (...codes: string[]) => boolean,
): MenuItem[] =>
  routes
    .filter((r) => !r.perms || hasPerm(...r.perms))
    .map((r) => ({
      key: r.path,
      icon: r.icon,
      label: r.label,
      children: r.children ? toMenuItems(r.children, hasPerm) : undefined,
    }));

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

  const items = useMemo(() => toMenuItems(APP_ROUTES, hasPerm), [hasPerm]);

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
          defaultOpenKeys={['/system']}
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
        <Content style={{ margin: 16 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
