import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'dayjs/locale/zh-cn';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import AdminLayout from './layouts/AdminLayout';
import Login from './pages/Login';
import Placeholder from './pages/Placeholder';
import { APP_ROUTES, leafRoutes } from './routes';

/**
 * /login is public; every other route renders inside the AdminLayout guard
 * (unauthenticated → /login). Routes come from the same APP_ROUTES config
 * that builds the sider menu — a T15/T16 page only needs `element` set on
 * its entry. Unknown paths fall back to the workbench.
 */
export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
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
                    element={r.element ?? <Placeholder title={r.label} />}
                  />
                ))}
                {/* Menu groups land on their first child. */}
                {APP_ROUTES.filter((r) => r.children?.length).map((r) => (
                  <Route
                    key={`${r.key}-index`}
                    path={r.path}
                    element={
                      <Navigate to={r.children![0].path} replace />
                    }
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
