import { ArrowRightOutlined } from '@ant-design/icons';
import { Card, Col, Row, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { leafRoutes } from '../routes';

const fmtDate = (d: Date): string =>
  `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${
    '日一二三四五六'[d.getDay()]
  }`;

/**
 * 工作台占位页 — 今日日期 + 按权限过滤的快捷入口。
 * 待办列表（待复核读数 / MANUAL_REVIEW 结算 / 超限估抄 / 待应用
 * reconciliation）属 T16 验收范围，届时在此扩展。
 */
export default function Workbench() {
  const { user, hasPerm } = useAuth();
  const navigate = useNavigate();
  const links = leafRoutes().filter(
    (r) => r.path !== '/' && (!r.perms || hasPerm(...r.perms)),
  );

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        工作台
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        {fmtDate(new Date())}　{user?.name}，您好。
      </Typography.Paragraph>
      <Row gutter={[16, 16]}>
        {links.map((r) => (
          <Col key={r.key} xs={12} sm={8} md={6} lg={6}>
            <Card
              hoverable
              onClick={() => navigate(r.path)}
              styles={{ body: { padding: 16 } }}
            >
              <Typography.Text strong>
                {r.label} <ArrowRightOutlined />
              </Typography.Text>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
