/**
 * Task center types (任务书 V1.0 §1.4-1.6).
 *
 * type → requiredPerm mapping is NOT hard-coded here for reads: each task
 * creation resolves it from sys_dict category 'TASK_TYPE_PERM' (value JSON
 * {perm, dueDays, priority}) so tenant admins can rewire it without deploy.
 * TASK_TYPES below is only the display/route catalogue + dict fallback.
 */

export interface TaskTypeDef {
  /** sys_dict TASK_TYPE_PERM row code. */
  code: string;
  /** 展示名（dict name 覆盖此处回退）。 */
  name: string;
  /** dict 缺失时的兜底权限码。 */
  fallbackPerm: string;
  /** 前端直达路由：{bizId} 占位。 */
  bizRoute: string;
  /** 建单必要要素（3.3）：context 缺任一键 → TASK_CONTEXT_MISSING 拒建。 */
  requiredContext?: string[];
  /**
   * 操作指引模板（3.4）：{key} 从 context 取值，{bizLabel} 取业务编号。
   * 例：'请到抄表记录页，对户 {waterAccountNo} 账期 {period} 提交质检结论。'
   */
  guide?: string;
  /** 现场类任务：完成必须上传佐证（照片/单据）；审批/复核类只需处理结果。 */
  evidenceRequired?: boolean;
}

export const TASK_TYPES: TaskTypeDef[] = [
  {
    // 1028v2 放号-上号：放号后按指定抄表员直接指派，现场复核四项
    // 一致 + 录表号后上号（完成标准由上号接口 autoCompleteByBiz 反写）。
    code: 'ACCOUNT_ACTIVATE',
    name: '立户上号',
    fallbackPerm: 'customer:read',
    bizRoute: '/customer/water-accounts?focusId={bizId}',
    requiredContext: ['archiveNo', 'accountNo', 'addr'],
    guide: '请到 客户管理→用水户，对待上号户 {archiveNo} 现场复核四项一致（表号/档案号/地址/用户名），录入表号后点「上号」。',
    evidenceRequired: false,
  },
  {
    // 1028v2：已上号（待补全）户回厅补录客户/结算户/合同 → complete-info 办结。
    code: 'ACCOUNT_COMPLETE_INFO',
    name: '立户信息补录',
    fallbackPerm: 'customer:write',
    bizRoute: '/customer/onboard?completeId={bizId}',
    requiredContext: ['archiveNo', 'accountNo'],
    guide: '请到 客户管理→立户向导，对待补全户 {accountNo}（档案号 {archiveNo}）补齐客户/结算户/合同信息并提交补录。',
    evidenceRequired: false,
  },
  {
    code: 'SUPPLEMENT',
    name: '补差任务',
    fallbackPerm: 'billing:write',
    bizRoute: '/metering/settlements?waterAccountId={bizId}',
    requiredContext: ['waterAccountNo', 'period', 'actualReadingValue', 'estimatedReadingValue', 'diff'],
    guide: '请到 结算管理→补差管理，对户 {waterAccountNo} 账期 {period} 生成补差单（估计止度 {estimatedReadingValue} → 实抄 {actualReadingValue}，差 {diff} m³）。',
  },
  {
    code: 'METER_REVIEW',
    name: '抄表异常复核',
    fallbackPerm: 'metering:qc',
    bizRoute: '/metering/readings?focusId={bizId}',
    requiredContext: ['waterAccountNo', 'period', 'readingValue', 'prevReadingValue'],
    guide: '请到 抄表管理→抄表记录，对户 {waterAccountNo} 账期 {period} 的该条读数提交质检结论（本期 {readingValue}，上期 {prevReadingValue}）。',
  },
  {
    // 20261026 追加抄表独立功能：计划层主动发起（未抄先派单），
    // 与「抄表记录→更正→追加」（已抄补读数）并存、本类为主入口。
    code: 'SUPPLEMENT_READING',
    name: '追加抄表',
    fallbackPerm: 'metering:write',
    bizRoute: '/metering/plans?focusId={bizId}',
    requiredContext: ['waterAccountNo', 'period', 'planItemId'],
    guide: '请到 抄表管理→抄表计划，对该追加计划明细现场抄表并回填户 {waterAccountNo} 账期 {period} 的读数（不得小于上一可信读数）。',
    evidenceRequired: true,
  },
  {
    code: 'COLLECTION',
    name: '催缴任务',
    fallbackPerm: 'payment:write',
    bizRoute: '/receivable/arrears?settleAccountId={bizId}',
    requiredContext: ['settleNo', 'arrearsCent', 'overdueDays'],
    guide: '请到 收费管理→欠费催缴，对结算户 {settleNo} 生成催缴通知单并跟进回收（欠费见要素卡）。',
  },
  {
    code: 'REVERSAL_APPROVAL',
    name: '红冲审批',
    fallbackPerm: 'billing:write',
    bizRoute: '/payment/payments?focusId={bizId}',
    requiredContext: ['reversalPaymentNo', 'originalPaymentNo', 'amountCent'],
    guide: '请到 收费管理→收款记录，复核红冲单 {reversalPaymentNo}（原单 {originalPaymentNo}）的合规性。',
  },
  {
    code: 'WRITEOFF_APPROVAL',
    name: '核销审批',
    fallbackPerm: 'billing:write',
    bizRoute: '/payment/writeoffs?focusId={bizId}',
    requiredContext: ['settleNo', 'amountCent', 'reasonName'],
    guide: '请到 收费管理→坏账核销，复核该笔核销（结算户 {settleNo}）后给出审批结论。',
  },
  {
    code: 'INSTALL_REVIEW',
    name: '报装审批',
    fallbackPerm: 'install:write',
    bizRoute: '/install/applications?focusId={bizId}',
    requiredContext: ['applyNo', 'applicantName'],
    guide: '请到 报装管理，处理申请 {applyNo}（申请人 {applicantName}）的勘察/审批/归档。',
  },
  {
    code: 'RECON_HANDLE',
    name: '对账差异处理',
    fallbackPerm: 'payment:write',
    bizRoute: '/payment/recon?focusId={bizId}',
    requiredContext: ['channel'],
    guide: '请到 收费管理→渠道对账，处理该批次的差异/缺失行。',
  },
  {
    code: 'METER_SERVICE',
    name: '表务工单',
    fallbackPerm: 'metering:service',
    bizRoute: '/service/orders?focusId={bizId}',
    requiredContext: ['orderNo', 'serviceType', 'waterAccountNo'],
    guide: '请到 表务管理→表务工单，处置工单 {orderNo}。',
    evidenceRequired: true,
  },
  {
    // 20261020 核查 T2：表务双节点任务 —— 待审批/待执行分别进待办。
    code: 'SVC_APPROVAL',
    name: '表务审批',
    fallbackPerm: 'metering:service',
    bizRoute: '/service/orders?focusId={bizId}',
    requiredContext: ['orderNo', 'serviceType', 'waterAccountNo'],
    guide: '请到 表务管理→表务工单，审批工单 {orderNo}（户 {waterAccountNo}）。',
  },
  {
    code: 'SVC_EXECUTE',
    name: '表务处置',
    fallbackPerm: 'metering:service',
    bizRoute: '/service/orders?focusId={bizId}',
    requiredContext: ['orderNo', 'serviceType', 'waterAccountNo'],
    guide: '请到 表务管理→表务工单，执行并归档工单 {orderNo}（户 {waterAccountNo}）。',
    evidenceRequired: true,
  },
  {
    // 20261021 整改 任务E：违章处置任务（稽查核实/处理）。
    code: 'VIOLATION_HANDLE',
    name: '违章处置',
    fallbackPerm: 'metering:service',
    bizRoute: '/service/violations?focusId={bizId}',
    requiredContext: ['waterAccountNo', 'violationType'],
    guide: '请到 表务管理→违章用水，核实处置户 {waterAccountNo} 的违章（处理/佐证/归档）。',
    evidenceRequired: true,
  },
];

export const TASK_TYPE_CODES = TASK_TYPES.map((t) => t.code);

/** 阻断结算/出账的任务类型（任务书 §1.6：补差未完成 → 阻断结算）。 */
export const SETTLEMENT_BLOCKING_TYPES = ['SUPPLEMENT'] as const;

export interface TaskDictRule {
  perm: string;
  dueDays?: number;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
}
