/**
 * C1 指标字典（2026-10 需求 §六）—— KPI 口径、公式、数据来源固化为系统内
 * 字典。日/月/年报的同一指标必须从这里取口径，字典是唯一来源。
 *
 * 字典内容本身是代码固化的（口径变更=代码评审+发版，天然可版本化）；
 * `version` 随目录内容升版，响应里透出便于报表与字典对账。
 * `available: false` 表示指标已定义但数据源尚缺（在字典中显式说明），
 * 报表对这些指标返回 null 并注明原因，而不是静默报 0。
 */

export interface MetricDef {
  code: string;
  name: string;
  /** 中文口径公式（供报表页与测试对账用） */
  formula: string;
  /** 数据源表/字段说明 */
  source: string;
  unit: 'm3' | 'cent' | 'ratio' | 'count' | 'cent_per_m3';
  direction: 'higher-better' | 'lower-better' | 'info';
  /** false = 定义已固化但数据源未到位（报表返回 null + reason） */
  available: boolean;
  unavailableReason?: string;
}

export const METRIC_DICT_VERSION = '2026-10.v1';

export const METRIC_DICT: MetricDef[] = [
  {
    code: 'SOLD_QTY',
    name: '售水量',
    formula: 'Σ consumption_settlement.total_usage_qty（status=FINAL，按账期）',
    source: 'consumption_settlement',
    unit: 'm3',
    direction: 'info',
    available: true,
  },
  {
    code: 'SOLD_QTY_TARGET_RATE',
    name: '售水完成率',
    formula: '本期售水量 ÷ 本期售水目标',
    source: 'consumption_settlement ÷ 租户售水目标（未配置）',
    unit: 'ratio',
    direction: 'higher-better',
    available: false,
    unavailableReason: '售水目标值尚未提供配置入口（tenant_param 扩展项）',
  },
  {
    code: 'AR_AMOUNT',
    name: '应收水费',
    formula: 'Σ bill.total_amount（period=P，bill_kind≠REVERSAL，status∈POSTED/PARTIAL_PAID/PAID）',
    source: 'bill',
    unit: 'cent',
    direction: 'info',
    available: true,
  },
  {
    code: 'COLLECTED',
    name: '实收水费',
    formula: 'Σ payment.amount（received_at∈P月，status∈RECEIVED/DAY_CLOSED；红冲为负值自然净减）',
    source: 'payment',
    unit: 'cent',
    direction: 'info',
    available: true,
  },
  {
    code: 'CURRENT_COLLECTED',
    name: '当期实收',
    formula: 'Σ payment_alloc.amount 分摊到 period=P 账单且入账日在该账单收费窗口（due_date）内',
    source: 'payment_alloc ⋈ bill ⋈ payment/prepayment_ledger_entry',
    unit: 'cent',
    direction: 'higher-better',
    available: true,
  },
  {
    code: 'ARREARS_COLLECTED',
    name: '欠费收取（陈欠回收）',
    formula: 'P 月入账的收款中分摊到 period<P 账单的 payment_alloc 合计',
    source: 'payment_alloc ⋈ bill ⋈ payment/prepayment_ledger_entry',
    unit: 'cent',
    direction: 'higher-better',
    available: true,
  },
  {
    code: 'RECOVERY_RATE',
    name: '水费回收率',
    formula: '当期实收 ÷ 当期应收（窗口内销账口径，≤100%）',
    source: '同 CURRENT_COLLECTED ÷ AR_AMOUNT',
    unit: 'ratio',
    direction: 'higher-better',
    available: true,
  },
  {
    code: 'ARREARS_RECOVERY_RATE',
    name: '欠费回收率',
    formula: '本期陈欠收取 ÷ 期初陈欠总额',
    source: 'ARREARS_COLLECTED ÷ 期初欠费',
    unit: 'ratio',
    direction: 'higher-better',
    available: true,
  },
  {
    code: 'ARREARS_TOTAL',
    name: '欠费总额',
    formula: 'Σ (bill.total_amount − 已分摊)（status∈POSTED/PARTIAL_PAID，含历史各期）',
    source: 'bill ⋈ payment_alloc',
    unit: 'cent',
    direction: 'lower-better',
    available: true,
  },
  {
    code: 'ARREARS_RATE',
    name: '欠费率',
    formula: '欠费总额 ÷ 累计应收（全部 POSTED+ 账单）',
    source: 'ARREARS_TOTAL ÷ Σ bill.total_amount（历史累计）',
    unit: 'ratio',
    direction: 'lower-better',
    available: true,
  },
  {
    code: 'COMPOSITE_PRICE',
    name: '综合单价',
    formula: '水费收入（不含代收项，fee_item.kind=WATER_FEE）÷ 售水量',
    source: 'bill_item ⋈ fee_item(kind) ÷ SOLD_QTY',
    unit: 'cent_per_m3',
    direction: 'info',
    available: true,
  },
  {
    code: 'REVENUE_GROWTH',
    name: '营收增长率',
    formula: '(本期应收 − 上年同期应收) ÷ 上年同期应收',
    source: 'AR_AMOUNT 同比',
    unit: 'ratio',
    direction: 'higher-better',
    available: true,
  },
  {
    code: 'READ_ACCURACY',
    name: '抄表准确率',
    formula: '质检一次通过读数 ÷ 本期全部已检读数（PASSED/(PASSED+REJECTED+MANUAL_REVIEW)）',
    source: 'meter_reading',
    unit: 'ratio',
    direction: 'higher-better',
    available: true,
  },
  {
    code: 'READ_COVERAGE',
    name: '抄见率',
    formula: 'READ 计划项 ÷ 全部计划项（PENDING/NO_READ/SKIPPED 计入分母）',
    source: 'reading_plan_item',
    unit: 'ratio',
    direction: 'higher-better',
    available: true,
  },
  {
    code: 'ESTIMATE_RATE',
    name: '估抄率',
    formula: '预估分量 ÷ 全部结算分量（ESTIMATE sourceType 占比，按分量行数）',
    source: 'consumption_component',
    unit: 'ratio',
    direction: 'lower-better',
    available: true,
  },
  {
    code: 'READ_TIMELINESS',
    name: '抄表及时率',
    formula: 'read_date ≤ 计划日期的读数 ÷ 本期计划内读数',
    source: 'meter_reading ⋈ reading_plan(plan_date)',
    unit: 'ratio',
    direction: 'higher-better',
    available: true,
  },
  {
    code: 'ACCOUNT_COUNT',
    name: '在册户数',
    formula: 'status=NORMAL 用水户数（期末时点）',
    source: 'water_account',
    unit: 'count',
    direction: 'info',
    available: true,
  },
  {
    code: 'NEW_ACCOUNTS',
    name: '新装户数',
    formula: 'opened_at ∈ 期间的用水户数',
    source: 'water_account.opened_at',
    unit: 'count',
    direction: 'info',
    available: true,
  },
  {
    code: 'CLOSED_ACCOUNTS',
    name: '销户/流失户数',
    formula: 'closed_at ∈ 期间的用水户数',
    source: 'water_account.closed_at',
    unit: 'count',
    direction: 'lower-better',
    available: true,
  },
  {
    code: 'NET_NEW_ACCOUNTS',
    name: '净增客户',
    formula: '新装户数 − 销户户数（期间内）',
    source: 'NEW_ACCOUNTS − CLOSED_ACCOUNTS',
    unit: 'count',
    direction: 'higher-better',
    available: true,
  },
  {
    code: 'ONLINE_RATE',
    name: '线上缴费率',
    formula: 'ONLINE 渠道实收 ÷ 全部实收',
    source: 'payment(channel=ONLINE)',
    unit: 'ratio',
    direction: 'higher-better',
    available: true,
  },
  {
    code: 'BANK_DEDUCT_RATE',
    name: '银行代扣率',
    formula: 'BANK_DEDUCT 渠道实收 ÷ 全部实收',
    source: 'payment(channel=BANK_DEDUCT)',
    unit: 'ratio',
    direction: 'higher-better',
    available: true,
  },
  {
    code: 'BAD_DEBT_WRITEOFF',
    name: '坏账核销额',
    formula: 'Σ bad_debt_writeoff.amount（status=ACTIVE，effective_date∈期间）',
    source: 'bad_debt_writeoff',
    unit: 'cent',
    direction: 'lower-better',
    available: true,
  },
  {
    code: 'BAD_DEBT_RATE',
    name: '坏账率',
    formula: '累计核销额 ÷ 累计应收',
    source: 'BAD_DEBT_WRITEOFF ÷ Σ bill.total_amount（历史累计）',
    unit: 'ratio',
    direction: 'lower-better',
    available: true,
  },
  {
    code: 'DUN_SUCCESS_RATE',
    name: '催缴成功率',
    formula: '催缴后 N 日内收回欠费户数 ÷ 催缴户数',
    source: '催缴记录（功能未建）',
    unit: 'ratio',
    direction: 'higher-better',
    available: false,
    unavailableReason: '催缴登记功能未建，无数据源',
  },
  {
    code: 'PREPAY_BALANCE',
    name: '预存余额',
    formula: 'Σ prepayment_ledger_entry.amount（结算户维度汇总）',
    source: 'prepayment_ledger_entry',
    unit: 'cent',
    direction: 'info',
    available: true,
  },
];
