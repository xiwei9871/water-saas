import { LockOutlined, ShopOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input } from 'antd';
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { apiErrorText } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface LoginForm {
  tenantCode: string;
  login: string;
  password: string;
}

/** 登录页：租户代码 + 账号 + 密码 → /auth/login → /auth/me → 工作台。 */
export default function Login() {
  const { user, login, tenantCode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const from =
    (location.state as { from?: { pathname?: string } } | null)?.from
      ?.pathname ?? '/';

  if (user) {
    return <Navigate to={from} replace />;
  }

  const onFinish = async (values: LoginForm) => {
    setSubmitting(true);
    setError(null);
    try {
      await login(values.tenantCode.trim(), values.login.trim(), values.password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(apiErrorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card style={{ width: 380 }} title="水务 SaaS · 供水营收管理系统">
        <Form<LoginForm>
          layout="vertical"
          requiredMark={false}
          initialValues={{ tenantCode: tenantCode ?? undefined }}
          onFinish={onFinish}
        >
          <Form.Item
            name="tenantCode"
            label="租户代码"
            rules={[{ required: true, message: '请输入租户代码' }]}
          >
            <Input prefix={<ShopOutlined />} placeholder="如 cd-water" autoFocus />
          </Form.Item>
          <Form.Item
            name="login"
            label="账号"
            rules={[{ required: true, message: '请输入账号' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="登录账号" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          {error && (
            <Alert
              type="error"
              message={error}
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          <Button type="primary" htmlType="submit" block loading={submitting}>
            登 录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
