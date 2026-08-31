/**
 * Database connection pool and Kysely instance.
 *
 * Deployment note (FSD 3.4, and the Netlify Functions hosting decision):
 * serverless invocations are short-lived and can be numerous, so the pool is
 * kept small and cached on `globalThis` to survive warm-start reuse of the same
 * container. Supabase's transaction pooler (port 6543) is the right target in
 * production; it does not support prepared statements, so Kysely's plugin set
 * changes accordingly when PGBOUNCER_TRANSACTION_MODE is set.
 */
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { env, isProduction } from '../config/env.js';
import type { Database } from './schema.js';

const { Pool, types } = pg;

// ---------------------------------------------------------------------------
// Type parsers.
//
// node-postgres returns NUMERIC and BIGINT as strings to avoid precision loss.
// Every numeric column in this schema is a mark, a point total, a percentage or
// a weight — all far inside IEEE-754 exact range — and every bigint is a row
// count or an audit id. Parsing them to numbers here keeps arithmetic in the
// scoring engine honest; without it `8.5 + 9` silently becomes '8.59'.
// ---------------------------------------------------------------------------
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number.parseFloat(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number.parseInt(v, 10)));
// DATE without time: keep as the plain 'YYYY-MM-DD' string. Converting to a
// JS Date would apply the server timezone and can shift a date of birth by a
// day, which would silently move a member into the wrong category (FSD 4.2.3).
types.setTypeParser(types.builtins.DATE, (v) => v);

/**
 * Parse a PostgreSQL array literal (e.g. '{JUDGE_TOP_MARK_COUNT,HIGHEST_SINGLE_MARK}')
 * into a JS string array.
 *
 * node-postgres has no built-in decoder for arrays of CUSTOM types — it only
 * recognises the OIDs of built-in array types (int4[], text[], etc.). A
 * column typed `tiebreak_criterion[]` (migration 0007) is therefore returned
 * as the raw curly-brace string, not a JS array, and the one column that uses
 * this type (scoring_config.tiebreak_order) must be run through this before
 * the ranking engine sees it. Without it, `[criterion, ...rest] = tiebreakOrder`
 * destructures the STRING by character, every criterion silently fails to
 * match, and every tie escalates as unresolved regardless of the marks —
 * exactly the failure this function exists to prevent.
 *
 * Idempotent: an already-parsed array (e.g. in a unit test) passes through
 * unchanged, so callers don't need to know which case they're in.
 */
export function parsePgTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((s) => s.trim());
}

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

interface GlobalWithPool {
  __pypaPool?: pg.Pool;
  __pypaDb?: Kysely<Database>;
}

const globalRef = globalThis as unknown as GlobalWithPool;

function createPool(): pg.Pool {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Supabase terminates TLS with its own CA. Verification is relaxed here
    // because the connection string already pins the project host; see
    // docs/DEPLOYMENT.md for the stricter CA-bundle option.
    ssl: isProduction || env.DATABASE_URL.includes('supabase')
      ? { rejectUnauthorized: false }
      : undefined,
    // FSD 11.1 sets hard latency targets. A query that exceeds this is a defect,
    // not something to wait on — failing fast keeps the live console responsive.
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    query_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    application_name: 'pypa-marking-api',
  });

  pool.on('error', (err) => {
    // An idle client erroring is recoverable: the pool discards it. Log and
    // continue rather than crashing a live event.
    console.error('[db] idle client error', err);
  });

  return pool;
}

export const pool: pg.Pool = globalRef.__pypaPool ?? (globalRef.__pypaPool = createPool());

export const db: Kysely<Database> =
  globalRef.__pypaDb ??
  (globalRef.__pypaDb = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    log: env.LOG_LEVEL === 'trace' ? ['query', 'error'] : ['error'],
  }));

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
/** Either the pool-backed instance or an open transaction. Services accept this
 *  so they compose inside a caller's transaction without knowing about it. */
export type Executor = Db | Tx;

/** Liveness probe used by the health endpoint and the migration runner. */
export async function checkConnection(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await sql`SELECT 1`.execute(db);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function poolStats(): PoolStats {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

export async function closePool(): Promise<void> {
  await db.destroy();
  delete globalRef.__pypaDb;
  delete globalRef.__pypaPool;
}
