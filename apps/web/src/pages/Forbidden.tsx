import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';

/** Keep the denied URL visible so the user can identify the inaccessible link. */
export default function Forbidden() {
  const navigate = useNavigate();
  return (
    <Result
      status="403"
      title="403 · 无权限访问"
      subTitle="你当前账号没有访问此页面的权限。"
      extra={
        <Button type="primary" onClick={() => navigate('/', { replace: true })}>
          返回工作台
        </Button>
      }
    />
  );
}
