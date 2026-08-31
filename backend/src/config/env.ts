/**
 * Environment configuration, validated once at process start.
 *
 * Every value the application depends on is declared here with a type and,
 * where the FSD specifies one, its documented default (FSD 18.2). A missing or
 * malformed value fails fast with a readable message rather than surfacing as a
 * confusing runtime error on event day.
 */
import 'dotenv/config';
import { z } from 'zod';

const booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- Database -------------------------------------------------------------
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (Supabase → Settings → Database)'),
  PGBOUNCER_TRANSACTION_MODE: booleanish.default('false'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // --- Supabase (Storage + Realtime only; never auth — see FSD AC-02) -------
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('pypa'),

  // --- Auth (FSD 3.4, 5.1) --------------------------------------------------
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('pypa-marking-system'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  /** ADM-01-07 / 18.2: judges stay signed in for 12 hours so a device lock does
   *  not force a re-login mid-item. */
  REFRESH_TTL_HOURS_JUDGE: z.coerce.number().int().positive().default(12),
  /** ADM-01-07 / 18.2: admins time out after 2 hours. */
  REFRESH_TTL_HOURS_ADMIN: z.coerce.number().int().positive().default(2),
  /** ADM-01-04 / 18.2: 5 attempts, 15 minutes. */
  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  // --- Rate limits (FSD 11.2) ----------------------------------------------
  RATE_LIMIT_LOGIN_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_SCORE_PER_MIN: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_GENERAL_PER_MIN: z.coerce.number().int().positive().default(300),

  // --- CORS (FSD 11.2 strict policy) ---------------------------------------
  CORS_ORIGINS: csv.default('http://localhost:5173'),

  // --- Seeding --------------------------------------------------------------
  SEED_SUPERADMIN_USERNAME: z.string().default('superadmin'),
  SEED_SUPERADMIN_PASSWORD: z.string().optional(),
  SEED_SUPERADMIN_NAME: z.string().default('System Administrator'),

  // --- Uploads (FSD 11.2) ---------------------------------------------------
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  MAX_IMPORT_ROWS: z.coerce.number().int().positive().default(5000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // Deliberately not the logger: the logger itself depends on this config.
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  console.error('Copy backend/.env.example to backend/.env and fill in the blanks.\n');
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Supabase Storage and Realtime are optional: the system degrades to local
 *  disk for uploads and to polling for live updates (FSD 3.3, 11.4). */
export const supabaseEnabled = Boolean(
  env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY,
);
