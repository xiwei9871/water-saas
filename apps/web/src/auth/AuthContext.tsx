import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { api, session, setSessionExpiredHandler } from '../api/client';
import type { LoginResponse, SessionUser } from '../api/types';

interface AuthContextValue {
  /** null = unauthenticated. */
  user: SessionUser | null;
  /** True while a persisted token is being verified via /auth/me. */
  loading: boolean;
  /** Tenant code typed on the login form (displayed in the header). */
  tenantCode: string | null;
  login: (tenantCode: string, login: string, password: string) => Promise<void>;
  logout: () => void;
  /** ANY-of check; the admin wildcard '*' grants everything. */
  hasPerm: (...codes: string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  // Only "restoring" when a persisted token exists — otherwise the login
  // page renders immediately.
  const [loading, setLoading] = useState(() => session.accessToken !== null);
  const [tenantCode, setTenantCode] = useState<string | null>(
    () => session.tenantCode,
  );

  useEffect(() => {
    let cancelled = false;
    setSessionExpiredHandler(() => setUser(null));
    if (!session.accessToken) {
      return () => setSessionExpiredHandler(null);
    }
    api
      .get<SessionUser>('/auth/me')
      .then((res) => {
        if (!cancelled) setUser(res.data);
      })
      .catch(() => {
        // Refresh already failed inside the interceptor (tokens cleared).
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      setSessionExpiredHandler(null);
    };
  }, []);

  const login = useCallback(
    async (tenant: string, account: string, password: string) => {
      const res = await api.post<LoginResponse>('/auth/login', {
        tenantCode: tenant,
        login: account,
        password,
      });
      session.save(
        {
          accessToken: res.data.accessToken,
          refreshToken: res.data.refreshToken,
        },
        tenant,
      );
      setTenantCode(tenant);
      // /auth/me is the identity source of truth (fresh scope + orgScope).
      const me = await api.get<SessionUser>('/auth/me');
      setUser(me.data);
    },
    [],
  );

  const logout = useCallback(() => {
    session.clear();
    setUser(null);
    setTenantCode(null);
  }, []);

  const hasPerm = useCallback(
    (...codes: string[]) => {
      if (!user) return false;
      if (user.perms.includes('*')) return true;
      return codes.some((c) => user.perms.includes(c));
    },
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, tenantCode, login, logout, hasPerm }),
    [user, loading, tenantCode, login, logout, hasPerm],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react/only-export-components -- hook lives next to its provider
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
