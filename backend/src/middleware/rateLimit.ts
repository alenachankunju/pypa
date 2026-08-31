/**
 * Rate limiting (FSD 11.2).
 *
 * "Rate limiting on login (10 attempts per minute per IP) and on score
 * submission (60 per minute per user)."
 *
 * The score limit is per USER rather than per IP deliberately: a venue puts
 * every judge behind one NAT address, so an IP-keyed limit of 60/min would start
 * refusing marks from a panel of three the moment scoring got busy — turning a
 * security control into an outage. Login stays IP-keyed, because there the
 * attacker is the one supplying the identity.
 */
import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env, isTest } from '../config/env.js';
import { ErrorCode } from '../utils/errors.js';
import type { ApiFailure } from '../utils/http.js';
import { clientIp } from '../utils/http.js';

function limitHandler(message: string) {
  return (_req: Request, res: Response): void => {
    const body: ApiFailure = {
      success: false,
      error: { code: ErrorCode.RATE_LIMITED, message },
      meta: { requestId: res.locals.requestId as string | undefined },
    };
    res.status(429).json(body);
  };
}

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Tests exercise the limiters explicitly; leaving them on would make every
  // other test order-dependent.
  skip: () => isTest,
};

/** FSD 11.2: 10 login attempts per minute per IP. */
export const loginRateLimit = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.RATE_LIMIT_LOGIN_PER_MIN,
  keyGenerator: (req) => clientIp(req) ?? 'unknown',
  handler: limitHandler(
    'Too many sign-in attempts from this network. Please wait a minute and try again.',
  ),
});

/** FSD 11.2: 60 score submissions per minute per user. */
export const scoreRateLimit = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.RATE_LIMIT_SCORE_PER_MIN,
  keyGenerator: (req: Request) => req.auth?.userId ?? clientIp(req) ?? 'unknown',
  handler: limitHandler(
    'You are submitting marks faster than expected. Please wait a moment and try again — nothing has been lost.',
  ),
});

/**
 * General API ceiling.
 *
 * Sized well above the live console's polling rate so an event-day admin screen
 * refreshing every couple of seconds never trips it.
 */
export const generalRateLimit = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: env.RATE_LIMIT_GENERAL_PER_MIN,
  keyGenerator: (req: Request) => req.auth?.userId ?? clientIp(req) ?? 'unknown',
  handler: limitHandler('Too many requests. Please slow down and try again shortly.'),
});

/** Tighter limit for expensive report generation (FSD 11.1: under 5 s each). */
export const reportRateLimit = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req: Request) => req.auth?.userId ?? clientIp(req) ?? 'unknown',
  handler: limitHandler('Too many report exports at once. Please wait for the current ones to finish.'),
});
