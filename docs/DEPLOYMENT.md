# Deployment Guide

## Architecture

```
Vercel (frontend)          Netlify (backend)              Supabase
┌──────────────────┐       ┌──────────────────────┐       ┌───────────────────┐
│ React PWA         │──────▶│ Express API           │──────▶│ PostgreSQL         │
│ static + SW cache │  API  │ (serverless function) │  SQL  │ Storage (photos)   │
│                   │◀──────│                       │◀──────│ Realtime (broadcast)│
└──────────────────┘ realtime──────────────────────────────▶└───────────────────┘
```

Two independent deploys, as planned. Nothing in either stack hardcodes the other's URL beyond environment variables, so either side can be redeployed, rolled back, or moved to a different host without touching the other.

## Supabase setup

1. **Create the project** (already done): `vphuozmcdwnmpxzsrdwp.supabase.co`.
2. **Database connection string** — Project Settings → Database → Connection string:
   - **Session pooler** (port 5432) for local development and running migrations. Prepared statements work; use this for `DATABASE_URL` in `backend/.env`.
   - **Transaction pooler** (port 6543) for the deployed Netlify function. Set `PGBOUNCER_TRANSACTION_MODE=true` alongside it — the pool in `backend/src/db/pool.ts` disables prepared statements when this is set.
3. **Service role key** — Project Settings → API → `service_role` secret. Needed for:
   - Storage (member photos, church logos, generated reports)
   - Realtime broadcast (the server publishes; the browser only subscribes with the anon key)
   - Never expose this key to the frontend.
4. **Storage bucket** — create a public bucket named `pypa` (or set `SUPABASE_STORAGE_BUCKET` to match). Public read is fine: photos and logos aren't sensitive; write access goes through the API only.
5. **Realtime** — enabled by default on new projects. No table replication needs enabling since this system uses *broadcast* channels, not `postgres_changes` (see `backend/src/services/realtime.ts` for why — judge privacy, FSD §4.3.4/§6.9, would be violated by streaming table changes to a client holding the publishable key).

### Running migrations

```bash
cd backend
npm run db:migrate    # applies 0001..0012 in order, tracked in schema_migrations
npm run db:status     # shows what's applied / pending / drifted
npm run db:lockdown   # re-applies migration 0011 — run again after any migration that adds a table
```

Migrations are idempotent to run once each; re-running `db:migrate` after they're all applied is a no-op. `db:lockdown` is safe to re-run any time — it's the belt-and-braces step that revokes PostgREST access and enables RLS on every table, including ones added later.

### Verifying the security lockdown

The Supabase publishable key (`sb_publishable_...`) ships inside the frontend bundle by design — Realtime subscriptions need it. That key would normally let anyone query any table directly via PostgREST. Migration `0011_security_lockdown.sql` closes that:

```bash
npm run db:lockdown
```

This should print "row-level security is enabled on every public table" with no exceptions. If a later migration adds a table and this check ever reports one missing RLS, that table is reachable by anyone holding the publishable key until you re-run `db:lockdown`.

## Backend — Netlify

1. Connect the repository, set the **base directory** to `backend/`.
2. Build command: `npm run build` (from `netlify.toml`, already configured).
3. Environment variables (Site settings → Environment variables) — copy every value from `backend/.env.example`, using the **transaction pooler** connection string:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Transaction pooler string, port 6543 |
   | `PGBOUNCER_TRANSACTION_MODE` | `true` |
   | `SUPABASE_URL` | `https://vphuozmcdwnmpxzsrdwp.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | from Supabase dashboard |
   | `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` — different value per environment |
   | `CORS_ORIGINS` | the Vercel frontend URL(s), comma-separated, **exact match** |
   | `NODE_ENV` | `production` |

4. Deploy. The function is reachable at `https://<site>.netlify.app/api/*` via the redirect in `netlify.toml`.
5. Run migrations against the **session pooler** from your machine (not from the function) before the first deploy carries traffic — see above.

### Cold starts and the FSD §11.1 latency budget

The pool in `backend/src/db/pool.ts` is cached on `globalThis`, so a warm container reuses its connections — only the first request after a cold start pays the connection cost. If p95 score-submission latency (target: under 500ms) becomes a concern under real load, the fallback is moving `backend/src/server.ts` to a small persistent host (Render, Fly, a VPS) with zero code changes — the Express app is host-agnostic by construction (see `backend/src/app.ts`).

## Frontend — Vercel

1. Connect the repository, set the **root directory** to `frontend/`.
2. Framework preset: Vite (auto-detected). Build command and output directory are set in `vercel.json`.
3. Environment variables:

   | Variable | Value |
   |---|---|
   | `VITE_API_BASE_URL` | the Netlify function URL, e.g. `https://pypa-api.netlify.app` |
   | `VITE_SUPABASE_URL` | `https://vphuozmcdwnmpxzsrdwp.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | the publishable key — safe to expose |

4. Deploy. `vercel.json` sets a CSP that only allows connecting to `*.supabase.co`/`wss://*.supabase.co` and `*.netlify.app` — update the CSP's `connect-src` if the backend moves to a different host.
5. **After the first deploy**, add the exact Vercel URL to `CORS_ORIGINS` on the Netlify side and redeploy the backend (or trigger an env-var-only redeploy).

## First-run checklist

1. `npm run db:migrate && npm run db:lockdown` against Supabase.
2. `npm run db:seed` (creates the Super Admin — the printed temporary password is shown **once**, never stored).
3. Sign in, change the password (forced — FSD ADM-01-05).
4. Follow the FSD §13 setup sequence: event settings → categories → churches → items → scoring config → members → registrations → judges → panels → sessions → badges/call sheets → snapshot → open sessions.
5. Run the readiness report (`GET /api/admin/dashboard/readiness`, or the Dashboard screen) and confirm it returns clean before event day.

## Rehearsal (FSD §14.3, §16)

*"A marking system that has not been rehearsed under realistic conditions has not been tested."* Use `npm run db:seed:demo` for a populated event that reproduces the FSD §7.5 worked example — run a full rehearsal against it (three judges on three devices, one coordinator on the live console) before trusting the system with real data.

## Backups (FSD ADM-15-02/03)

The `snapshots` table (migration `0008`) is the catalogue; the FSD's 15-minute automated backup cadence during event days is implemented as a Netlify Scheduled Function calling the snapshot service — add a `netlify/functions/scheduled-snapshot.ts` cron function (`schedule` export) once the storage-payload format for a full logical dump is finalized, or rely on Supabase's own automated Point-in-Time Recovery (enabled by default on paid tiers) as the primary backup layer and use the manual "snapshot now" action before any bulk operation in the meantime.
