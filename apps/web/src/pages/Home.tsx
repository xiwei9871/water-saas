import { Navigate } from 'react-router-dom';
import Cockpit from './Cockpit';
import { useAuth } from '../auth/AuthContext';

/**
 * 登录默认落地页（修订稿 N1）：有 report:read → 经营驾驶舱；
 * 无权限 → 重定向到 /workbench（纯导航，全角色可用）。
 */
export default function Home() {
  const { hasPerm } = useAuth();
  if (!hasPerm('report:read')) return <Navigate to="/workbench" replace />;
  return <Cockpit />;
}
