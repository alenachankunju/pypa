/**
 * Netlify Functions entry point.
 *
 * The Express app is wrapped with serverless-http rather than rewritten, so the
 * identical code path serves local development, tests and production.
 *
 * Serverless notes for this deployment (see docs/DEPLOYMENT.md):
 *
 *  - The database pool is cached on globalThis (src/db/pool.ts) so a warm
 *    container reuses connections. DATABASE_URL should point at Supabase's
 *    TRANSACTION pooler (port 6543) here, with PGBOUNCER_TRANSACTION_MODE=true.
 *
 *  - There is no persistent WebSocket. Realtime push goes through Supabase
 *    Realtime broadcast (src/services/realtime.ts), which is an HTTP call from
 *    the function. FSD 3.3 makes that layer optional by design: "If the realtime
 *    channel is unavailable the application degrades to polling."
 *
 *  - Cold starts sit against the FSD 11.1 budget of 500 ms for a score
 *    submission. Keeping the bundle small and the pool cached is what holds that.
 *
 *  - binary: true is load-bearing, not decoration. Without it, serverless-http
 *    only base64-encodes a response whose content-type matches
 *    process.env.BINARY_CONTENT_TYPES (unset here) or an explicit `binary`
 *    list — so every report/export response (PDF, Excel) was being run through
 *    Buffer.toString('utf8') and handed to Netlify as a plain string. That
 *    silently mangles any byte that isn't valid UTF-8: the file still starts
 *    with a valid "%PDF" or "PK" header (plain ASCII, survives untouched),
 *    still arrives with HTTP 200 and a plausible byte count, but every
 *    zlib-compressed content stream inside it — which is what a PDF page's
 *    actual drawn content lives in — comes out corrupted, rendering as blank
 *    pages. JSON responses are unaffected either way (valid UTF-8 round-trips
 *    losslessly through base64), so there is no downside to encoding
 *    everything through this path rather than enumerating content types.
 */
import serverless from 'serverless-http';
import { createApp } from '../../src/app.js';
import { installProcessGuards } from '../../src/middleware/errorHandler.js';

installProcessGuards();

const app = createApp();

export const handler = serverless(app, {
  // Netlify rewrites /api/* to this function; the app already mounts /api.
  basePath: '',
  binary: true,
  request(request: { rawBody?: Buffer; body?: unknown }) {
    // Retain the raw body for any future signature verification.
    if (Buffer.isBuffer(request.body)) request.rawBody = request.body;
  },
});
