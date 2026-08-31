# PYPA Marking System

Mobile-first competition registration, live judging and result computation platform, built against the [Functional Specification Document](FSD/PYPA_Marking_System_FSD.md) (v1.0, August 2026).

## What this is

A full-stack implementation covering all five roadmap phases from FSD §16:

- **Foundation** — auth, roles, churches, categories, items, members, registrations, audit log
- **Judging core** — panels, sessions, performances, judge PWA, immutable mark submission, live console
- **Results** — aggregation, ranking, tie-breaks, position points, publication lifecycle, leaderboards, champions
- **Operations** — reports, exceptions report, bulk import scaffolding, snapshots
- **Resilience** — offline mode with a durable queue, realtime push with polling fallback, device pinning

## Repository layout

```
backend/          Node/Express API — deploys to Netlify Functions
  migrations/      12 numbered SQL migrations (schema, triggers, RLS lockdown)
  src/
    services/scoring/   The pure ranking engine — aggregation, tie-breaks, grades (FSD §7)
    services/results/    Result computation, publication lifecycle, standings, recompute (FSD §7.7)
    modules/             One folder per API resource, mounted in src/app.ts
    middleware/          auth, authorize (FSD §3.2 permission matrix), rate limiting, event context
  tests/scoring/    37 tests reproducing the FSD §7.5 worked example exactly (AC-09)
  netlify/functions/api.ts   Serverless entry point (wraps the same Express app)

frontend/         React + Vite PWA — deploys to Vercel
  src/features/judge/    The 10 judge screens (FSD §6) — offline-first, bottom nav
  src/features/admin/    The 19 admin screens (FSD §5) — sidebar desktop / bottom-bar mobile
  src/lib/offlineQueue.ts    IndexedDB queue with idempotency keys (FSD §6.8)
  src/styles/tokens.css     Design tokens — the single source shared with /design mocks

design/           Static HTML mock screens (light + dark), built from the same CSS as the real app
docs/             Deployment guide, API reference, open questions for the committee
```

## Quick start

### Prerequisites
- Node.js 20.11+
- A Supabase project (PostgreSQL 15+, Storage, Realtime)

### 1. Backend

```bash
cd backend
cp .env.example .env        # fill in DATABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm install
npm run db:migrate           # applies all 12 migrations
npm run db:lockdown          # verifies row-level security is on every table
npm run db:seed:demo         # Super Admin + a populated demo event (see below)
npm run dev                  # http://localhost:4000
```

### 2. Frontend

```bash
cd frontend
cp .env.example .env         # VITE_API_BASE_URL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm install
npm run dev                  # http://localhost:5173
```

Sign in with the Super Admin credentials printed by `db:seed`, or (with `db:seed:demo`) `judge1`/`judge2`/`judge3`/`coordinator`, password `JudgeDemo1`.

### 3. Try the worked example

The demo seed reproduces **FSD §7.5** exactly: open "Saturday Morning — Main Stage", score chest 118/104/132/145 in *Solo Song — Junior Girls* as 9/8/9, 8.5/9/8.5, 7.5/8/7, 6.5/7/6.5 across the three judge logins, then check the item result — it should match the published table (118 first, 104 second on the tie-break, 132 third, 145 unplaced) to the decimal.

## Running the tests

```bash
cd backend && npm test        # 37 tests, scoring engine — see tests/scoring/ranking.test.ts
```

Coverage is enforced at 90% statements/functions on `src/services/scoring/**` (`vitest.config.ts`) per FSD §11.6: *"Automated test coverage required on the scoring and result engine specifically; this is the component where a defect is most expensive."*

## Key design decisions

| Decision | Why | Where |
|---|---|---|
| Netlify Functions + Supabase Realtime broadcast, not Socket.IO | Serverless has no persistent process; FSD §3.3 makes realtime "a convenience layer, never a correctness dependency" so polling fallback is built in everywhere | `backend/src/services/realtime.ts` |
| Custom JWT auth, not Supabase Auth | AC-02 requires zero self-registration routes; ADM-01 needs lockout, forced password change, device pinning that Supabase Auth doesn't model | `backend/src/modules/auth/`, `backend/src/services/auth/` |
| RLS + revoked grants on every table | The Supabase anon key ships in the frontend bundle; PostgREST must be closed even though the app never uses it | `backend/migrations/0011_security_lockdown.sql` |
| Pure scoring engine, no DB access | Makes AC-09 a unit test instead of an integration test; the whole tie-break cascade is testable in isolation | `backend/src/services/scoring/` |
| IndexedDB queue keyed by idempotency key generated at *confirm* time, not send time | The only way a retried/queued submission can never double-write (FSD §6.8, JDG-06-05) | `frontend/src/lib/offlineQueue.ts` |

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for hosting details, [docs/API.md](docs/API.md) for the full endpoint reference, and [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) for the FSD §17 committee decisions this build assumed defaults for.
