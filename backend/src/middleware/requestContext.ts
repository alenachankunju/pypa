/**
 * Request correlation and structured logging (FSD 11.6).
 *
 * Every request gets an id that flows into the log lines, the response envelope
 * meta block, and audit_logs.request_id. When a judge reports "it said something
 * went wrong at about quarter past two", that id is what turns the report into a
 * single traceable line rather than a search through the whole day.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../utils/logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';

export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Honour an upstream id where the platform supplies one, so a trace spans
    // the CDN and the function.
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId =
      (typeof incoming === 'string' && incoming.length <= 200 && incoming) || randomUUID();

    res.locals.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      // FSD 11.1 sets explicit latency targets. Anything materially over budget
      // is logged at warn so it surfaces in a rehearsal rather than on the day.
      const level = res.statusCode >= 500 ? 'error' : durationMs > 1000 ? 'warn' : 'info';

      logger[level](
        {
          requestId,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
          userId: req.auth?.userId,
          role: req.auth?.role,
        },
        'request',
      );
    });

    next();
  };
}
