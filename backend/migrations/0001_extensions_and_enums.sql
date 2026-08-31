-- =============================================================================
-- 0001_extensions_and_enums.sql
-- PYPA Marking System — extensions, enumerated types, shared helper functions.
--
-- FSD references:
--   §18.1 Status enumerations
--   §8    Data Model (all tables carry created_at/updated_at/created_by/updated_by)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive usernames / emails
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram search on member name (JDG-03-03)

-- -----------------------------------------------------------------------------
-- Enumerated types — FSD §18.1
--
-- These are declared as native PostgreSQL enums rather than lookup tables
-- because the value sets are fixed by the specification, not configurable by
-- the administrator. Configurable value sets (categories, position points,
-- grade bands, tie-break order) are data, per FSD §11.6.
-- -----------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM (
  'SUPER_ADMIN',
  'ADMIN',
  'JUDGE',
  'COORDINATOR'
);

CREATE TYPE registration_status AS ENUM (
  'REGISTERED',
  'WITHDRAWN'
);

CREATE TYPE performance_status AS ENUM (
  'SCHEDULED',
  'ON_STAGE',
  'IN_PROGRESS',
  'COMPLETE',
  'ABSENT',
  'VOID',
  'WITHDRAWN'
);

CREATE TYPE session_status AS ENUM (
  'DRAFT',
  'OPEN',
  'CLOSED',
  'FORCE_CLOSED'
);

CREATE TYPE item_result_state AS ENUM (
  'IN_PROGRESS',
  'READY',
  'PROVISIONAL',
  'PUBLISHED',
  'WITHHELD'
);

CREATE TYPE item_status AS ENUM (
  'ACTIVE',
  'CANCELLED'
);

CREATE TYPE aggregation_method AS ENUM (
  'AVERAGE',
  'SUM',
  'TRIMMED_MEAN',
  'WEIGHTED_AVERAGE'
);

CREATE TYPE item_type AS ENUM (
  'INDIVIDUAL',
  'GROUP'
);

-- Gender of a person. Deliberately distinct from gender_restriction, which is
-- a filter applied to items and categories and therefore admits 'ANY'.
CREATE TYPE gender AS ENUM (
  'MALE',
  'FEMALE'
);

CREATE TYPE gender_restriction AS ENUM (
  'ANY',
  'MALE',
  'FEMALE'
);

CREATE TYPE event_status AS ENUM (
  'SETUP',
  'ACTIVE',
  'FROZEN',
  'ARCHIVED'
);

CREATE TYPE import_batch_type AS ENUM (
  'CHURCHES',
  'MEMBERS'
);

CREATE TYPE import_batch_status AS ENUM (
  'PENDING_REVIEW',
  'COMMITTED',
  'DISCARDED'
);

CREATE TYPE import_row_status AS ENUM (
  'VALID',
  'INVALID',
  'COMMITTED',
  'SKIPPED'
);

-- -----------------------------------------------------------------------------
-- Shared helper: maintain updated_at on every mutable table.
-- FSD §8 — "all tables additionally carry created_at, updated_at, created_by
-- and updated_by".
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'Trigger function: stamps updated_at on every UPDATE. Attached to all mutable tables.';
