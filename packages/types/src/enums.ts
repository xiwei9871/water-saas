// Shared domain enums (spec §2.7). Every enum is an `as const` array plus a
// derived union type. Keep in sync with the spec — all tasks import from here.

export const METER_STATUSES = ['AVAILABLE', 'INSTALLED', 'MAINTENANCE', 'RETIRED'] as const;
export type MeterStatus = (typeof METER_STATUSES)[number];

export const INSTALLATION_STATUSES = ['ACTIVE', 'REMOVED'] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

export const INSTALL_REASONS = ['NEW', 'REPLACE', 'FAULT', 'PERIODIC_CHECK'] as const;
export type InstallReason = (typeof INSTALL_REASONS)[number];

export const PLAN_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CLOSED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_ITEM_STATUSES = ['PENDING', 'READ', 'NO_READ', 'SKIPPED'] as const;
export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number];

export const READ_RESULT_TYPES = ['ACTUAL', 'REMOTE', 'NO_READ'] as const;
export type ReadResultType = (typeof READ_RESULT_TYPES)[number];

export const EXCEPTION_CODES = [
  'LOCKED',
  'DIAL_DIRTY',
  'FLOODED',
  'OCCUPIED',
  'STOPPED',
  'BROKEN',
  'SUSPECTED_THEFT',
  'OTHER',
] as const;
export type ExceptionCode = (typeof EXCEPTION_CODES)[number];

export const QC_STATUSES = ['PENDING', 'PASSED', 'REJECTED', 'MANUAL_REVIEW'] as const;
export type QcStatus = (typeof QC_STATUSES)[number];

export const SETTLEMENT_STATUSES = ['DRAFT', 'FINAL'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const COMPONENT_SOURCE_TYPES = ['READING', 'ESTIMATE', 'MANUAL'] as const;
export type ComponentSourceType = (typeof COMPONENT_SOURCE_TYPES)[number];

export const RECON_STATUSES = ['DRAFT', 'ABSORBED', 'APPLIED', 'MANUAL_REVIEW'] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

export const TARIFF_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export type TariffStatus = (typeof TARIFF_STATUSES)[number];

export const RUN_TYPES = ['MANUAL', 'AUTO'] as const;
export type RunType = (typeof RUN_TYPES)[number];

export const RUN_STATUSES = ['DRAFT', 'PROCESSING', 'PARTIAL', 'POSTED', 'FAILED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// RC1: orthogonal lifecycle for multi-tx bill generation — a run is
// postable only once generation finalized (GENERATING → READY).
export const RUN_GENERATION_STATUSES = ['GENERATING', 'READY'] as const;
export type RunGenerationStatus = (typeof RUN_GENERATION_STATUSES)[number];

export const BILL_KINDS = ['NORMAL', 'ADJUSTMENT', 'REVERSAL', 'REPLACEMENT'] as const;
export type BillKind = (typeof BILL_KINDS)[number];

export const BILL_SOURCE_TYPES = ['SETTLEMENT', 'RECONCILIATION', 'MANUAL', 'ORIGINAL_BILL'] as const;
export type BillSourceType = (typeof BILL_SOURCE_TYPES)[number];

export const BILL_STATUSES = ['DRAFT', 'POSTED', 'PARTIAL_PAID', 'PAID', 'REVERSED'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_ITEM_TYPES = ['NORMAL', 'ADJUSTMENT', 'PENALTY'] as const;
export type BillItemType = (typeof BILL_ITEM_TYPES)[number];

export const PAY_CHANNELS = ['CASH', 'POS', 'TRANSFER'] as const;
export type PayChannel = (typeof PAY_CHANNELS)[number];

export const PAYMENT_STATUSES = ['RECEIVED', 'DAY_CLOSED', 'REVERSED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const CALC_TYPES = ['PER_QTY', 'FIXED', 'PERCENT'] as const;
export type CalcType = (typeof CALC_TYPES)[number];

export const ACCOUNT_STATUSES = ['NORMAL', 'SUSPENDED', 'CLOSED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_EVENT_TYPES = ['TRANSFER', 'SUSPEND', 'RESUME', 'CLOSE'] as const;
export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number];

export const READ_SOURCES = ['WEB', 'IMPORT', 'APP', 'REMOTE'] as const;
export type ReadSource = (typeof READ_SOURCES)[number];

export const CUST_TYPES = ['PERSONAL', 'ORG'] as const;
export type CustType = (typeof CUST_TYPES)[number];

export const ORG_TYPES = ['COMPANY', 'BRANCH', 'DEPT'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const DATA_SCOPES = ['ALL', 'ORG_SUBTREE', 'SELF'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export const PERM_TYPES = ['MENU', 'ACTION', 'DATA'] as const;
export type PermType = (typeof PERM_TYPES)[number];

export const IDEM_STATUSES = ['PROCESSING', 'COMPLETED'] as const;
export type IdemStatus = (typeof IDEM_STATUSES)[number];

export const NEGATIVE_USAGE_POLICIES = ['CLAMP_REVIEW', 'ALLOW_NEGATIVE'] as const;
export type NegativeUsagePolicy = (typeof NEGATIVE_USAGE_POLICIES)[number];

export const RECONCILE_ALLOC_POLICIES = ['PROPORTIONAL_TO_SETTLED', 'ALL_TO_CURRENT'] as const;
export type ReconcileAllocPolicy = (typeof RECONCILE_ALLOC_POLICIES)[number];

export const ESTIMATE_METHODS = ['AUTO_AVG3', 'MANUAL'] as const;
export type EstimateMethod = (typeof ESTIMATE_METHODS)[number];

export const RECEIPT_TYPES = ['RECEIPT'] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

export const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const STAFF_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

// cashier_day_close rows are created POSTED and immutable — corrections go
// through negative reversal payments, never in-place day-close reversal.
export const DAY_CLOSE_STATUSES = ['POSTED'] as const;
export type DayCloseStatus = (typeof DAY_CLOSE_STATUSES)[number];
