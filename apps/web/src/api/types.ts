import type {
  AccountStatus,
  BillItemType,
  BillKind,
  BillSourceType,
  BillStatus,
  CalcType,
  ComponentSourceType,
  CustType,
  DataScope,
  DayCloseStatus,
  EstimateMethod,
  ExceptionCode,
  InstallReason,
  InstallationStatus,
  MeterStatus,
  OrgType,
  PayChannel,
  PaymentStatus,
  PermType,
  PlanItemStatus,
  PlanStatus,
  QcStatus,
  ReadResultType,
  ReadSource,
  ReconStatus,
  RunStatus,
  RunType,
  SettlementStatus,
  StaffStatus,
  TariffStatus,
} from '@ws/types';

/** Re-exported shared enums so pages can import everything from here. */
export type {
  AccountStatus,
  BillItemType,
  BillKind,
  BillSourceType,
  BillStatus,
  CalcType,
  ComponentSourceType,
  CustType,
  DataScope,
  DayCloseStatus,
  EstimateMethod,
  ExceptionCode,
  InstallReason,
  InstallationStatus,
  MeterStatus,
  OrgType,
  PayChannel,
  PaymentStatus,
  PermType,
  PlanItemStatus,
  PlanStatus,
  QcStatus,
  ReadResultType,
  ReadSource,
  ReconStatus,
  RunStatus,
  RunType,
  SettlementStatus,
  StaffStatus,
  TariffStatus,
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
  /** 监控表恒为 false（服务端/数据库双重约束），不参与开账。 */
  billable: boolean;
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

/** GET /water-accounts/:id — 在列表行基础上附带当前（展示用）人数。
 * 计费永远走结算快照，不读这个值。 */
export interface WaterAccountDetail extends WaterAccount {
  householdSize: number | null;
}

/** GET /water-accounts/:id/household-profiles — 一户多人口申报历史。 */
export interface HouseholdProfile {
  id: string;
  waterAccountId: string;
  householdSize: number;
  /** 生效账期 YYYYMM */
  effectiveFromPeriod: string;
  createdAt: string;
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
/** 抄表册节奏：MONTHLY 每月 / BIMONTHLY 双月（anchorPeriod 定奇偶）。 */
export type BookCadence = 'MONTHLY' | 'BIMONTHLY';
/** 表计通道：REMOTE_AUTO 仅登记元数据（本期无远传集成）。 */
export type MeterChannel = 'MECHANICAL' | 'REMOTE_MANUAL' | 'REMOTE_AUTO';

export interface ReadingBook {
  id: string;
  tenantId: string;
  bookNo: string;
  name: string;
  orgUnitId: string;
  readerId: string | null;
  scheduleDay: number | null;
  cadence: BookCadence;
  /** BIMONTHLY 必填，YYYYMM；MONTHLY 恒为 null。 */
  anchorPeriod: string | null;
  meterChannel: MeterChannel;
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
  account?: { accountNo: string; customerName: string; addr: string };
  meterNo?: string;
  operatorName?: string | null;
  qcByName?: string | null;
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
  /** 仅 NO_READ 可携带：抄表员预计用量（m³，非表码）。 */
  estimateQty: string | null;
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
  /** 立账时冻结的人口快照 —— 历史重算/补差的唯一依据。 */
  householdSizeSnapshot: number | null;
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

/* ------------------------------------------------------------------ */
/* billing domain — tariff / fee item / billing run / bill (spec §2.5)   */
/* ------------------------------------------------------------------ */

/** GET /fee-items — priced line kinds; code/calcType are write-once. */
export interface FeeItem {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  calcType: CalcType;
  createdAt: string;
  updatedAt: string;
}

/** GET /tariff-plans — the versioned price-book header. */
export interface TariffPlan {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  usageCategory: string;
  /** DATE columns — ISO strings. */
  effectiveFrom: string;
  effectiveTo: string | null;
  /** 一户多人口：基准人数（null = 不启用人数扩展）。 */
  baseHousehold: number | null;
  /** 每超出基准 1 人，各阶梯年度基数的扩展量（m³/年，decimal 字符串）。 */
  perPersonQty: string | null;
  status: TariffStatus;
  createdAt: string;
  updatedAt: string;
}

/** tariff_tier row inside GET /tariff-plans/:id — decimals as strings. */
export interface TariffTier {
  id: string;
  tenantId: string;
  tariffPlanId: string;
  feeItemId: string;
  tierNo: number;
  /** Decimal(18,4) — string on the wire. */
  fromQty: string;
  /** null = open-ended (∞) — only legal on the last tier. */
  toQty: string | null;
  /** Decimal(18,6) — string on the wire. */
  unitPrice: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /tariff-plans/:id — plan + tiers (feeItemId, tierNo ordered). */
export interface TariffPlanDetail extends TariffPlan {
  tiers: TariffTier[];
}

/** One unresolved failure inside billing_run.failed_settlement_ids (jsonb). */
export interface RunFailure {
  settlementId: string;
  /** Present on post-stage records — the DRAFT bill that failed to flip. */
  billId?: string;
  stage: 'generate' | 'post';
  code: string;
  message?: string;
}

/** GET /billing-runs — a period batch row. */
export interface BillingRun {
  id: string;
  tenantId: string;
  /** char(6) YYYYMM. */
  period: string;
  runType: RunType;
  status: RunStatus;
  postedAt: string | null;
  totalCount: number;
  successCount: number;
  failedCount: number;
  failedSettlementIds: RunFailure[] | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /billing-runs/:id — run + its bills (created order). */
export interface BillingRunDetail extends BillingRun {
  bills: Bill[];
}

/** GET /bills — the issued debt row; totalAmount is bigint cents (string). */
export interface Bill {
  id: string;
  tenantId: string;
  billingRunId: string | null;
  settleAccountId: string;
  waterAccountId: string;
  period: string;
  billKind: BillKind;
  sourceType: BillSourceType;
  sourceId: string;
  tariffPlanId: string | null;
  status: BillStatus;
  isEstimated: boolean;
  /** BigInt cents — string on the wire (negative on REVERSAL). */
  totalAmount: string;
  issuedAt: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/** bill_item — qty/unitPrice are decimals, amount is bigint cents. */
export interface BillItem {
  id: string;
  tenantId: string;
  billId: string;
  feeItemId: string | null;
  itemType: BillItemType;
  description: string | null;
  /** Decimal(18,4) — string; negated on reversal mirror rows. */
  qty: string | null;
  /** Decimal(18,6) — string. */
  unitPrice: string | null;
  /** BigInt cents — string on the wire. */
  amount: string;
  createdAt: string;
  updatedAt: string;
}

/** payment_alloc row as embedded in GET /bills/:id — E6 dual-source. */
export interface BillAlloc {
  id: string;
  source: 'PAYMENT' | 'PREPAYMENT';
  paymentId: string | null;
  prepaymentEntryId: string | null;
  amount: string;
  createdAt: string;
}

/** GET /bills/:id — bill + items + source-attributed allocations. */
export interface BillDetail extends Bill {
  items: BillItem[];
  allocs: BillAlloc[];
}

/* ------------------------------------------------------------------ */
/* payment domain — payment / alloc / receipt / day close (spec §2.6)    */
/* ------------------------------------------------------------------ */

/** GET /payments — amount is bigint cents (negative on reversal rows). */
export interface Payment {
  id: string;
  tenantId: string;
  paymentNo: string;
  settleAccountId: string;
  cashierId: string;
  orgUnitId: string;
  channel: PayChannel;
  amount: string;
  status: PaymentStatus;
  receivedAt: string;
  /** non-null marks this row as the appended reversal of that payment. */
  reversalOfId: string | null;
  dayCloseId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** payment_alloc — per-bill write-off line (bigint cents string).
 *  E6 dual-source: PAYMENT rows carry paymentId, PREPAYMENT rows carry
 *  prepaymentEntryId → the ledger settlement entry (APPLY/REVERSAL). */
export interface PaymentAlloc {
  id: string;
  tenantId: string;
  source: 'PAYMENT' | 'PREPAYMENT';
  paymentId: string | null;
  prepaymentEntryId: string | null;
  billId: string;
  amount: string;
  createdAt: string;
  updatedAt: string;
}

/** prepayment_ledger_entry — append-only, signed bigint cents. */
export interface PrepaymentEntry {
  id: string;
  settleAccountId: string;
  type: 'TOP_UP' | 'APPLY' | 'REFUND' | 'REVERSAL';
  amount: string;
  paymentId: string | null;
  billId: string | null;
  originTopUpId: string | null;
  reversalOfEntryId: string | null;
  idempotencyKey: string;
  operatorId: string | null;
  reason: string | null;
  createdAt: string;
  createdBy: string;
}

/** receipt — issued with every non-reversal payment; voided on reversal. */
export interface Receipt {
  id: string;
  tenantId: string;
  paymentId: string;
  receiptNo: string;
  rcpType: string;
  printedAt: string | null;
  voidFlag: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /payments/:id — payment + allocs + receipt (null on reversals)
 *  + the payment's prepayment ledger legs (E6). */
export interface PaymentDetail extends Payment {
  allocs: PaymentAlloc[];
  receipt: Receipt | null;
  prepaymentEntries: PrepaymentEntry[];
}

/** One payable line inside GET /water-accounts/:id/outstanding. */
export interface OutstandingItem {
  billId: string;
  period: string;
  billKind: BillKind;
  totalAmount: string;
  paidAmount: string;
  outstanding: string;
}

/**
 * The cashier's open-debt probe — items are the payable lines
 * (outstanding > 0); totalOutstanding is the settle account's NET
 * position (Σ over every live line minus reversed-bill credit).
 */
export interface AccountOutstanding {
  waterAccountId: string;
  settleAccountId: string;
  items: OutstandingItem[];
  /** Money applied to since-REVERSED bills — owed back to the customer. */
  reversedBillCredit: string;
  totalOutstanding: string;
  /** E6: settle account's prepayment balance (Σ ledger, cents string). */
  prepaymentBalance: string;
}

/** byChannel jsonb bucket on a cashier_day_close row (amounts strings). */
export interface ChannelBucket {
  count: number;
  amount: string;
}

/** GET /cashier-day-close — the signed daily summary document. */
export interface CashierDayClose {
  id: string;
  tenantId: string;
  cashierId: string;
  orgUnitId: string;
  /** DATE column — ISO string (YYYY-MM-DD). */
  closeDate: string;
  totalCount: number;
  /** BigInt cents — string on the wire. */
  totalAmount: string;
  byChannel: Partial<Record<PayChannel, ChannelBucket>>;
  /** E6 cash split — four parts always sum to totalAmount. */
  prepaymentBreakdown: {
    debtCollection: string;
    topUp: string;
    refundAmount: string;
    reversalAmount: string;
  } | null;
  status: DayCloseStatus;
  closedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Payment member row inside GET /cashier-day-close/:id. */
export interface DayClosePayment {
  id: string;
  paymentNo: string;
  channel: PayChannel;
  amount: string;
  status: PaymentStatus;
  receivedAt: string;
  reversalOfId: string | null;
  dayCloseId: string | null;
}

/** GET /cashier-day-close/:id — the close + the payments it swept. */
export interface CashierDayCloseDetail extends CashierDayClose {
  /** E6: company-wide SYSTEM APPLY on the close date — non-cash info. */
  systemApplyAmount: string;
  payments: DayClosePayment[];
}

/* ------------------------------------------------------------------ */
/* prepayment domain (E6)                                                */
/* ------------------------------------------------------------------ */

/** GET /prepayments/balance — balance + FIFO top-up lots. */
export interface PrepaymentBalance {
  settleAccount: { id: string; settleNo: string; name: string };
  balance: string;
  lots: {
    topUpEntryId: string;
    amount: string;
    remaining: string;
    createdAt: string;
  }[];
}

/** GET /prepayments/entries — paged ledger rows. */
export interface PrepaymentEntriesPage {
  total: number;
  items: PrepaymentEntry[];
}

/** POST /prepayments/top-ups result. */
export interface TopUpResult {
  payment: Payment;
  receipt: Receipt;
  billAllocs: { billId: string; amount: string }[];
  topUp: string;
  topUpEntryId: string | null;
  balance: string;
}

/** POST /prepayments/refunds result. */
export interface RefundResult {
  payment: Payment;
  entries: { id: string; originTopUpId: string; amount: string }[];
  balance: string;
}

/* ------------------------------------------------------------------ */
/* report domain — read-only projections (spec §4)                       */
/* ------------------------------------------------------------------ */

/** GET /reports/meter-daily — one row per reading book. */
export interface MeterDailyRow {
  bookId: string;
  bookNo: string;
  name: string;
  orgUnitId: string;
  /** Number of the book's plans in the date's period. */
  plans: number;
  total: number;
  read: number;
  noRead: number;
  pending: number;
  skipped: number;
  /** meter_reading rows with read_date = date attributed to the book. */
  readingsTaken: number;
}

/** GET /reports/cashier-daily — one row per cashier with collections. */
export interface CashierDailyRow {
  cashierId: string;
  name: string | null;
  byChannel: Partial<Record<PayChannel, ChannelBucket>>;
  total: ChannelBucket;
  /** A POSTED cashier_day_close exists for (cashier, close_date=date). */
  closed: boolean;
}

/** GET /reports/ar-monthly — billed cents by usage category. */
export interface ArMonthlyReport {
  period: string;
  /** BigInt cents — string on the wire. */
  billed: string;
  byCategory: Record<string, ChannelBucket>;
}

/** GET /reports/collected-monthly — collected cents by channel. */
export interface CollectedMonthlyReport {
  period: string;
  collected: string;
  byChannel: Partial<Record<PayChannel, ChannelBucket>>;
  /** alloc-side Σ for the same month — ≡ collected by construction. */
  allocated: string;
}

/** GET /reports/recovery-rate — rate is a 4-decimal string (null when billed=0). */
export interface RecoveryRateReport {
  period: string;
  through: string | null;
  billed: string;
  collected: string;
  rate: string | null;
}

// ---------------------------------------------------------------------------
// remote (E5 远传接入)
// ---------------------------------------------------------------------------

export type RemoteSourceType = 'FILE_IMPORT' | 'API_PULL' | 'WEBHOOK';
export type RemoteStatus = 'ACTIVE' | 'DISABLED';

/** GET /remote-sources row. `config` holds the vendor column mapping. */
export interface RemoteSource {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  type: RemoteSourceType;
  adapterKey: string;
  timezone: string;
  orgUnitId: string | null;
  credentialRef: string | null;
  config: Record<string, unknown> | null;
  status: RemoteStatus;
  createdAt: string;
  updatedAt: string;
}

/** GET /remote-devices row — vendor-side device identity (≠ Meter). */
export interface RemoteDevice {
  id: string;
  tenantId: string;
  remoteSourceId: string;
  vendorDeviceKey: string;
  vendorMeterNo: string | null;
  communicationId: string | null;
  model: string | null;
  status: RemoteStatus;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** Effective-dated device → installation binding [from, to). */
export interface RemoteDeviceBinding {
  id: string;
  tenantId: string;
  remoteSourceId: string;
  remoteDeviceId: string;
  installationId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
  /** Hydrated summary (binding list/detail only). */
  installation?: {
    id: string;
    waterAccountId: string;
    meterId: string;
    installedAt: string;
    removedAt: string | null;
    status: InstallationStatus;
    meter: { meterNo: string };
    waterAccount: { accountNo: string };
  } | null;
}

export interface RemoteDeviceDetail extends RemoteDevice {
  bindings: RemoteDeviceBinding[];
}

export type RemoteEventStatus =
  | 'RECEIVED'
  | 'UNBOUND'
  | 'WAITING_PLAN'
  | 'FAILED'
  | 'CONFLICT'
  | 'CONVERTED'
  | 'IGNORED';

/** GET /remote-events row — immutable raw ingest fact + processing state. */
export interface RawRemoteEvent {
  id: string;
  tenantId: string;
  remoteSourceId: string;
  externalEventKey: string;
  canonicalPayloadHash: string;
  vendorDeviceKey: string;
  businessPeriod: string;
  collectedAt: string;
  readingValue: string;
  vendorQuality: string | null;
  processingStatus: RemoteEventStatus;
  resolvedRemoteDeviceId: string | null;
  resolvedBindingId: string | null;
  currentIssueCode: string | null;
  currentIssueAt: string | null;
  receivedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteEventProcessLog {
  id: string;
  remoteEventId: string;
  action: string;
  fromStatus: RemoteEventStatus | null;
  toStatus: RemoteEventStatus | null;
  code: string | null;
  message: string | null;
  actorType: 'SYSTEM' | 'USER';
  actorStaffId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface RawRemoteEventDetail extends RawRemoteEvent {
  rawPayload: Record<string, unknown>;
  canonicalPayload: Record<string, unknown>;
  processLogs: RemoteEventProcessLog[];
  reading: {
    id: string;
    qcStatus: string;
    period: string;
    readingValue: string;
  } | null;
}

/** POST /remote-sources/:id/events outcome item. */
export interface IngestOutcome {
  index: number;
  externalEventKey: string;
  outcome: RemoteEventStatus | 'IDEMPOTENT_REPLAY' | 'EVENT_KEY_CONFLICT';
  eventId?: string;
  readingId?: string;
  code?: string;
}

/** POST /remote-sources/:id/import report. */
export interface RemoteImportReport {
  fileSha256: string;
  fileName: string | null;
  targetPeriod: string;
  totalRows: number;
  parsed: number;
  invalid: { row: number; code: string; error: string }[];
  outcomes: IngestOutcome[];
  counts: Record<string, number>;
}
