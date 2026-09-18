import type {
  AccountStatus,
  ComponentSourceType,
  CustType,
  DataScope,
  EstimateMethod,
  ExceptionCode,
  InstallReason,
  InstallationStatus,
  MeterStatus,
  OrgType,
  PermType,
  PlanItemStatus,
  PlanStatus,
  QcStatus,
  ReadResultType,
  ReadSource,
  ReconStatus,
  SettlementStatus,
  StaffStatus,
} from '@ws/types';

/** Re-exported shared enums so pages can import everything from here. */
export type {
  AccountStatus,
  ComponentSourceType,
  CustType,
  DataScope,
  EstimateMethod,
  ExceptionCode,
  InstallReason,
  InstallationStatus,
  MeterStatus,
  OrgType,
  PermType,
  PlanItemStatus,
  PlanStatus,
  QcStatus,
  ReadResultType,
  ReadSource,
  ReconStatus,
  SettlementStatus,
  StaffStatus,
} from '@ws/types';

/**
 * Wire shapes returned by the API (apps/api). Dates serialize as ISO
 * strings; Decimal/BigInt columns serialize as strings. Keep in sync with
 * the iam controllers — spec §4.
 */

export interface RoleSummary {
  code: string;
  name: string;
  dataScope: DataScope;
}

/** POST /auth/login */
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  staff: { id: string; login: string; name: string; orgUnitId: string };
  roles: RoleSummary[];
  perms: string[];
}

/** POST /auth/refresh */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** GET /auth/me — the session user's fresh identity view. */
export interface SessionUser {
  id: string;
  login: string;
  name: string;
  status: StaffStatus;
  orgUnitId: string;
  tenantId: string;
  roles: RoleSummary[];
  perms: string[];
  scope: DataScope;
  orgScope: string[];
}

export interface OrgUnit {
  id: string;
  tenantId: string;
  parentId: string | null;
  name: string;
  type: OrgType;
  createdAt: string;
  updatedAt: string;
}

export interface Staff {
  id: string;
  tenantId: string;
  orgUnitId: string;
  login: string;
  name: string;
  status: StaffStatus;
  createdAt: string;
  updatedAt: string;
}

/** GET /iam/roles — rows carry their bound permission CODES in `perms`. */
export interface Role {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  dataScope: DataScope;
  perms: string[];
  createdAt: string;
  updatedAt: string;
}

/** GET /iam/roles/permissions/list — the tenant's permission dictionary. */
export interface Permission {
  id: string;
  tenantId: string;
  code: string;
  type: PermType;
  createdAt: string;
  updatedAt: string;
}

/** GET /iam/tenant-params — PK is (tenantId, key); value is arbitrary JSON. */
export interface TenantParam {
  tenantId: string;
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

/** GET /iam/audit-logs — append-only operation log (before/after omitted). */
export interface AuditLog {
  id: string;
  staffId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  ip: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* customer domain (spec §2.1 三户模型)                                  */
/* ------------------------------------------------------------------ */

/** Compact water_account row embedded in customer/settle_account detail. */
export interface WaterAccountRef {
  id: string;
  accountNo: string;
  status: AccountStatus;
  usageCategory: string;
}

/** GET /customers */
export interface Customer {
  id: string;
  tenantId: string;
  customerNo: string;
  name: string;
  custType: CustType;
  idType: string | null;
  idNo: string | null;
  phone: string | null;
  addr: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /customers/:id — profile + the customer's water accounts. */
export interface CustomerDetail extends Customer {
  waterAccounts: WaterAccountRef[];
}

/** GET /settle-accounts */
export interface SettleAccount {
  id: string;
  tenantId: string;
  settleNo: string;
  name: string;
  phone: string | null;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

/** GET /settle-accounts/:id — profile + settling water accounts. */
export interface SettleAccountDetail extends SettleAccount {
  waterAccounts: WaterAccountRef[];
}

/** GET /water-accounts — list rows carry the customer/settle joins. */
export interface WaterAccount {
  id: string;
  tenantId: string;
  accountNo: string;
  customerId: string;
  settleAccountId: string;
  usageCategory: string;
  addr: string;
  status: AccountStatus;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  customer: { id: string; customerNo: string; name: string; custType: CustType };
  settleAccount: {
    id: string;
    settleNo: string;
    name: string;
    status: AccountStatus;
  };
}

/** GET /meters */
export interface Meter {
  id: string;
  tenantId: string;
  meterNo: string;
  serialNo: string | null;
  barcode: string | null;
  brand: string | null;
  model: string | null;
  caliber: string | null;
  /** Decimal column — serialized as a string on the wire. */
  maxDial: string | null;
  parentMeterId: string | null;
  status: MeterStatus;
  createdAt: string;
  updatedAt: string;
}

/** GET /meter-installations — list rows carry meter + water_account joins. */
export interface MeterInstallation {
  id: string;
  tenantId: string;
  waterAccountId: string;
  meterId: string;
  installedAt: string;
  removedAt: string | null;
  /** Decimal columns — strings on the wire. */
  initialReading: string;
  finalReading: string | null;
  reason: InstallReason;
  status: InstallationStatus;
  createdAt: string;
  updatedAt: string;
  meter: {
    id: string;
    meterNo: string;
    status: MeterStatus;
    brand: string | null;
    model: string | null;
  };
  waterAccount: { id: string; accountNo: string; status: AccountStatus };
}

/** POST /water-accounts/onboard response — the whole freshly-built graph. */
export interface OnboardResult {
  customer: Customer;
  settleAccount: SettleAccount;
  waterAccount: WaterAccount;
  meter: {
    id: string;
    meterNo: string;
    status: MeterStatus;
    brand: string | null;
    model: string | null;
  };
  installation: MeterInstallation;
}

/* ------------------------------------------------------------------ */
/* metering domain (spec §2.2 抄表 / §2.3 结算水量)                      */
/* ------------------------------------------------------------------ */

/** GET /reading-books */
export interface ReadingBook {
  id: string;
  tenantId: string;
  bookNo: string;
  name: string;
  orgUnitId: string;
  readerId: string | null;
  scheduleDay: number | null;
  createdAt: string;
  updatedAt: string;
}

/** One member row inside GET /reading-books/:id (seq_no ordered). */
export interface BookMember {
  waterAccountId: string;
  seqNo: number;
  waterAccount: {
    id: string;
    accountNo: string;
    addr: string;
    status: AccountStatus;
  } | null;
}

/** GET /reading-books/:id — book + current members. */
export interface ReadingBookDetail extends ReadingBook {
  members: BookMember[];
}

/** GET /reading-plans */
export interface ReadingPlan {
  id: string;
  tenantId: string;
  bookId: string;
  /** char(6) YYYYMM. */
  period: string;
  planDate: string;
  readerId: string | null;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

/** reading_plan_item — the generation-time book snapshot. */
export interface ReadingPlanItem {
  id: string;
  tenantId: string;
  planId: string;
  waterAccountId: string;
  seqNo: number;
  plannedInstallationId: string | null;
  status: PlanItemStatus;
  completedReadingId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /reading-plans/:id — plan + all items (seq_no ordered). */
export interface ReadingPlanDetail extends ReadingPlan {
  items: ReadingPlanItem[];
}

/** GET /reading-plans/:id/progress — every key always present (0-filled). */
export interface ReadingPlanProgress {
  planId: string;
  planStatus: PlanStatus;
  PENDING: number;
  READ: number;
  NO_READ: number;
  SKIPPED: number;
  total: number;
}

/**
 * GET /meter-readings — append-only fact rows. Decimal columns serialize
 * as strings. `supersededById` is a hydrated convenience field (child-row
 * probe): non-null when a newer correction row points at this one.
 */
export interface MeterReading {
  id: string;
  tenantId: string;
  planItemId: string | null;
  installationId: string;
  meterId: string;
  period: string;
  readDate: string;
  resultType: ReadResultType;
  readingValue: string | null;
  exceptionCode: ExceptionCode | null;
  supersedesReadingId: string | null;
  supersededById: string | null;
  qcStatus: QcStatus;
  qcBy: string | null;
  qcAt: string | null;
  source: ReadSource;
  operatorId: string | null;
  photoRef: string | null;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One failed row inside a 400 IMPORT_VALIDATION_FAILED body. */
export interface ImportRowError {
  row: number;
  code: string;
  error: string;
}

/** GET /consumption-settlements list + detail rows (components inline). */
export interface ConsumptionComponent {
  id: string;
  tenantId: string;
  settlementId: string;
  installationId: string;
  /** Decimal columns — strings on the wire. */
  prevReadingValue: string;
  endReadingValue: string | null;
  usageQty: string;
  sourceType: ComponentSourceType;
  sourceReadingId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EstimateBasis {
  historyUsageQtys?: string[];
  componentBreakdown?: {
    installationId: string;
    sourceType: ComponentSourceType;
    sourceReadingId: string | null;
    prevReadingValue: string;
    endReadingValue: string;
    usageQty: string;
    method?: EstimateMethod;
    suggestedUsageQty?: string | null;
  }[];
}

export interface ConsumptionSettlement {
  id: string;
  tenantId: string;
  waterAccountId: string;
  period: string;
  totalUsageQty: string;
  isEstimated: boolean;
  estimateMethod: EstimateMethod | null;
  estimateBasis: EstimateBasis | null;
  estimateReason: string | null;
  status: SettlementStatus;
  createdAt: string;
  updatedAt: string;
  components: ConsumptionComponent[];
  /** Trailing run of consecutive estimated settlements (per account). */
  consecutiveEstimates: number;
}

/** POST /estimate/preview response. */
export interface EstimatePreview {
  suggestedUsage: string | null;
  method: EstimateMethod;
  basis: { window: number; historyUsageQtys: string[] };
}

/* ------------------------------------------------------------------ */
/* billing domain — reconciliation 补差 (spec §2.4)                      */
/* ------------------------------------------------------------------ */

/** GET /reconciliations — append-only calibration rows. */
export interface Reconciliation {
  id: string;
  tenantId: string;
  waterAccountId: string;
  anchorReadingId: string;
  actualReadingId: string;
  /** Inclusive span (fromPeriod, toPeriod] covered by the recon. */
  fromPeriod: string;
  toPeriod: string;
  actualTotalUsage: string;
  previouslySettledUsage: string;
  remainderUsage: string;
  absorbedSettlementId: string | null;
  /** BigInt columns — cent amounts serialized as strings. */
  correctChargeCent: string | null;
  postedChargeCent: string | null;
  adjustmentAmountCent: string | null;
  status: ReconStatus;
  createdAt: string;
  updatedAt: string;
}

/** POST /reconciliations — row + the adjustment bill it minted (if any). */
export interface ReconciliationCreated extends Reconciliation {
  adjustmentBill: { id: string; totalAmount: string; status: string } | null;
}
