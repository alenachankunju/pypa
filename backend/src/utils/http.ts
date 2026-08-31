/**
 * HTTP response envelope and route helpers.
 *
 * FSD 9: "All responses use a consistent envelope carrying success, data, and an
 * error object with a machine-readable code and a human-readable message."
 * Every route in the application returns through these helpers, so the contract
 * holds without each handler having to remember it.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ErrorCodeValue } from './errors.js';

export interface ApiMeta {
  requestId?: string;
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  [key: string]: unknown;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: ApiMeta;
}

export interface ApiFailure {
  success: false;
  error: {
    code: ErrorCodeValue;
    message: string;
    details?: unknown;
  };
  meta?: ApiMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function ok<T>(res: Response, data: T, meta?: ApiMeta, status = 200): Response {
  const body: ApiSuccess<T> = { success: true, data };
  if (meta || res.locals.requestId) {
    body.meta = { requestId: res.locals.requestId as string | undefined, ...meta };
  }
  return res.status(status).json(body);
}

export function created<T>(res: Response, data: T, meta?: ApiMeta): Response {
  return ok(res, data, meta, 201);
}

export function noContent(res: Response): Response {
  return res.status(204).send();
}

/** Paginated list response with the meta block the admin tables expect. */
export function paginated<T>(
  res: Response,
  rows: T[],
  page: number,
  pageSize: number,
  total: number,
  extraMeta?: ApiMeta,
): Response {
  return ok(res, rows, {
    page,
    pageSize,
    total,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
    ...extraMeta,
  });
}

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 *
 * Express 4 does not await handlers; without this an async throw becomes an
 * unhandled rejection and the request hangs until the client times out. On event
 * day that presents as a judge's phone spinning forever, which is precisely the
 * failure mode FSD 10.1 calls a defect.
 */
export function asyncHandler<
  P = Record<string, string>,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = Record<string, unknown>,
>(
  handler: (
    req: Request<P, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction,
  ) => Promise<unknown>,
): RequestHandler<P, ResBody, ReqBody, ReqQuery> {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** Normalised pagination parameters from a query string. */
export interface PageParams {
  page: number;
  pageSize: number;
  offset: number;
}

export function pageParams(query: Record<string, unknown>, defaultSize = 50): PageParams {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const requested = Number.parseInt(String(query.pageSize ?? defaultSize), 10) || defaultSize;
  // Capped so a crafted request cannot ask for the whole 5,000-member roster in
  // one page and blow the FSD 11.1 latency budget.
  const pageSize = Math.min(Math.max(1, requested), 200);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Client IP, honouring the proxy header set by Netlify / Vercel. */
export function clientIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) return forwarded[0];
  return req.ip ?? req.socket.remoteAddress ?? undefined;
}
