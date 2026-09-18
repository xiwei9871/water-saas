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
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(TENANT_CODE_KEY);
  },
};

/** Normalized API error — `code` is the server's stable error code. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
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
    return new ApiError(code, status, message);
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
  TENANT_SUSPENDED: '租户已被停用，请联系平台方',
  STAFF_DISABLED: '账号已被禁用，请联系管理员',
  AUTH_TOKEN_MISSING: '请先登录',
  AUTH_TOKEN_INVALID: '登录已过期，请重新登录',
  PERMISSION_DENIED: '没有操作权限',
  ADMIN_REQUIRED: '仅系统管理员可执行该操作',
  ORG_OUT_OF_SCOPE: '超出数据权限范围',
  ORG_NOT_FOUND: '组织不存在',
  ORG_PARENT_NOT_FOUND: '上级组织不存在',
  ORG_CYCLE: '不能将组织移动到自身或其下级',
  ORG_HAS_CHILDREN: '存在下级组织，无法删除',
  ORG_HAS_STAFF: '组织下仍有用户，无法删除',
  ORG_UNIT_NOT_FOUND: '组织不存在',
  STAFF_NOT_FOUND: '用户不存在',
  ROLE_NOT_FOUND: '角色不存在',
  ROLE_IN_USE: '角色仍被用户使用，无法删除',
  ROLE_PROTECTED: '内置管理员角色不可删除',
  PERMISSION_NOT_FOUND: '权限不存在',
  PARAM_VALUE_REQUIRED: '参数值必填',
  UNIQUE_CONSTRAINT: '已存在相同编码/账号的记录',
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: '重复提交：同一幂等键不能用于不同内容',
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

const refreshTokens = (): Promise<string | null> => {
  refreshPromise ??= (async (): Promise<string | null> => {
    const refreshToken = session.refreshToken;
    if (!refreshToken) return null;
    try {
      // Bare axios (not `api`) — no interceptors, no recursion.
      const res = await axios.post<TokenPair>('/api/auth/refresh', {
        refreshToken,
      });
      session.save(res.data);
      return res.data.accessToken;
    } catch {
      session.clear();
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
