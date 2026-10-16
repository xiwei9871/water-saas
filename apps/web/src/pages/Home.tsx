import { Card, Tabs } from 'antd';
import Cockpit from './Cockpit';
import Workbench from './Workbench';
import { useAuth } from '../auth/AuthContext';

/**
 * 登录首页（修订稿 H1）：经营驾驶舱为默认页签，工作台保留为可切换页签。
 * 无 report:read 的角色直接落工作台（驾驶舱数据端点需要该权限）。
 */
export default function Home() {
  const { hasPerm } = useAuth();
  if (!hasPerm('report:read')) return <Workbench />;
  return (
    <Card size="small" styles={{ body: { paddingTop: 8 } }}>
      <Tabs
        defaultActiveKey="cockpit"
        items={[
          { key: 'cockpit', label: '经营驾驶舱', children: <Cockpit /> },
          { key: 'workbench', label: '工作台', children: <Workbench /> },
        ]}
      />
    </Card>
  );
}
