/**
 * Authentication routes (FSD 9.1).
 *
 *   POST /api/auth/login            Authenticate, return access and refresh tokens
 *   POST /api/auth/refresh          Exchange refresh token
 *   POST /api/auth/logout           Invalidate session
 *   POST /api/auth/change-password  Change own password
 *   GET  /api/auth/me               Current identity and capabilities
 *
 * There is no POST /api/auth/register, and there is no password-reset route that
 * a signed-out user can reach. ADM-01-06: "'Forgot password' is not self-service.
 * An administrator resets the password and communicates it out of band."
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { loginRateLimit } from '../../middleware/rateLimit.js';
import { capabilitiesForRole } from '../../middleware/authorize.js';
import { actorFromRequest } from '../../services/audit.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { errors } from '../../utils/errors.js';
import * as authService from './auth.service.js';

const loginSchema = z.object({
  username: z.string().min(1, 'Enter your username.').max(120),
  password: z.string().min(1, 'Enter your password.').max(128),
  /** ADM-01-08: opaque client-generated device identifier. */
  deviceId: z.string().max(200).optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.').max(128),
  newPassword: z.string().min(8, 'Use at least 8 characters.').max(128),
});

export function authRoutes(): Router {
  const router = Router();

  // FSD 11.2: 10 attempts per minute per IP.
  router.post(
    '/login',
    loginRateLimit,
    validate({ body: loginSchema }),
    asyncHandler(async (req, res) => {
      const session = await authService.login(req.body as z.infer<typeof loginSchema>, req);
      return ok(res, session);
    }),
  );

  router.post(
    '/refresh',
    validate({ body: refreshSchema }),
    asyncHandler(async (req, res) => {
      const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
      const session = await authService.refresh(refreshToken, req);
      return ok(res, session);
    }),
  );

  // Reachable while must_change_password is set — a user has to be able to sign
  // out of an account they cannot otherwise use.
  router.post(
    '/logout',
    authenticate(),
    asyncHandler(async (req, res) => {
      if (!req.auth) throw errors.unauthenticated();
      await authService.logout(req.auth.sessionId, actorFromRequest(req));
      return ok(res, { signedOut: true });
    }),
  );

  // ADM-01-05: also reachable while must_change_password is set; it is the one
  // action such a user is expected to take.
  router.post(
    '/change-password',
    authenticate(),
    validate({ body: changePasswordSchema }),
    asyncHandler(async (req, res) => {
      if (!req.auth) throw errors.unauthenticated();
      const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;

      await authService.changeOwnPassword(
        req.auth.userId,
        currentPassword,
        newPassword,
        req.auth.sessionId,
        actorFromRequest(req),
      );

      return ok(res, {
        changed: true,
        message: 'Your password has been changed. Other devices have been signed out.',
      });
    }),
  );

  /**
   * Current identity, capabilities and session policy.
   *
   * The client uses `capabilities` to decide which navigation to render. FSD 3.2
   * is clear that this is a convenience only — "the user interface hides
   * unavailable actions but the server must enforce them independently" — so
   * every route still carries its own guard.
   */
  router.get(
    '/me',
    authenticate(),
    asyncHandler(async (req, res) => {
      if (!req.auth) throw errors.unauthenticated();

      return ok(res, {
        id: req.auth.userId,
        username: req.auth.username,
        fullName: req.auth.fullName,
        role: req.auth.role,
        mustChangePassword: req.auth.mustChangePassword,
        capabilities: capabilitiesForRole(req.auth.role),
        sessionTtlHours: authService.sessionTtlHours(req.auth.role),
      });
    }),
  );

  return router;
}
