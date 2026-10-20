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
}

export const TASK_TYPES: TaskTypeDef[] = [
  {
    code: 'SUPPLEMENT',
    name: '补差任务',
    fallbackPerm: 'billing:write',
    bizRoute: '/metering/settlements?waterAccountId={bizId}',
  },
  {
    code: 'METER_REVIEW',
    name: '抄表异常复核',
    fallbackPerm: 'metering:qc',
    bizRoute: '/metering/readings?focusId={bizId}',
  },
  {
    code: 'COLLECTION',
    name: '催缴任务',
    fallbackPerm: 'payment:write',
    bizRoute: '/receivable/arrears?settleAccountId={bizId}',
  },
  {
    code: 'REVERSAL_APPROVAL',
    name: '红冲审批',
    fallbackPerm: 'billing:write',
    bizRoute: '/payment/payments?focusId={bizId}',
  },
  {
    code: 'WRITEOFF_APPROVAL',
    name: '核销审批',
    fallbackPerm: 'billing:write',
    bizRoute: '/payment/writeoffs?focusId={bizId}',
  },
  {
    code: 'INSTALL_REVIEW',
    name: '报装审批',
    fallbackPerm: 'install:write',
    bizRoute: '/install/applications?focusId={bizId}',
  },
  {
    code: 'RECON_HANDLE',
    name: '对账差异处理',
    fallbackPerm: 'payment:write',
    bizRoute: '/payment/recon?focusId={bizId}',
  },
  {
    code: 'METER_SERVICE',
    name: '表务工单',
    fallbackPerm: 'metering:service',
    bizRoute: '/service/orders?focusId={bizId}',
  },
  {
    // 20261020 核查 T2：表务双节点任务 —— 待审批/待执行分别进待办。
    code: 'SVC_APPROVAL',
    name: '表务审批',
    fallbackPerm: 'metering:service',
    bizRoute: '/service/orders?focusId={bizId}',
  },
  {
    code: 'SVC_EXECUTE',
    name: '表务处置',
    fallbackPerm: 'metering:service',
    bizRoute: '/service/orders?focusId={bizId}',
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
