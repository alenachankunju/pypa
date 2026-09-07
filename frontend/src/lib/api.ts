/**
 * API client.
 *
 * One place that knows about the response envelope (FSD 9), token refresh, and
 * the FSD 9.4 error codes. Everything else in the application calls through
 * here, so error handling is consistent and a judge never sees a raw fetch
 * failure.
 */

import { reportReachability } from '../hooks/useOnline';

export interface ApiMeta {
  requestId?: string;
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  [key: string]: unknown;
}

interface ApiSuccessBody<T> {
  success: true;
  data: T;
  meta?: ApiMeta;
}

interface ApiFailureBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
  meta?: ApiMeta;
}

/** FSD 9.4 standard error codes, plus the codes the API adds around them. */
export const ErrorCode = {
  ALREADY_SCORED: 'ALREADY_SCORED',
  SESSION_NOT_OPEN: 'SESSION_NOT_OPEN',
  NOT_ON_PANEL: 'NOT_ON_PANEL',
  PERFORMANCE_LOCKED: 'PERFORMANCE_LOCKED',
  MARK_OUT_OF_RANGE: 'MARK_OUT_OF_RANGE',
  DUPLICATE_CHEST_NUMBER: 'DUPLICATE_CHEST_NUMBER',
  INELIGIBLE_ITEM: 'INELIGIBLE_ITEM',
  ENTRY_LIMIT_EXCEEDED: 'ENTRY_LIMIT_EXCEEDED',
  RESULT_PUBLISHED: 'RESULT_PUBLISHED',
  CONFIG_LOCKED: 'CONFIG_LOCKED',
  TIE_UNRESOLVED: 'TIE_UNRESOLVED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  MUST_CHANGE_PASSWORD: 'MUST_CHANGE_PASSWORD',
  DEVICE_PIN_MISMATCH: 'DEVICE_PIN_MISMATCH',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  SESSION_REVOKED: 'SESSION_REVOKED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
  EVENT_FROZEN: 'EVENT_FROZEN',
  RATE_LIMITED: 'RATE_LIMITED',
  /** Client-only: the request never left the device. */
  NETWORK_OFFLINE: 'NETWORK_OFFLINE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  readonly requestId?: string;

  constructor(code: string, message: string, status: number, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }

  /** True where the request failed because the device has no connectivity. */
  get isOffline(): boolean {
    return this.code === ErrorCode.NETWORK_OFFLINE;
  }

  /** True where re-authenticating would resolve it. */
  get isAuthFailure(): boolean {
    return (
      this.code === ErrorCode.UNAUTHENTICATED ||
      this.code === ErrorCode.TOKEN_EXPIRED ||
      this.code === ErrorCode.TOKEN_INVALID ||
      this.code === ErrorCode.SESSION_REVOKED
    );
  }
}

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

// --- Token storage ----------------------------------------------------------
//
// Access token in memory only; refresh token in localStorage.
//
// The access token is short-lived and is never persisted, so closing the tab
// discards it. The refresh token has to survive a reload — FSD ADM-01-07 keeps a
// judge signed in for 12 hours precisely so a device lock does not force a
// re-login mid-item, and that is impossible without persistence.

const REFRESH_KEY = 'pypa.refresh';
const DEVICE_KEY = 'pypa.device';

let accessToken: string | null = null;
let accessExpiresAt = 0;
let refreshPromise: Promise<boolean> | null = null;

export function setAccessToken(token: string | null, expiresAt?: string): void {
  accessToken = token;
  accessExpiresAt = expiresAt ? new Date(expiresAt).getTime() : 0;
}

export function setRefreshToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    // Private browsing or blocked storage. The session still works until the
    // tab is closed; nothing here should throw.
  }
}

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function hasSession(): boolean {
  return Boolean(accessToken || getRefreshToken());
}

/**
 * A stable per-device identifier.
 *
 * ADM-01-08 pins a judge account to a single device, and ADM-14-02 records the
 * device against every score. Generated once and kept, so the same browser is
 * recognisable across sessions.
 */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'unknown-device';
  }
}

export function clearSession(): void {
  accessToken = null;
  accessExpiresAt = 0;
  setRefreshToken(null);
}

// --- Refresh ----------------------------------------------------------------

/**
 * Exchange the refresh token for a new access token.
 *
 * Concurrent callers share one in-flight request: without this, five queries
 * firing on a page load after expiry would each rotate the refresh token, and
 * four of them would then be holding a token the server has already revoked.
 */
async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  const token = getRefreshToken();
  if (!token) return false;

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });

      if (!response.ok) {
        clearSession();
        return false;
      }

      const body = (await response.json()) as ApiSuccessBody<{
        accessToken: string;
        refreshToken: string;
        expiresAt: string;
      }>;

      setAccessToken(body.data.accessToken, body.data.expiresAt);
      setRefreshToken(body.data.refreshToken);
      return true;
    } catch {
      // A network failure must NOT clear the session: the judge is probably just
      // offline, and signing them out would lose their queued marks.
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// --- Request ----------------------------------------------------------------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Skips the automatic refresh-and-retry. Used by the auth calls themselves. */
  skipAuth?: boolean;
}

export interface ApiResult<T> {
  data: T;
  meta?: ApiMeta;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const { method = 'GET', body, query, signal, skipAuth } = options;

  const url = new URL(`${BASE_URL}${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  // Refresh proactively when the access token is within 30 seconds of expiry,
  // rather than waiting for a 401. On a flaky venue network a pre-emptive
  // refresh is one round trip; a 401-then-retry is three.
  if (!skipAuth && accessToken && accessExpiresAt && Date.now() > accessExpiresAt - 30_000) {
    await refreshAccessToken();
  }

  const send = async (): Promise<Response> =>
    fetch(url.toString(), {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken && !skipAuth ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

  let response: Response;
  try {
    response = await send();
    // A completed round trip proves the API is reachable, which is stronger
    // evidence than navigator.onLine on a captive-portal network (FSD 6.8).
    reportReachability(true);
  } catch (error) {
    if (signal?.aborted) throw error;
    reportReachability(false);
    throw new ApiError(
      ErrorCode.NETWORK_OFFLINE,
      'No connection. Check the network and try again.',
      0,
    );
  }

  // One retry after a successful refresh.
  if (response.status === 401 && !skipAuth) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      try {
        response = await send();
      } catch {
        reportReachability(false);
        throw new ApiError(ErrorCode.NETWORK_OFFLINE, 'No connection. Check the network and try again.', 0);
      }
    }
  }

  if (response.status === 204) return { data: undefined as T };

  let payload: ApiSuccessBody<T> | ApiFailureBody;
  try {
    payload = (await response.json()) as ApiSuccessBody<T> | ApiFailureBody;
  } catch {
    throw new ApiError(
      ErrorCode.INTERNAL_ERROR,
      `The server returned an unexpected response (${response.status}).`,
      response.status,
    );
  }

  if (!response.ok || payload.success === false) {
    const failure = payload as ApiFailureBody;
    throw new ApiError(
      failure.error?.code ?? ErrorCode.INTERNAL_ERROR,
      failure.error?.message ?? 'Something went wrong. Please try again.',
      response.status,
      failure.error?.details,
      failure.meta?.requestId,
    );
  }

  return { data: payload.data, meta: payload.meta };
}

/**
 * A binary download (report PDF/Excel, snapshot export). request() always
 * calls response.json(), which would throw on a real file body — this is the
 * one path that needs the raw Blob instead, but still wants the same auth
 * token / proactive-refresh handling every other call gets.
 */
export async function downloadFile(
  path: string,
  query?: RequestOptions['query'],
): Promise<{ blob: Blob; filename: string | null }> {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  if (accessToken && accessExpiresAt && Date.now() > accessExpiresAt - 30_000) {
    await refreshAccessToken();
  }

  const send = () => fetch(url.toString(), { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });

  let response: Response;
  try {
    response = await send();
  } catch {
    throw new ApiError(ErrorCode.NETWORK_OFFLINE, 'No connection. Check the network and try again.', 0);
  }

  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) response = await send();
  }

  if (!response.ok) {
    let failure: ApiFailureBody | null = null;
    try {
      failure = (await response.json()) as ApiFailureBody;
    } catch {
      // Not a JSON error body — fall through to a generic message.
    }
    throw new ApiError(
      failure?.error?.code ?? ErrorCode.INTERNAL_ERROR,
      failure?.error?.message ?? `The download failed (${response.status}).`,
      response.status,
      failure?.error?.details,
      failure?.meta?.requestId,
    );
  }

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);

  return { blob: await response.blob(), filename: match?.[1] ?? null };
}

/**
 * A file upload (bulk import). Like request(), but sends a FormData body
 * instead of JSON — the browser sets the multipart Content-Type/boundary
 * itself, which is why this can't just add a header to request().
 */
export async function uploadFile<T>(path: string, file: File): Promise<ApiResult<T>> {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);

  if (accessToken && accessExpiresAt && Date.now() > accessExpiresAt - 30_000) {
    await refreshAccessToken();
  }

  const send = () => {
    const form = new FormData();
    form.append('file', file);
    return fetch(url.toString(), {
      method: 'POST',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      body: form,
    });
  };

  let response: Response;
  try {
    response = await send();
  } catch {
    throw new ApiError(ErrorCode.NETWORK_OFFLINE, 'No connection. Check the network and try again.', 0);
  }

  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      try {
        response = await send();
      } catch {
        throw new ApiError(ErrorCode.NETWORK_OFFLINE, 'No connection. Check the network and try again.', 0);
      }
    }
  }

  let payload: ApiSuccessBody<T> | ApiFailureBody;
  try {
    payload = (await response.json()) as ApiSuccessBody<T> | ApiFailureBody;
  } catch {
    throw new ApiError(
      ErrorCode.INTERNAL_ERROR,
      `The server returned an unexpected response (${response.status}).`,
      response.status,
    );
  }

  if (!response.ok || payload.success === false) {
    const failure = payload as ApiFailureBody;
    throw new ApiError(
      failure.error?.code ?? ErrorCode.INTERNAL_ERROR,
      failure.error?.message ?? 'Something went wrong. Please try again.',
      response.status,
      failure.error?.details,
      failure.meta?.requestId,
    );
  }

  return { data: payload.data, meta: payload.meta };
}

/** Convenience wrappers. Most callers want the data and nothing else. */
export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    request<T>(path, { query, signal }).then((r) => r.data),

  getWithMeta: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    request<T>(path, { query, signal }),

  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }).then((r) => r.data),

  postWithMeta: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),

  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }).then((r) => r.data),

  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }).then((r) => r.data),

  del: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }).then((r) => r.data),

  raw: request,

  downloadFile,
  uploadFile,
};

export { refreshAccessToken };
