/**
 * Active-event resolution and freeze mode.
 *
 * FSD 11.6 requires the system to support multiple events over time, so almost
 * every query is scoped to one. Rather than make each route carry an event id,
 * the active event is resolved once per request and cached briefly — there is
 * exactly one ACTIVE event by database constraint (migration 0002).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { db } from '../db/pool.js';
import { AppError, ErrorCode, errors } from '../utils/errors.js';

interface CachedEvent {
  id: string;
  name: string;
  freezeMode: boolean;
  freezeReason: string | null;
  ageCutoffDate: string;
  timezone: string;
  fetchedAt: number;
}

/**
 * Short-lived cache.
 *
 * Every request needs the active event, and on a serverless container the same
 * process serves many. Five seconds keeps the live console responsive to a
 * freeze being switched on without putting a query in front of every request —
 * and because freeze mode is a deliberate, announced action rather than a
 * safety interlock, a few seconds of staleness is acceptable.
 */
const CACHE_TTL_MS = 5_000;
let cache: CachedEvent | null = null;

export function invalidateEventCache(): void {
  cache = null;
}

async function loadActiveEvent(): Promise<CachedEvent | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;

  const row = await db
    .selectFrom('events')
    .select(['id', 'name', 'freeze_mode', 'freeze_reason', 'age_cutoff_date', 'timezone'])
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst();

  if (!row) {
    cache = null;
    return null;
  }

  cache = {
    id: row.id,
    name: row.name,
    freezeMode: row.freeze_mode,
    freezeReason: row.freeze_reason,
    ageCutoffDate: String(row.age_cutoff_date),
    timezone: row.timezone,
    fetchedAt: Date.now(),
  };
  return cache;
}

/** Resolve the active event onto req.eventId. Does not fail if none exists. */
export function eventContext(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = await loadActiveEvent();
      if (event) {
        req.eventId = event.id;
        res.locals.event = event;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Require an active event. Applied to every route that touches event data. */
export function requireActiveEvent(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.eventId) {
      return next(
        new AppError(
          ErrorCode.NOT_FOUND,
          'No active event is configured. A Super Admin must create and activate an event before anything else can be done (FSD 13, step 1).',
        ),
      );
    }
    next();
  };
}

/**
 * ADM-15-07: "A read-only 'freeze' mode that blocks all data changes once
 * results are final, preventing accidental edits after the event."
 *
 * Applied to every state-changing route. Read routes are unaffected, so reports
 * and result sheets remain available after the freeze — which is the point of
 * freezing rather than archiving.
 *
 * Super Admin is exempt only for the settings routes that lift the freeze; every
 * other write is blocked for every role, because "accidental edits" are exactly
 * what a privileged account is most able to make.
 */
export function blockWhenFrozen(): RequestHandler {
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!MUTATING.has(req.method)) return next();

      const event = await loadActiveEvent();
      if (!event?.freezeMode) return next();

      throw errors.eventFrozen(event.freezeReason);
    } catch (error) {
      next(error);
    }
  };
}

/** Read the resolved event from res.locals, for handlers that need its settings. */
export function activeEvent(res: Response): CachedEvent {
  const event = res.locals.event as CachedEvent | undefined;
  if (!event) {
    throw new AppError(ErrorCode.NOT_FOUND, 'No active event is configured.');
  }
  return event;
}
