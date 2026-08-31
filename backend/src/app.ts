/**
 * Express application factory.
 *
 * Exported as a factory rather than a module-level instance so the same app can
 * be mounted three ways without change: a long-running Node server (server.ts),
 * a serverless handler (netlify/functions/api.ts), and an in-process instance
 * for tests. That is what keeps the Netlify Functions decision reversible — the
 * hosting choice touches one file, not the application.
 */
import compression from 'compression';
import cors from 'cors';
import express, { type Express, Router } from 'express';
import helmet from 'helmet';
import { env, isProduction } from './config/env.js';
import { checkConnection, poolStats } from './db/pool.js';
import { authenticate, optionalAuthenticate, requirePasswordChanged } from './middleware/authenticate.js';
import { denyJudges } from './middleware/authorize.js';
import { blockWhenFrozen, eventContext } from './middleware/eventContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { generalRateLimit } from './middleware/rateLimit.js';
import { requestContext } from './middleware/requestContext.js';
import { realtimeAvailable } from './services/realtime.js';
import { ok } from './utils/http.js';

import { auditRoutes } from './modules/audit/audit.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { categoryRoutes } from './modules/categories/categories.routes.js';
import { churchRoutes } from './modules/churches/churches.routes.js';
import { configRoutes } from './modules/config/config.routes.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { eventRoutes } from './modules/events/events.routes.js';
import { itemRoutes } from './modules/items/items.routes.js';
import { judgeRoutes } from './modules/judge/judge.routes.js';
import { memberRoutes } from './modules/members/members.routes.js';
import { panelRoutes } from './modules/panels/panels.routes.js';
import { performanceRoutes } from './modules/performances/performances.routes.js';
import { registrationRoutes } from './modules/registrations/registrations.routes.js';
import { resultRoutes } from './modules/results/results.routes.js';
import { scoreRoutes } from './modules/scores/scores.routes.js';
import { sessionRoutes } from './modules/sessions/sessions.routes.js';
import { userRoutes } from './modules/users/users.routes.js';

/** API version, fixed from the first release (FSD 11.6). */
export const API_PREFIX = '/api';

export function createApp(): Express {
  const app = express();

  // Netlify and Vercel both terminate TLS upstream, so the client IP arrives in
  // X-Forwarded-For. Rate limiting and the audit trail both depend on it.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // --- Security headers (FSD 11.2) -----------------------------------------
  app.use(
    helmet({
      // The API serves JSON only; a restrictive CSP belongs on the frontend
      // host, which serves the documents this policy would protect.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // --- CORS (FSD 11.2 strict policy) ---------------------------------------
  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server requests carry no Origin header.
        if (!origin) return callback(null, true);
        if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error(`Origin ${origin} is not permitted by the CORS policy.`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 86_400,
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  app.use(requestContext());

  // --- Health -------------------------------------------------------------
  // Unauthenticated so the platform can probe it; the detailed body is only
  // returned to a signed-in caller.
  app.get(`${API_PREFIX}/health`, optionalAuthenticate(), async (req, res) => {
    const db = await checkConnection();
    const healthy = db.ok;

    res.status(healthy ? 200 : 503).json({
      success: healthy,
      data: {
        status: healthy ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        ...(req.auth
          ? {
              database: db,
              pool: poolStats(),
              realtime: realtimeAvailable() ? 'supabase' : 'disabled (clients poll)',
              environment: env.NODE_ENV,
            }
          : {}),
      },
    });
  });

  app.use(generalRateLimit);

  // --- Authentication (public) ---------------------------------------------
  app.use(`${API_PREFIX}/auth`, authRoutes());

  // --- Everything below requires a valid access token ----------------------
  const authed = Router();
  authed.use(authenticate());
  // ADM-01-05: a user owing a password change reaches nothing but the auth
  // routes above until they have changed it.
  authed.use(requirePasswordChanged());
  authed.use(eventContext());
  // ADM-15-07: read-only freeze blocks every state-changing route.
  authed.use(blockWhenFrozen());

  // Judge namespace (FSD 9.3). Mounted before the admin tree so a judge's
  // requests never traverse the admin guards at all.
  authed.use('/judge', judgeRoutes());

  // Administration (FSD 9.2). ADM-01-02: judges are refused here outright,
  // independently of each route's own capability guard.
  const admin = Router();
  admin.use(denyJudges());
  admin.use('/events', eventRoutes());
  admin.use('/dashboard', dashboardRoutes());
  admin.use('/users', userRoutes());
  admin.use('/churches', churchRoutes());
  admin.use('/categories', categoryRoutes());
  admin.use('/items', itemRoutes());
  admin.use('/members', memberRoutes());
  admin.use('/registrations', registrationRoutes());
  admin.use('/panels', panelRoutes());
  admin.use('/sessions', sessionRoutes());
  admin.use('/performances', performanceRoutes());
  admin.use('/scores', scoreRoutes());
  admin.use('/results', resultRoutes());
  admin.use('/config', configRoutes());
  admin.use('/audit', auditRoutes());

  authed.use('/admin', admin);
  app.use(API_PREFIX, authed);

  // --- Fallbacks -----------------------------------------------------------
  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}

/** Convenience for tests and the serverless handler. */
export const app = createApp();

export function apiRoot(): { name: string; version: string; docs: string } {
  return {
    name: 'PYPA Marking System API',
    version: '1.0.0',
    docs: '/docs/API.md',
  };
}
