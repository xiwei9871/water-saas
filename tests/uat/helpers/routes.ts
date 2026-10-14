export const routes = [
  ['B01', '/', '工作台'],
  ['B02', '/customer/onboard', '立户向导'], ['B02', '/customer/customers', '客户列表'],
  ['B02', '/customer/water-accounts', '用水户'], ['B02', '/customer/settle-accounts', '结算户'], ['B02', '/customer/meters', '水表管理'],
  ['B03', '/metering/books', '抄表册'], ['B03', '/metering/plans', '抄表计划'], ['B03', '/metering/readings', '抄表记录 / 质检'],
  ['B04', '/settlement/list', '结算水量'], ['B04', '/settlement/reconciliations', '补差管理'],
  ['B05', '/billing/tariffs', '资费计划'], ['B05', '/billing/fee-items', '费用项'], ['B05', '/billing/runs', '开账批次'], ['B05', '/billing/bills', '账单'],
  ['B06', '/payment/counter', '收费台'], ['B06', '/payment/payments', '收款记录'], ['B06', '/payment/day-close', '收费员日结'],
  ['B07', '/report/ops-daily', '运营日报'], ['B07', '/report/analysis-monthly', '经营月报'], ['B07', '/report/analysis-yearly', '年报'],
  ['B07', '/report/query/accounts', '用户档案查询'], ['B07', '/report/query/usage-details', '水量明细查询'], ['B07', '/report/query/bill-details', '账单明细查询'], ['B07', '/report/query/payments', '收款流水查询'], ['B07', '/report/query/arrears', '欠费明细查询'],
  ['B08', '/system/orgs', '组织管理'], ['B08', '/system/staff', '用户管理'], ['B08', '/system/roles', '角色权限'], ['B08', '/system/params', '租户参数'], ['B08', '/system/audit-logs', '操作日志'], ['B08', '/report/metric-dict', '指标字典'],
] as const;
export const layoutRoutes = routes.filter(r => ['/customer/onboard', '/metering/plans', '/settlement/list', '/billing/tariffs', '/payment/counter', '/payment/day-close'].includes(r[1]));
