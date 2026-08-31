/**
 * Central error handling.
 *
 * Two requirements shape this module:
 *
 *  FSD 11.3 — "Error messages state what went wrong and what to do next, in
 *  plain language." Anything an AppError carries is written for a user and is
 *  passed through verbatim.
 *
 *  FSD 11.2 — internals must not leak. An error that is not an AppError is an
 *  unexpected fault: it is logged in full server-side and reported to the client
 *  as a generic INTERNAL_ERROR with the request id, so an operator can quote the
 *  id and an engineer can find the stack.
 */
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../config/env.js';
import { AppError, ErrorCode, translateDatabaseError } from '../utils/errors.js';
import type { ApiFailure } from '../utils/http.js';
import { logger } from '../utils/logger.js';

/** 404 for an unmatched route, in the standard envelope. */
export function notFoundHandler(): RequestHandler {
  return (req: Request, res: Response) => {
    const body: ApiFailure = {
      success: false,
      error: {
        code: ErrorCode.NOT_FOUND,
        message: `No route matches ${req.method} ${req.originalUrl.split('?')[0]}.`,
      },
      meta: { requestId: res.locals.requestId as string | undefined },
    };
    res.status(404).json(body);
  };
}

export function errorHandler(): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);

    const requestId = res.locals.requestId as string | undefined;
    const appError = toAppError(error);

    // 5xx is a fault in the system; 4xx is the system correctly refusing. Only
    // the former deserves an error-level log with a stack.
    if (appError.status >= 500) {
      logger.error(
        {
          requestId,
          err: appError.cause ?? error,
          code: appError.code,
          path: req.originalUrl.split('?')[0],
          method: req.method,
          userId: req.auth?.userId,
        },
        appError.message,
      );
    } else {
      logger.debug(
        {
          requestId,
          code: appError.code,
          status: appError.status,
          path: req.originalUrl.split('?')[0],
          userId: req.auth?.userId,
        },
        appError.message,
      );
    }

    const body: ApiFailure = {
      success: false,
      error: {
        code: appError.code,
        message:
          appError.status >= 500 && isProduction
            ? 'Something went wrong at our end. Please try again, and quote the request id if it keeps happening.'
            : appError.message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      },
      meta: { requestId },
    };

    res.status(appError.status).json(body);
  };
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  // Zod validation failures become a field-level VALIDATION_ERROR so the client
  // can highlight the offending input rather than showing a banner.
  if (error instanceof ZodError) {
    return new AppError(ErrorCode.VALIDATION_ERROR, 'Some of the details supplied are not valid.', {
      details: {
        fields: error.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          code: issue.code,
          message: issue.message,
        })),
      },
      cause: error,
    });
  }

  // The database is a real participant in enforcement (FSD 8.2), so its
  // constraint violations carry meaning and map to FSD 9.4 codes.
  const translated = translateDatabaseError(error);
  if (translated) return translated;

  // Body-parser and multer limits.
  if (isErrorWithCode(error, 'entity.too.large') || isErrorWithCode(error, 'LIMIT_FILE_SIZE')) {
    return new AppError(ErrorCode.PAYLOAD_TOO_LARGE, 'That file or request is too large.', {
      cause: error,
    });
  }
  if (isErrorWithCode(error, 'entity.parse.failed')) {
    return new AppError(ErrorCode.VALIDATION_ERROR, 'The request body was not valid JSON.', {
      cause: error,
    });
  }

  return new AppError(ErrorCode.INTERNAL_ERROR, 'Something went wrong. Please try again.', {
    cause: error,
  });
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Last-resort process guards.
 *
 * FSD 11.4 targets 99.9% availability on event days. An unhandled rejection that
 * silently kills a container mid-item is exactly the failure that target is
 * about, so both are logged loudly rather than left to the default behaviour.
 */
export function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
  });
}
