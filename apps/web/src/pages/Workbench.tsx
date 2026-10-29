import { ArrowRightOutlined } from '@ant-design/icons';
import { Badge, Card, Col, Row, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useTaskStream } from '../hooks/useTaskStream';
import { APP_ROUTES, leafRoutes } from '../routes';

const fmtDate = (d: Date): string =>
  `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${
    '日一二三四五六'[d.getDay()]
  }`;

interface ModuleCard {
  key: string;
  label: string;
  path: string;
  /** 常用子功能小字标注 */
  subs: string;
  badge?: number;
}

/**
 * 工作台（修订稿 N2）：按业务环节 4 组展示一级模块卡片，不再平铺
 * 40+ 叶子页。待办/异常卡保留数字角标（内联在标题后，不遮挡名称）。
 */
export default function Workbench() {
  const { user, hasPerm } = useAuth();
  const navigate = useNavigate();
  const [taskBadge, setTaskBadge] = useState<{ todo: number; escalated: number; alerts: number } | null>(null);
  const [exBadge, setExBadge] = useState<{ total: number } | null>(null);

  const load = useCallback(() => {
    api.get<{ todo: number; escalated: number; alerts: number }>('/tasks/badge')
      .then((r) => setTaskBadge(r.data)).catch(() => undefined);
    if (hasPerm('exception:read')) {
      api.get<{ total: number }>('/exceptions/badge')
        .then((r) => setExBadge(r.data)).catch(() => undefined);
    }
  }, [hasPerm]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // 1028v2 任务实时置顶：任务变更推送立即刷新角标（保留 60s 轮询兜底）。
  useTaskStream(load);

  // 一级模块组（叶子取模块第一个可见子项作为落地，含子功能标注）
  const groups = useMemo(() => {
    const taskN = taskBadge ? taskBadge.todo + taskBadge.escalated + taskBadge.alerts : 0;
    const exN = exBadge?.total ?? 0;
    const defs: { title: string; cards: ModuleCard[] }[] = [
      {
        title: '任务与监控',
        cards: [
          { key: 'tasks', label: '待办中心', path: '/tasks', subs: '我的待办 · 任务池 · 告警', badge: taskN },
          { key: 'exceptions', label: '异常中心', path: '/exceptions', subs: '异常队列 · 去处理', badge: exN },
        ],
      },
      {
        title: '业务办理',
        cards: [
          { key: 'install', label: '报装管理', path: '/install', subs: '报装申请 · 勘察 · 审批 · 装表 · 归档' },
          { key: 'customer', label: '客户管理', path: '/customer', subs: '立户向导 · 客户列表 · 用水户 · 结算户 · 水表' },
          { key: 'metering', label: '抄表管理', path: '/metering', subs: '抄表册 · 抄表计划 · 抄表记录 · 远传' },
          { key: 'service', label: '表务管理', path: '/service', subs: '水表档案 · 出入库 · 表务工单 · 换表记录 · 违章' },
          { key: 'settlement', label: '结算管理', path: '/settlement', subs: '结算水量 · 补差管理' },
          { key: 'billing', label: '计费管理', path: '/billing', subs: '资费计划 · 费用项 · 开账批次 · 账单' },
          { key: 'payment', label: '收费管理', path: '/payment', subs: '收费台 · 收款记录 · 预存 · 日结 · 核销 · 对账 · 票据' },
        ],
      },
      {
        title: '报表分析',
        cards: [
          { key: 'report', label: '报表', path: '/report', subs: '日报 · 月报 · 年报' },
          { key: 'query', label: '数据查询', path: '/query', subs: '统一查询 · 指标查询' },
        ],
      },
      {
        title: '系统管理',
        cards: [
          { key: 'system', label: '系统管理', path: '/system', subs: '组织 · 用户 · 角色 · 参数 · 字典 · 日志' },
        ],
      },
    ];
    // 与边栏菜单同口径：卡片按一级模块的 menuPerms/perms 过滤；有子项的
    // 组还要求至少一个可见叶子（子项可声明自己的 perms）。
    const visible = (key: string): boolean => {
      const r = APP_ROUTES.find((x) => x.key === key);
      if (!r) return false;
      const gate = r.menuPerms ?? r.perms;
      if (gate && !hasPerm(...gate)) return false;
      if (!r.children?.length) return true;
      return leafRoutes(r.children, r.perms).some(
        (c) => !c.perms || hasPerm(...c.perms),
      );
    };
    return defs
      .map((g) => ({ ...g, cards: g.cards.filter((c) => visible(c.key)) }))
      .filter((g) => g.cards.length > 0);
  }, [taskBadge, exBadge, hasPerm]);

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        工作台
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        {fmtDate(new Date())}　{user?.name}，您好。
      </Typography.Paragraph>
      {groups.map((g) => (
        <div key={g.title} style={{ marginBottom: 16 }}>
          <Typography.Text strong style={{ fontSize: 15 }}>
            {g.title}
          </Typography.Text>
          <Row gutter={[12, 12]} style={{ marginTop: 8 }}>
            {g.cards.map((c) => (
              <Col key={c.key} xs={12} sm={8} md={6} lg={6}>
                <Card
                  hoverable
                  onClick={() => navigate(c.path)}
                  styles={{ body: { padding: 14 } }}
                >
                  <div style={{ marginBottom: 6 }}>
                    <Typography.Text strong style={{ fontSize: 14 }}>
                      {c.label}
                    </Typography.Text>
                    {(c.badge ?? 0) > 0 && (
                      <Badge
                        count={c.badge}
                        size="small"
                        style={{ marginLeft: 8 }}
                      />
                    )}
                    <ArrowRightOutlined style={{ float: 'right', color: '#bbb', marginTop: 4 }} />
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {c.subs}
                  </Typography.Text>
                </Card>
              </Col>
            ))}
          </Row>
        </div>
      ))}
    </div>
  );
}
