-- =============================================================================
-- 0014_audit_retention.sql
-- ADM-14-05: "Retention is for the full event plus a configurable archival
-- period (default 24 months)." Previously not configurable anywhere — this
-- adds the field the purge job (services/audit.ts purgeExpiredAuditLogs) reads.
-- =============================================================================

ALTER TABLE events
  ADD COLUMN audit_retention_months integer NOT NULL DEFAULT 24;

COMMENT ON COLUMN events.audit_retention_months IS
  'ADM-14-05: months after this event''s end_date before its audit_logs rows become eligible for purge.';
