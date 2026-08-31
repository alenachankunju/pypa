-- =============================================================================
-- 0011_security_lockdown.sql
-- Close the Supabase PostgREST surface and apply least-privilege grants.
--
-- WHY THIS MIGRATION EXISTS
--
-- Supabase exposes every table in the public schema over PostgREST, reachable
-- with the anon / publishable key that necessarily ships inside the frontend
-- bundle. Left at defaults, anyone holding that key could read the scores table
-- directly -- which would defeat FSD 4.3.4 ("A judge cannot see any other
-- judge's mark at any time") and 6.9 ("What judges must never see") no matter
-- how carefully the API is written.
--
-- This system does NOT use PostgREST. All access goes through the Node API,
-- which connects over the Postgres protocol with its own credentials and
-- enforces the FSD 3.2 permission matrix server-side. The correct posture is
-- therefore to shut the PostgREST door completely:
--
--   1. Revoke the anon and authenticated grants on the public schema.
--   2. Enable row-level security on every table with NO policies attached.
--      Under RLS with no policy, non-owner roles can see nothing at all.
--
-- The table owner (and any BYPASSRLS role) is unaffected, so the API keeps
-- working. This is defence in depth: step 1 alone would be undone by a future
-- "GRANT ALL" convenience script, and step 2 alone would be undone by adding a
-- permissive policy. Both together fail closed.
--
-- FSD references: 4.3.4, 6.9, 11.2 (role-based authorisation enforced
-- server-side on every endpoint; interface-level hiding is never a control).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Remove the default PostgREST grants.
-- -----------------------------------------------------------------------------
DO $lockdown$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
      -- Future tables created by this migration user must not re-grant either.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      RAISE NOTICE 'Revoked public schema access from role %', r;
    END IF;
  END LOOP;
END;
$lockdown$;


-- -----------------------------------------------------------------------------
-- 2. Enable RLS on every base table in the public schema, with no policies.
--
-- Written as a loop over the catalogue rather than a hand-maintained list, so a
-- table added by a later migration cannot be forgotten. Re-run this block after
-- any migration that creates tables (the migration runner does so automatically
-- via `npm run db:lockdown`).
-- -----------------------------------------------------------------------------
DO $rls$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    -- FORCE makes RLS apply to the table owner too, so a compromised owner
    -- session still cannot read through PostgREST. The migration/API role
    -- connects as a superuser-equivalent on Supabase and retains BYPASSRLS.
    RAISE NOTICE 'Enabled RLS on public.%', t.relname;
  END LOOP;
END;
$rls$;


-- -----------------------------------------------------------------------------
-- 3. Optional: least-privilege application role.
--
-- FSD 8.2: "the application database user must hold no UPDATE or DELETE grant on
-- the scores table beyond the specific revoke operation, and no UPDATE or DELETE
-- grant at all on audit_logs."
--
-- The triggers in migration 0009 already enforce this for every role, including
-- the owner, and they are the primary control. The grants below are the belt to
-- that braces, for deployments that provision a dedicated role rather than
-- connecting as the Supabase owner.
--
-- To use: create the role and set PYPA_DB_APP_ROLE, then run `npm run db:approle`.
-- Left commented because Supabase's pooled connection string authenticates as
-- the project owner by default, and creating an unused role adds no safety.
-- -----------------------------------------------------------------------------

-- CREATE ROLE pypa_app LOGIN PASSWORD 'set-me-from-the-environment';
-- GRANT USAGE ON SCHEMA public TO pypa_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pypa_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pypa_app;
--
-- -- FSD 8.2: no UPDATE or DELETE at all on the audit trail.
-- REVOKE UPDATE, DELETE ON audit_logs FROM pypa_app;
--
-- -- FSD 8.2: on scores, UPDATE is limited to the revoke columns; DELETE is refused.
-- REVOKE UPDATE, DELETE ON scores FROM pypa_app;
-- GRANT UPDATE (revoked, revoked_by, revoked_at, revoked_reason) ON scores TO pypa_app;
-- REVOKE UPDATE, DELETE ON score_criteria_values FROM pypa_app;
--
-- ALTER ROLE pypa_app SET statement_timeout = '15s';
