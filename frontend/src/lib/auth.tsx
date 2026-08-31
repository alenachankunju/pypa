/**
 * Authentication context.
 *
 * Holds the signed-in identity and the capability set the server reported.
 *
 * FSD 3.2 is explicit that capabilities here are a CONVENIENCE: "the user
 * interface hides unavailable actions but the server must enforce them
 * independently". Nothing in this file is a security control — every guarded
 * action is refused server-side regardless of what the client renders.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  api,
  clearSession,
  deviceId,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from './api';

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'JUDGE' | 'COORDINATOR';

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  mustChangePassword: boolean;
  capabilities: string[];
  sessionTtlHours?: number;
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshExpiresAt: string;
  user: AuthUser & { landingRoute: string };
}

interface AuthContextValue {
  user: AuthUser | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  landingRoute: string;
  login: (username: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  can: (capability: string) => boolean;
  isJudge: boolean;
  isAdmin: boolean;
  refreshIdentity: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function landingRouteFor(role: UserRole): string {
  if (role === 'JUDGE') return '/judge';
  if (role === 'COORDINATOR') return '/admin/live';
  return '/admin';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');

  /**
   * Restore a session on load.
   *
   * ADM-01-07 keeps a judge signed in for 12 hours so a device lock does not
   * force a re-login mid-item, which means a page reload must silently recover
   * the session rather than showing the login screen.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!getRefreshToken()) {
        setStatus('anonymous');
        return;
      }

      try {
        const refreshed = await api.raw<LoginResponse>('/api/auth/refresh', {
          method: 'POST',
          body: { refreshToken: getRefreshToken() },
          skipAuth: true,
        });

        if (cancelled) return;

        setAccessToken(refreshed.data.accessToken, refreshed.data.expiresAt);
        setRefreshToken(refreshed.data.refreshToken);
        setUser(refreshed.data.user);
        setStatus('authenticated');
      } catch {
        if (cancelled) return;
        clearSession();
        setStatus('anonymous');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<AuthUser> => {
    const response = await api.post<LoginResponse>('/api/auth/login', {
      username,
      password,
      // ADM-01-08: lets the server claim or verify the device pin.
      deviceId: deviceId(),
    });

    setAccessToken(response.accessToken, response.expiresAt);
    setRefreshToken(response.refreshToken);
    setUser(response.user);
    setStatus('authenticated');

    return response.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // A failed sign-out must still sign the user out locally — otherwise a
      // judge handing their phone over cannot clear it without connectivity.
    }
    clearSession();
    setUser(null);
    setStatus('anonymous');
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await api.post('/api/auth/change-password', { currentPassword, newPassword });
    // ADM-01-05 is now satisfied, so the rest of the application unlocks.
    setUser((current) => (current ? { ...current, mustChangePassword: false } : current));
  }, []);

  const refreshIdentity = useCallback(async () => {
    try {
      const me = await api.get<AuthUser>('/api/auth/me');
      setUser(me);
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) {
        clearSession();
        setUser(null);
        setStatus('anonymous');
      }
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      landingRoute: user ? landingRouteFor(user.role) : '/login',
      login,
      logout,
      changePassword,
      can: (capability: string) => user?.capabilities.includes(capability) ?? false,
      isJudge: user?.role === 'JUDGE',
      isAdmin: user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN',
      refreshIdentity,
    }),
    [user, status, login, logout, changePassword, refreshIdentity],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider.');
  return context;
}

/** Capability names, mirroring src/middleware/authorize.ts on the server. */
export const Capability = {
  MANAGE_ADMIN_ACCOUNTS: 'MANAGE_ADMIN_ACCOUNTS',
  MANAGE_JUDGE_ACCOUNTS: 'MANAGE_JUDGE_ACCOUNTS',
  RESET_PASSWORD: 'RESET_PASSWORD',
  MANAGE_CHURCHES: 'MANAGE_CHURCHES',
  MANAGE_CATEGORIES: 'MANAGE_CATEGORIES',
  MANAGE_ITEMS: 'MANAGE_ITEMS',
  MANAGE_MEMBERS: 'MANAGE_MEMBERS',
  MANAGE_REGISTRATIONS: 'MANAGE_REGISTRATIONS',
  MANAGE_PANELS: 'MANAGE_PANELS',
  MANAGE_SESSIONS: 'MANAGE_SESSIONS',
  CONTROL_STAGE: 'CONTROL_STAGE',
  MARK_ABSENT: 'MARK_ABSENT',
  ENTER_SCORE: 'ENTER_SCORE',
  BACK_ENTER_SCORE: 'BACK_ENTER_SCORE',
  VIEW_OWN_SCORES: 'VIEW_OWN_SCORES',
  VIEW_ALL_SCORES: 'VIEW_ALL_SCORES',
  VIEW_SCORE_PROGRESS: 'VIEW_SCORE_PROGRESS',
  REVOKE_SCORE: 'REVOKE_SCORE',
  CONFIGURE_SCORING: 'CONFIGURE_SCORING',
  VIEW_PROVISIONAL_RESULTS: 'VIEW_PROVISIONAL_RESULTS',
  PUBLISH_RESULTS: 'PUBLISH_RESULTS',
  EXPORT_REPORTS: 'EXPORT_REPORTS',
  VIEW_AUDIT_LOG: 'VIEW_AUDIT_LOG',
  BACKUP_RESTORE: 'BACKUP_RESTORE',
  MANAGE_SETTINGS: 'MANAGE_SETTINGS',
} as const;
