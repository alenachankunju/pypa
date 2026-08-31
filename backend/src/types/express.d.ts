/**
 * Express request augmentation.
 *
 * `req.auth` is populated by the authenticate middleware and is the single
 * source of identity for authorisation checks. FSD 11.2 requires role-based
 * authorisation to be "enforced server-side on every endpoint" — nothing in the
 * application reads a role from the request body or a header.
 */
import type { UserRole } from '../db/schema.js';

declare global {
  namespace Express {
    interface AuthenticatedUser {
      userId: string;
      username: string;
      fullName: string;
      role: UserRole;
      /** user_sessions.id, so a revoked session can be rejected. */
      sessionId: string;
      /** ADM-01-08: the device this token was issued to. */
      deviceId?: string;
      /** ADM-01-05: true while the issued password has not been changed. */
      mustChangePassword: boolean;
    }

    interface Request {
      auth?: AuthenticatedUser;
      /** Resolved active event, set by the event-context middleware. */
      eventId?: string;
      /** Raw body buffer, retained for upload handling. */
      rawBody?: Buffer;
    }
  }
}

export {};
