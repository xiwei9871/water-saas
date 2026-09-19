import axios, { AxiosError } from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import type { TokenPair } from './types';

/**
 * Axios client for the water-saas API.
 *
 * - baseURL '/api' — the vite dev proxy strips the prefix onto :3000
 *   (see vite.config.ts). In production the same '/api' prefix is expected
 *   to be routed to the API by the deployment's reverse proxy.
 * - Request interceptor injects `Authorization: Bearer <accessToken>`.
 * - Response interceptor: on 401 it tries ONE refresh (concurrent 401s share
 *   a single in-flight refresh call), replays the original request with the
 *   new token, and falls back to session-expiry (→ /login) when the refresh
 *   itself fails. Auth endpoints never trigger the retry path.
 * - Error bodies are `{code, message?}` — every rejection is normalized to
 *   `ApiError` so callers can switch on `err.code`.
 */

const ACCESS_KEY = 'water-saas.accessToken';
const REFRESH_KEY = 'water-saas.refreshToken';
const TENANT_CODE_KEY = 'water-saas.tenantCode';

/** Persisted session bits (localStorage). */
export const session = {
  get accessToken(): string | null {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refreshToken(): string | null {
    return localStorage.getItem(REFRESH_KEY);
  },
  /** Tenant code typed on the login form — shown in the header. */
  get tenantCode(): string | null {
    return localStorage.getItem(TENANT_CODE_KEY);
  },
  save(tokens: TokenPair, tenantCode?: string) {
    localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
    if (tenantCode !== undefined) {
      localStorage.setItem(TENANT_CODE_KEY, tenantCode);
    }
  },
  clear() {
    // Bumping the epoch invalidates any in-flight refresh — a refresh that
    // resolves AFTER logout must not write tokens back into storage.
    sessionEpoch += 1;
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(TENANT_CODE_KEY);
  },
};

/** Normalized API error — `code` is the server's stable error code. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * Raw error body when the server sent one — endpoints that return a
   * structured payload alongside `code` (e.g. IMPORT_VALIDATION_FAILED's
   * per-row `failed[]` report) are read from here.
   */
  readonly body: unknown;

  constructor(code: string, status: number, message?: string, body?: unknown) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

interface ErrorBody {
  code?: unknown;
  message?: unknown;
}

export const toApiError = (err: unknown): ApiError => {
  if (err instanceof ApiError) return err;
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 0;
    const body = err.response?.data as ErrorBody | undefined;
    const code =
      typeof body?.code === 'string'
        ? body.code
        : status > 0
          ? `HTTP_${status}`
          : 'NETWORK_ERROR';
    const message = Array.isArray(body?.message)
      ? body.message.join('；')
      : typeof body?.message === 'string'
        ? body.message
        : undefined;
    return new ApiError(code, status, message, body);
  }
  return new ApiError(
    'UNKNOWN',
    0,
    err instanceof Error ? err.message : undefined,
  );
};

export const errorCode = (err: unknown): string => toApiError(err).code;

/** Known server codes → Chinese labels for the UI. */
const CODE_LABELS: Record<string, string> = {
  INVALID_CREDENTIALS: '租户代码、账号或密码错误',
  LOGIN_FIELDS_REQUIRED: '请填写租户代码、账号与密码',
  REFRESH_TOKEN_REQUIRED: '登录状态不完整，请重新登录',
  TENANT_SUSPENDED: '租户已被停用，请联系平台方',
  TENANT_MISMATCH: '租户身份不匹配，请重新登录',
  STAFF_DISABLED: '账号已被禁用，请联系管理员',
  AUTH_TOKEN_MISSING: '请先登录',
  AUTH_TOKEN_INVALID: '登录已过期，请重新登录',
  PERMISSION_DENIED: '没有操作权限',
  ADMIN_REQUIRED: '仅系统管理员可执行该操作',
  ORG_OUT_OF_SCOPE: '超出数据权限范围',
  ORG_FIELDS_REQUIRED: '请填写组织名称与类型',
  ORG_NOT_FOUND: '组织不存在',
  ORG_PARENT_NOT_FOUND: '上级组织不存在',
  ORG_CYCLE: '不能将组织移动到自身或其下级',
  ORG_HAS_CHILDREN: '存在下级组织，无法删除',
  ORG_HAS_STAFF: '组织下仍有用户，无法删除',
  ORG_UNIT_NOT_FOUND: '组织不存在',
  STAFF_NOT_FOUND: '用户不存在',
  STAFF_FIELDS_REQUIRED: '请填写账号、姓名、密码与所属组织',
  INVALID_STAFF_STATUS: '用户状态无效',
  PASSWORD_REQUIRED: '请填写新密码',
  ROLE_NOT_FOUND: '角色不存在',
  ROLE_FIELDS_REQUIRED: '请填写角色编码、名称与数据范围',
  ROLE_IN_USE: '角色仍被用户使用，无法删除',
  ROLE_PROTECTED: '内置管理员角色不可删除',
  ROLE_IDS_MUST_BE_ARRAY: '角色绑定格式不正确',
  PERMISSION_NOT_FOUND: '权限不存在',
  PERMISSION_FIELDS_REQUIRED: '请填写权限编码与类型',
  PERMISSION_IDS_MUST_BE_ARRAY: '权限列表格式不正确',
  INVALID_PAGINATION: '分页参数不正确',
  PARAM_VALUE_REQUIRED: '参数值必填',
  UNIQUE_CONSTRAINT_VIOLATION: '已存在相同编码/账号的记录',
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: '重复提交：同一幂等键不能用于不同内容',
  IDEMPOTENCY_IN_PROGRESS: '相同请求正在处理中，请勿重复提交',
  INVALID_ID_FORMAT: 'ID 格式不正确',
  INVALID_DECIMAL: '数值格式不正确',
  INVALID_DATE: '日期格式不正确',
  // customer domain
  CUSTOMER_FIELDS_REQUIRED: '请填写客户名称与客户类型',
  CUSTOMER_NOT_FOUND: '客户不存在',
  CUST_TYPE_INVALID: '客户类型无效',
  SETTLE_ACCOUNT_FIELDS_REQUIRED: '请填写结算户名称',
  SETTLE_ACCOUNT_NOT_FOUND: '结算户不存在',
  SETTLE_ACCOUNT_CLOSED: '结算户已销户，无法修改',
  WATER_ACCOUNT_FIELDS_REQUIRED: '请填写水表户必填项（客户、结算户、用水类别、地址）',
  WATER_ACCOUNT_NOT_FOUND: '水表户不存在',
  ACCOUNT_STATUS_INVALID: '账户状态无效',
  ACCOUNT_CLOSED: '水表户已销户，无法操作',
  ACCOUNT_OUTSTANDING_BALANCE: '存在未结清余额或欠费，无法销户',
  INVALID_ACCOUNT_STATUS_TRANSITION: '当前账户状态不允许该操作',
  TRANSFER_TARGET_REQUIRED: '请选择过户目标客户或结算户',
  ONBOARD_CUSTOMER_XOR: '客户需二选一：新建或选择已有',
  ONBOARD_SETTLE_ACCOUNT_XOR: '结算户需二选一：新建或选择已有',
  ONBOARD_METER_XOR: '水表需二选一：登记新表或选择已有',
  METER_NOT_FOUND: '水表不存在',
  METER_STATUS_INVALID: '水表状态无效',
  METER_NOT_AVAILABLE: '水表非可用状态，无法安装',
  INVALID_METER_STATUS_TRANSITION: '当前水表状态不允许该操作',
  INSTALLATION_FIELDS_REQUIRED: '请填写装表必填项（水表户、水表、初始读数）',
  INSTALLATION_NOT_FOUND: '安装记录不存在',
  INSTALLATION_NOT_ACTIVE: '该安装记录已拆除',
  INSTALLATION_STATUS_INVALID: '安装状态无效',
  INSTALL_REASON_INVALID: '装表原因无效',
  FINAL_READING_REQUIRED: '请填写拆除读数',
  FINAL_READING_BEFORE_INITIAL: '拆除读数不能小于装表初始读数',
  // metering domain — books / plans
  SCHEDULE_DAY_INVALID: '抄表日需为 1-31 的整数',
  BOOK_FIELDS_REQUIRED: '请填写抄表册名称与所属组织',
  BOOK_NOT_FOUND: '抄表册不存在',
  READER_NOT_FOUND: '抄表员不存在',
  BOOK_HAS_PLANS: '该抄表册已生成过计划，无法删除',
  BOOK_MEMBER_FIELDS_REQUIRED: '请选择要加入的水表户',
  SEQ_NO_INVALID: '顺序号需为正整数',
  BOOK_MEMBER_NOT_FOUND: '该水表户不在抄表册中',
  PERIOD_INVALID: '账期格式不正确（YYYYMM）',
  PLAN_STATUS_INVALID: '计划状态无效',
  PLAN_ITEM_STATUS_INVALID: '计划明细状态无效',
  GENERATE_FIELDS_REQUIRED: '请选择抄表册并填写账期',
  PLAN_ALREADY_EXISTS: '该抄表册本期已有进行中的计划',
  EMPTY_BOOK: '抄表册为空（无有效成员），无法生成计划',
  PLAN_NOT_FOUND: '抄表计划不存在',
  INVALID_PLAN_STATUS_TRANSITION: '当前计划状态不允许该操作',
  // metering domain — readings / QC / import
  READING_FIELDS_REQUIRED: '请填写抄表记录必填项',
  RESULT_TYPE_INVALID: '抄表结果类型无效',
  READING_VALUE_REQUIRED: '请填写表码读数',
  READING_VALUE_NOT_ALLOWED: '未抄见不允许填写表码读数',
  EXCEPTION_CODE_REQUIRED: '请选择未抄见原因',
  EXCEPTION_CODE_INVALID: '未抄见原因无效',
  EXCEPTION_CODE_NOT_ALLOWED: '实抄/远传不允许填写异常代码',
  SOURCE_INVALID: '抄表来源无效',
  ITEMS_REQUIRED: '批量录入至少需要一条记录',
  READING_NOT_FOUND: '抄表记录不存在',
  PLAN_ITEM_NOT_FOUND: '计划明细不存在',
  ITEM_ALREADY_DONE: '该明细已完成抄表，更正请走“更正读数”',
  PLAN_NOT_OPEN: '计划已关闭或完成，无法继续抄表',
  NO_ACTIVE_INSTALLATION: '该水表户当前无在用表计，无法录入',
  DUPLICATE_PLAN_ITEM: '批量录入中存在重复的计划明细',
  QC_ACTION_INVALID: '质检动作无效',
  QC_STATUS_INVALID: '质检状态无效',
  INVALID_QC_STATUS_TRANSITION: '当前质检状态不允许该操作',
  READING_SUPERSEDED: '该记录已被更正，请对最新记录进行质检',
  NOT_SUPERSEDABLE: '未抄见记录不能更正读数',
  ALREADY_SUPERSEDED: '该记录已被更正，不能重复更正',
  IMPORT_BODY_REQUIRED: '请提供 CSV 内容',
  IMPORT_VALIDATION_FAILED: '导入校验失败，请按行修正后重新提交',
  ROW_MALFORMED: '行格式不正确（应为 4-5 列）',
  // metering domain — consumption settlements
  SETTLEMENT_STATUS_INVALID: '结算状态无效',
  IS_ESTIMATED_INVALID: '预估标志无效',
  SETTLEMENT_FIELDS_REQUIRED: '请选择水表户并填写账期',
  ESTIMATE_REASON_INVALID: '预估原因格式不正确',
  ESTIMATE_REASON_REQUIRED: '存在预估分量时必须填写预估原因',
  ESTIMATE_USAGE_REQUIRED: '无历史用量可预估，请手工填写用量',
  SETTLEMENT_NOT_FOUND: '结算记录不存在',
  SETTLEMENT_ALREADY_EXISTS: '该水表户本期已生成结算',
  SETTLEMENT_PERIOD_ALREADY_FINALIZED: '该账期已封结或已开账，无法在此账期拆表',
  INVALID_SETTLEMENT_STATUS_TRANSITION: '当前结算状态不允许该操作',
  NO_INSTALLATION_IN_PERIOD: '该账期内没有可用的表计安装记录',
  OVERRIDES_INVALID: '用量覆盖格式不正确',
  OVERRIDE_FIELDS_REQUIRED: '用量覆盖需包含安装记录与用量',
  OVERRIDE_TARGET_INVALID: '用量覆盖只能针对预估分量',
  USAGE_QTY_AMBIGUOUS: '存在多个预估分量，请使用 overrides 分别指定',
  DUPLICATE_OVERRIDE: '用量覆盖存在重复的安装记录',
  PREV_EXCEEDS_MAX_DIAL: '上期读数超出表计最大量程，请先修正读数链',
  NEGATIVE_USAGE: '读数倒挂且无法按量程翻转解释，请先更正读数',
  PREVIEW_FIELDS_REQUIRED: '请选择水表户并填写账期',
  // billing domain — reconciliation
  RECONCILIATION_STATUS_INVALID: '补差状态无效',
  RECONCILIATION_FIELDS_REQUIRED: '请选择水表户',
  RECONCILIATION_NOT_FOUND: '补差记录不存在',
  RECONCILIATION_EXISTS: '该实抄记录已完成补差，不能重复发起',
  RECONCILIATION_EMPTY_SPAN: '两次可信读数之间没有已结算水量，无需补差',
  RECONCILIATION_UNBILLED_SPAN: '区间内存在未出账结算，不能调账（可先吸收进草稿结算）',
  RECONCILIATION_TARIFF_MISSING: '区间内账期缺少有效资费方案，无法调账',
  ANCHOR_NOT_FOUND: '找不到可作为锚点的上一次可信读数',
  // billing domain — tariff plans / fee items
  TARIFF_STATUS_INVALID: '资费方案状态无效',
  TARIFF_PLAN_NOT_FOUND: '资费方案不存在',
  TARIFF_FIELDS_REQUIRED: '请填写资费方案必填项（编码、名称、用水类别、生效日期）',
  TARIFF_PLAN_VERSION_EXISTS: '该编码在相同生效日期已有版本',
  TARIFF_FROZEN: '该资费版本已被账单引用或已停用，计算字段不可修改（调价请走新版本）',
  INVALID_TARIFF_STATUS_TRANSITION: '当前资费状态不允许该操作',
  TARIFF_WINDOW_OVERLAP: '同用水类别下存在生效区间重叠的已生效方案',
  TARIFF_TIERS_EMPTY: '资费方案没有阶梯，无法激活',
  TARIFF_WINDOW_INVALID: '生效区间无效（结束日期需晚于开始日期；已生效方案只允许提前结束）',
  TARIFF_NAME_INVALID: '资费方案名称无效',
  TARIFF_IMMUTABLE_FIELD: '编码与用水类别为身份字段，不可修改',
  TIERS_INVALID: '阶梯数据格式不正确',
  TIER_FIELDS_REQUIRED: '阶梯行必填项缺失（费用项、档号、起始量、单价）',
  TIER_NO_INVALID: '阶梯档号需为正整数',
  TIER_DUPLICATE_NO: '同一费用项下档号重复',
  TIER_FROM_NOT_ZERO: '第一档起始量必须为 0',
  TIER_OPEN_ENDED_REQUIRED: '最后一档结束量必须留空（∞）',
  TIER_RANGE_INVALID: '阶梯区间无效（结束量需大于起始量）',
  TIER_NOT_CONTIGUOUS: '阶梯区间不连续（上一档结束量需等于下一档起始量）',
  CALC_TYPE_INVALID: '计费方式无效',
  FEE_ITEM_FIELDS_REQUIRED: '请填写费用项必填项（编码、名称、计费方式）',
  FEE_ITEM_NOT_FOUND: '费用项不存在',
  FEE_ITEM_CODE_TAKEN: '费用项编码已存在',
  FEE_ITEM_IMMUTABLE_FIELD: '编码与计费方式为身份字段，不可修改',
  FEE_ITEM_NAME_INVALID: '费用项名称无效',
  // billing domain — billing runs / bills
  RUN_STATUS_INVALID: '开账批次状态无效',
  BILLING_RUN_FIELDS_REQUIRED: '请填写账期',
  BILLING_RUN_NOT_FOUND: '开账批次不存在',
  INVALID_RUN_STATUS_TRANSITION: '当前批次状态不允许该操作',
  BILL_GENERATE_FAILED: '账单生成失败',
  BILL_POST_FAILED: '账单过账失败',
  TARIFF_NOT_FOUND: '该用水类别在账期内无已生效资费方案',
  BILL_STATUS_INVALID: '账单状态无效',
  BILL_NOT_FOUND: '账单不存在',
  BILL_NOT_REVERSABLE: '当前账单状态不允许红冲',
  BILL_NOT_REPLACEABLE: '当前账单状态不允许换票重开',
  BILL_ALREADY_REVERSED: '该账单已被红冲',
  BILL_ALREADY_REPLACED: '该账单已换票重开',
  BILL_USAGE_QTY_REQUIRED: '请填写更正后的用量',
  BILL_USAGE_QTY_SCALE: '用量最多 4 位小数',
  BILL_NOT_PAYABLE: '账单当前不可收款（状态或类型不允许）',
  // payment domain
  PAYMENT_STATUS_INVALID: '收款状态无效',
  PAY_CHANNEL_INVALID: '收款渠道无效',
  PAYMENT_FIELDS_REQUIRED: '请填写收款必填项（结算户、渠道、金额）',
  PAYMENT_ALLOCS_REQUIRED: '至少需要一条分摊明细',
  PAYMENT_ALLOC_FIELDS_REQUIRED: '分摊明细缺少账单或金额',
  PAYMENT_ALLOC_DUPLICATE: '分摊明细中存在重复的账单',
  PAYMENT_ALLOC_MISMATCH: '收款金额必须等于分摊合计',
  PAYMENT_NOT_FOUND: '收款记录不存在',
  PAYMENT_BILL_ACCOUNT_MISMATCH: '分摊账单不属于该结算户',
  PAYMENT_OVER_ALLOCATION: '分摊金额超出账单欠费余额',
  PAYMENT_NOT_REVERSABLE: '红冲记录不能再被红冲',
  PAYMENT_ALREADY_REVERSED: '该收款已被红冲',
  PAYMENT_ACCOUNT_CLOSED: '水表户已销户，红冲会复活欠费，请先处理销户流程',
  INVALID_AMOUNT: '金额格式不正确（须为整数分）',
  RECEIPT_NOT_FOUND: '收据不存在',
  RECEIPT_VOID: '收据已作废，不能打印',
  // day close
  DAY_CLOSE_NOT_FOUND: '日结单不存在',
  DAY_CLOSE_EXISTS: '该日期已完成日结，不能重复日结',
  DAY_CLOSE_EMPTY: '该日期（含之前）没有待日结的收款',
  DAY_CLOSE_LOST_RACE: '日结过程中收款状态被并发修改，请重试',
  // reports
  REPORT_PARAM_REQUIRED: '请填写报表查询参数',
  NOT_IMPLEMENTED: '该能力尚未开通（接口预留）',
  HTTP_500: '服务器内部错误，请稍后重试',
  NETWORK_ERROR: '网络异常，请检查 API 服务是否已启动',
};

/** Human-readable Chinese text for any thrown value. */
export const apiErrorText = (err: unknown): string => {
  const e = toApiError(err);
  return CODE_LABELS[e.code] ?? e.message ?? e.code;
};

export const api = axios.create({ baseURL: '/api', timeout: 15000 });

api.interceptors.request.use((config) => {
  const token = session.accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** Invoked when the session can no longer be renewed (→ show /login). */
let onSessionExpired: () => void = () => {};
export const setSessionExpiredHandler = (fn: (() => void) | null) => {
  onSessionExpired = fn ?? (() => {});
};

/**
 * Single in-flight refresh — every 401 that arrives while a refresh is
 * running queues onto the same promise instead of racing a second
 * POST /auth/refresh.
 */
let refreshPromise: Promise<string | null> | null = null;
/** Bumped by session.clear() so a stale in-flight refresh can't re-save. */
let sessionEpoch = 0;

const refreshTokens = (): Promise<string | null> => {
  refreshPromise ??= (async (): Promise<string | null> => {
    const refreshToken = session.refreshToken;
    if (!refreshToken) {
      session.clear();
      return null;
    }
    const epoch = sessionEpoch;
    try {
      // Bare axios (not `api`) — no interceptors, no recursion. Explicit
      // timeout: the `api` instance's 15s does not apply to this call, and a
      // hung refresh would stall every queued 401 forever.
      const res = await axios.post<TokenPair>(
        '/api/auth/refresh',
        { refreshToken },
        { timeout: 15000 },
      );
      if (!res.data?.accessToken || !res.data?.refreshToken) {
        session.clear();
        return null;
      }
      if (sessionEpoch === epoch) session.save(res.data);
      return res.data.accessToken;
    } catch (err) {
      // Only an auth rejection means the refresh token is dead — a transient
      // network failure keeps the stored pair so a reload can still resume.
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 401 || status === 403) session.clear();
      return null;
    }
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
};

type RetriableConfig = InternalAxiosRequestConfig & { _retry?: boolean };

/** Refresh must never be triggered by the auth endpoints themselves. */
const isAuthEndpoint = (url: string): boolean =>
  url.includes('/auth/login') || url.includes('/auth/refresh');

api.interceptors.response.use(
  (res) => res,
  async (err: unknown) => {
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      const config = err.config as RetriableConfig | undefined;
      if (
        status === 401 &&
        config &&
        !config._retry &&
        !isAuthEndpoint(config.url ?? '')
      ) {
        config._retry = true;
        const token = await refreshTokens();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
          return api.request(config);
        }
        onSessionExpired();
      }
    }
    return Promise.reject(toApiError(err));
  },
);
