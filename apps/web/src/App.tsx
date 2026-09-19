import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import AdminLayout from './layouts/AdminLayout';
import Login from './pages/Login';
import Forbidden from './pages/Forbidden';
import Placeholder from './pages/Placeholder';
import { APP_ROUTES, leafRoutes } from './routes';
import type { AppRoute } from './routes';

dayjs.locale('zh-cn');

/** Direct-URL guard — the menu hides denied entries but routes must too. */
function PermRoute({ route }: { route: AppRoute }) {
  const { hasPerm } = useAuth();
  if (route.perms && !hasPerm(...route.perms)) {
    return <Forbidden />;
  }
  return <>{route.element ?? <Placeholder title={route.label} />}</>;
}

/** Group landing: first child the user may actually see. */
function GroupRedirect({ route }: { route: AppRoute }) {
  const { hasPerm } = useAuth();
  const first =
    route.children?.find((c) => !c.perms || hasPerm(...c.perms)) ??
    route.children?.[0];
  return <Navigate to={first?.path ?? '/'} replace />;
}

/**
 * /login is public; every other route renders inside the AdminLayout guard
 * (unauthenticated → /login). Routes come from the same APP_ROUTES config
 * that builds the sider menu — a T15/T16 page only needs `element` set on
 * its entry. Unknown paths fall back to the workbench.
 */
export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      modal={{ closable: { 'aria-label': '关闭' } }}
      drawer={{ closable: { 'aria-label': '关闭' } }}
    >
      <AntdApp>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route element={<AdminLayout />}>
                {leafRoutes().map((r) => (
                  <Route
                    key={r.key}
                    path={r.path}
                    element={<PermRoute route={r} />}
                  />
                ))}
                {/* Menu groups land on their first child. */}
                {APP_ROUTES.filter((r) => r.children?.length).map((r) => (
                  <Route
                    key={`${r.key}-index`}
                    path={r.path}
                    element={<GroupRedirect route={r} />}
                  />
                ))}
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </AntdApp>
    </ConfigProvider>
  );
}
