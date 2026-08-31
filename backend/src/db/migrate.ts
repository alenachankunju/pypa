/**
 * Migration runner.
 *
 * Applies the numbered SQL files in backend/migrations in filename order,
 * recording each in a schema_migrations table with the SHA-256 of its contents.
 * A file that changes after it has been applied is reported as drift and the run
 * stops: on a system of record, silently diverging schema history is the kind of
 * defect that only surfaces on event day.
 *
 * Usage:
 *   npm run db:migrate     # apply pending migrations
 *   npm run db:status      # show applied / pending
 *   npm run db:lockdown    # re-run the RLS + grant lockdown (0011)
 *   npm run db:reset       # DROP the public schema and rebuild (dev only)
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env, isProduction } from '../config/env.js';

const { Client } = pg;

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL('../../migrations', import.meta.url)));

interface MigrationFile {
  name: string;
  fullPath: string;
  sql: string;
  checksum: string;
}

interface AppliedRow {
  name: string;
  checksum: string;
  applied_at: Date;
}

async function connect(): Promise<pg.Client> {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : undefined,
    application_name: 'pypa-migrate',
    // Migrations create indexes and can legitimately run longer than a request.
    statement_timeout: 300_000,
  });
  await client.connect();
  return client;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();

  return Promise.all(
    files.map(async (name) => {
      const fullPath = path.join(MIGRATIONS_DIR, name);
      const sql = await readFile(fullPath, 'utf8');
      return {
        name,
        fullPath,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

async function ensureMigrationTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer
    )
  `);
}

async function getApplied(client: pg.Client): Promise<Map<string, AppliedRow>> {
  const { rows } = await client.query<AppliedRow>(
    'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
  );
  return new Map(rows.map((r) => [r.name, r]));
}

async function up(): Promise<void> {
  const client = await connect();
  try {
    await ensureMigrationTable(client);
    const [files, applied] = await Promise.all([loadMigrations(), getApplied(client)]);

    // Drift check before applying anything.
    const drifted = files.filter((f) => {
      const prior = applied.get(f.name);
      return prior && prior.checksum !== f.checksum;
    });
    if (drifted.length > 0) {
      console.error('\nMigration drift detected — these files changed after being applied:\n');
      for (const f of drifted) console.error(`  - ${f.name}`);
      console.error(
        '\nApplied migrations are immutable. Add a new numbered migration with the change instead.\n',
      );
      process.exitCode = 1;
      return;
    }

    const pending = files.filter((f) => !applied.has(f.name));
    if (pending.length === 0) {
      console.log('Database is up to date — no pending migrations.');
      return;
    }

    console.log(`Applying ${pending.length} migration(s)...\n`);
    for (const file of pending) {
      const started = Date.now();
      process.stdout.write(`  ${file.name} ... `);
      try {
        // Each migration is one transaction: it applies completely or not at all.
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
          [file.name, file.checksum, Date.now() - started],
        );
        await client.query('COMMIT');
        console.log(`done (${Date.now() - started} ms)`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
        return;
      }
    }
    console.log('\nAll migrations applied.');
  } finally {
    await client.end();
  }
}

async function status(): Promise<void> {
  const client = await connect();
  try {
    await ensureMigrationTable(client);
    const [files, applied] = await Promise.all([loadMigrations(), getApplied(client)]);

    console.log('\nMigration status\n');
    for (const f of files) {
      const prior = applied.get(f.name);
      if (!prior) {
        console.log(`  PENDING   ${f.name}`);
      } else if (prior.checksum !== f.checksum) {
        console.log(`  DRIFTED   ${f.name}  (file changed since it was applied)`);
      } else {
        console.log(`  applied   ${f.name}  ${prior.applied_at.toISOString()}`);
      }
    }

    const orphans = [...applied.keys()].filter((n) => !files.some((f) => f.name === n));
    for (const o of orphans) console.log(`  ORPHAN    ${o}  (recorded but file is missing)`);
    console.log('');
  } finally {
    await client.end();
  }
}

/**
 * Re-run the security lockdown (migration 0011).
 *
 * Safe and idempotent, and worth running after any migration that adds a table:
 * a new table is created without RLS, which would reopen it to the Supabase
 * PostgREST surface that ships the publishable key to every browser.
 */
async function lockdown(): Promise<void> {
  const client = await connect();
  try {
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0011_security_lockdown.sql'), 'utf8');
    await client.query(sql);
    const { rows } = await client.query<{ relname: string }>(`
      SELECT c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
       ORDER BY c.relname
    `);
    if (rows.length > 0) {
      console.error('\nTables still WITHOUT row-level security:');
      for (const r of rows) console.error(`  - ${r.relname}`);
      process.exitCode = 1;
    } else {
      console.log('Lockdown applied: row-level security is enabled on every public table.');
    }
  } finally {
    await client.end();
  }
}

/** Destructive. Development only — refuses to run against NODE_ENV=production. */
async function reset(): Promise<void> {
  if (isProduction) {
    console.error('Refusing to reset the database with NODE_ENV=production.');
    process.exitCode = 1;
    return;
  }
  if (process.argv[3] !== '--yes') {
    console.error(
      '\nThis DROPS the entire public schema and every row in it.\n' +
        'Re-run as:  npm run db:reset -- --yes\n',
    );
    process.exitCode = 1;
    return;
  }
  const client = await connect();
  try {
    console.log('Dropping public schema...');
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('Schema dropped.');
  } finally {
    await client.end();
  }
  await up();
}

const command = process.argv[2] ?? 'up';
const commands: Record<string, () => Promise<void>> = { up, status, lockdown, reset };

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command "${command}". Expected one of: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

handler().catch((error) => {
  console.error(error);
  process.exit(1);
});
