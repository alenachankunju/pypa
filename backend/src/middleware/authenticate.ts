/**
 * Authentication middleware.
 *
 * Verifies the bearer access token and populates req.auth. The access token is a
 * signed JWT verified without a database round trip (FSD 11.1 latency budget),
 * so revocation is bounded by ACCESS_TOKEN_TTL_MINUTES — the refresh path is
 * where ADM-07-05 force logout takes effect.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { db } from '../db/pool.js';
import { bearerFromHeader, verifyAccessToken } from '../services/auth/tokens.js';
import { AppError, ErrorCode, errors } from '../utils/errors.js';

/**
 * Require a valid access token.
 *
 * FSD ADM-01-05: a user who still owes a password change is authenticated but
 * may reach only the change-password and logout routes. That is enforced here by
 * carrying mustChangePassword through to req.auth, and by the requirePasswordChanged
 * guard below which is applied to every other route.
 */
export function authenticate(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw errors.unauthenticated();

      const claims = await verifyAccessToken(token);

      req.auth = {
        userId: claims.sub,
        username: claims.username,
        fullName: claims.name,
        role: claims.role,
        sessionId: claims.sid,
        deviceId: claims.did,
        mustChangePassword: claims.mcp === true,
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Optional authentication — populates req.auth where a token is present but does
 * not reject where it is absent. Used by the health endpoint so an operator can
 * see richer diagnostics while signed in.
 */
export function optionalAuthenticate(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = bearerFromHeader(req.headers.authorization);
    if (!token) return next();
    try {
      const claims = await verifyAccessToken(token);
      req.auth = {
        userId: claims.sub,
        username: claims.username,
        fullName: claims.name,
        role: claims.role,
        sessionId: claims.sid,
        deviceId: claims.did,
        mustChangePassword: claims.mcp === true,
      };
    } catch {
      // Ignore: this route does not require identity.
    }
    next();
  };
}

/**
 * ADM-01-05: "On first login a user must change the password issued to them."
 *
 * Applied globally after authenticate(), with the change-password and logout
 * routes exempted. Without this, a judge could be handed a temporary password
 * and go on scoring with it all day.
 */
export function requirePasswordChanged(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.auth?.mustChangePassword) {
      return next(
        new AppError(
          ErrorCode.MUST_CHANGE_PASSWORD,
          'You must change your password before continuing.',
        ),
      );
    }
    next();
  };
}

/**
 * Verify the session behind the token has not been revoked.
 *
 * Deliberately NOT applied to every request: that would put a database round
 * trip in front of every score submission and spend the FSD 11.1 budget on
 * something the short access-token TTL already bounds. It is applied to the
 * refresh endpoint and to high-consequence admin actions (publication,
 * revocation, configuration), where an extra query is affordable and a
 * force-logged-out account must stop working immediately.
 */
export function requireLiveSession(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.auth) throw errors.unauthenticated();

      const session = await db
        .selectFrom('user_sessions')
        .select(['id', 'revoked_at', 'expires_at'])
        .where('id', '=', req.auth.sessionId)
        .executeTakeFirst();

      if (!session) {
        throw new AppError(ErrorCode.SESSION_REVOKED, 'Your session has ended. Please sign in again.');
      }
      if (session.revoked_at) {
        throw new AppError(
          ErrorCode.SESSION_REVOKED,
          'Your session was ended by an administrator. Please sign in again.',
        );
      }
      if (session.expires_at.getTime() < Date.now()) {
        throw new AppError(ErrorCode.TOKEN_EXPIRED, 'Your session has expired. Please sign in again.');
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
