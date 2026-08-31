/**
 * Structured application logging with correlation identifiers (FSD 11.6).
 *
 * Redaction is not cosmetic here: FSD 11.2 requires that passwords are "never
 * logged, never emailed, never returned by any API", and 6.9 forbids a judge's
 * mark reaching anywhere it should not. The redaction list below is therefore
 * part of the security posture, not a tidiness preference.
 */
import pino from 'pino';
import { env, isProduction, isTest } from '../config/env.js';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'pypa-api' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
      'req.body.temporaryPassword',
      'res.headers["set-cookie"]',
      '*.password',
      '*.password_hash',
      '*.passwordHash',
      '*.refresh_token_hash',
      '*.refreshToken',
      '*.accessToken',
      'SUPABASE_SERVICE_ROLE_KEY',
      'DATABASE_URL',
    ],
    censor: '[redacted]',
  },
  // Pretty output in development only; production emits newline-delimited JSON
  // for the platform log drain.
  transport: isProduction
    ? undefined
    : {
        target: 'pino/file',
        options: { destination: 1 },
      },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;

/** Child logger bound to a request correlation id. */
export function requestLogger(requestId: string): Logger {
  return logger.child({ requestId });
}
