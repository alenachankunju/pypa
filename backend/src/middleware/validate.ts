/**
 * Request validation.
 *
 * FSD 11.2: "All input validated and sanitised server-side; parameterised
 * queries only." Every route that accepts input runs its payload through a Zod
 * schema here, and the parsed (coerced, stripped) result replaces the raw input
 * — so a handler can never accidentally read an unvalidated field.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validate and replace body / query / params.
 *
 * Replacement rather than mere checking is the point: Zod strips unknown keys by
 * default, so a crafted request cannot smuggle an extra field (say, `role` or
 * `points`) past a handler that spreads the object into an insert.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) {
        // Express 5 makes req.query a getter; assigning to the property fails
        // silently there. Defining it keeps this working on both 4 and 5.
        const parsed = schemas.query.parse(req.query);
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (error) {
      next(error); // ZodError is translated by the error handler.
    }
  };
}

/** Typed accessor for a validated body. */
export function body<T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> {
  return req.body as z.infer<T>;
}

/** Typed accessor for a validated query. */
export function query<T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> {
  return req.query as unknown as z.infer<T>;
}
