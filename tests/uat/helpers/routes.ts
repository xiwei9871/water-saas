export const routes = [
  ['B01', '/', '工作台'],
  ['B02', '/customer/onboard', '立户向导'], ['B02', '/customer/customers', '客户列表'],
  ['B02', '/customer/water-accounts', '水表户'], ['B02', '/customer/settle-accounts', '结算户'], ['B02', '/customer/meters', '水表档案'],
  ['B03', '/metering/books', '抄表册'], ['B03', '/metering/plans', '抄表计划'], ['B03', '/metering/readings', '抄表记录 / 质检'],
  ['B04', '/settlement/list', '结算水量'], ['B04', '/settlement/reconciliations', '补差管理'],
  ['B05', '/billing/tariffs', '资费计划'], ['B05', '/billing/fee-items', '费用项'], ['B05', '/billing/runs', '开账批次'], ['B05', '/billing/bills', '账单'],
  ['B06', '/payment/counter', '收费台'], ['B06', '/payment/payments', '收款记录'], ['B06', '/payment/day-close', '收费员日结'],
  ['B07', '/report/meter-daily', '抄表日报'], ['B07', '/report/cashier-daily', '收费日报'], ['B07', '/report/ar-monthly', '应收月报'], ['B07', '/report/collected-monthly', '实收月报'], ['B07', '/report/recovery-rate', '回收率'],
  ['B08', '/system/orgs', '组织管理'], ['B08', '/system/staff', '用户管理'], ['B08', '/system/roles', '角色权限'], ['B08', '/system/params', '租户参数'], ['B08', '/system/audit-logs', '操作日志'],
] as const;
export const layoutRoutes = routes.filter(r => ['/customer/onboard', '/metering/plans', '/settlement/list', '/billing/tariffs', '/payment/counter', '/payment/day-close'].includes(r[1]));
