/**
 * Long-running Node server.
 *
 * Used for local development, and available unchanged if the backend is ever
 * moved off Netlify Functions to a persistent host (FSD 11.4 recommends an
 * on-site fallback server at the venue, which this is exactly what runs).
 */
import { createApp } from './app.js';
import { env } from './config/env.js';
import { checkConnection, closePool } from './db/pool.js';
import { installProcessGuards } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';

installProcessGuards();

const app = createApp();

const server = app.listen(env.PORT, async () => {
  const db = await checkConnection();

  logger.info(
    {
      port: env.PORT,
      environment: env.NODE_ENV,
      database: db.ok ? `connected in ${db.latencyMs} ms` : `UNAVAILABLE: ${db.error}`,
    },
    `PYPA Marking System API listening on http://localhost:${env.PORT}`,
  );

  if (!db.ok) {
    logger.error(
      'The database is unreachable. Check DATABASE_URL in backend/.env — see docs/DEPLOYMENT.md.',
    );
  }
});

/**
 * Graceful shutdown.
 *
 * In-flight score submissions must be allowed to commit: FSD 4.3 makes a
 * submitted mark immutable and irreplaceable, so dropping one mid-transaction on
 * a deploy would cost a judge a re-entry they cannot make themselves.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');

  server.close(async () => {
    await closePool();
    logger.info('shutdown complete');
    process.exit(0);
  });

  // Backstop, in case a connection refuses to close.
  setTimeout(() => {
    logger.warn('forced shutdown after 15s grace period');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
