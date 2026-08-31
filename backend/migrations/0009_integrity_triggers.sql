-- =============================================================================
-- 0009_integrity_triggers.sql
-- Database-level enforcement of the rules the specification refuses to leave to
-- application code.
--
-- FSD 4.3.3:  "A submitted score is immutable ... This is enforced at the
--              database level, not only in the interface."
-- FSD 8.2:    "Immutability enforced only in application code is not
--              immutability."
-- FSD ADM-14-03: the audit log is append-only.
--
-- Every RAISE below uses SQLSTATE 42501 (insufficient_privilege) or 23514
-- (check_violation) so the API layer can map them to the FSD 9.4 error codes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SCORES: immutable except for the single revoke transition. FSD 4.3.3, ADM-10-02.
--
-- ADM-10-02 defines revocation precisely: the score "retains its original value
-- and timestamp". This trigger is what makes that literally true -- mark,
-- submitted_at, judge_id and every other column are frozen at INSERT, and the
-- only permitted UPDATE is flipping revoked from false to true together with its
-- three accompanying columns.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION scores_enforce_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Scores are immutable: DELETE is not permitted on scores (FSD 4.3.3). Revoke the score instead.'
      USING ERRCODE = '42501';
  END IF;

  -- Freeze every column that is not part of the revoke transition.
  IF  NEW.id                 IS DISTINCT FROM OLD.id
   OR NEW.performance_id     IS DISTINCT FROM OLD.performance_id
   OR NEW.judge_id           IS DISTINCT FROM OLD.judge_id
   OR NEW.mark               IS DISTINCT FROM OLD.mark
   OR NEW.remarks            IS DISTINCT FROM OLD.remarks
   OR NEW.submitted_at       IS DISTINCT FROM OLD.submitted_at
   OR NEW.received_at        IS DISTINCT FROM OLD.received_at
   OR NEW.device_id          IS DISTINCT FROM OLD.device_id
   OR NEW.session_id         IS DISTINCT FROM OLD.session_id
   OR NEW.idempotency_key    IS DISTINCT FROM OLD.idempotency_key
   OR NEW.judge_weight       IS DISTINCT FROM OLD.judge_weight
   OR NEW.is_out_of_sequence IS DISTINCT FROM OLD.is_out_of_sequence
   OR NEW.entry_mode         IS DISTINCT FROM OLD.entry_mode
   OR NEW.entered_by         IS DISTINCT FROM OLD.entered_by
   OR NEW.back_entry_reason  IS DISTINCT FROM OLD.back_entry_reason
   OR NEW.created_at         IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Scores are immutable (FSD 4.3.3). Only the revoke transition may modify a score row.'
      USING ERRCODE = '42501';
  END IF;

  -- Revocation is one-way. ADM-10-02: a revoked score is never deleted and never
  -- reinstated -- the judge re-enters, creating a new row.
  IF OLD.revoked AND NOT NEW.revoked THEN
    RAISE EXCEPTION
      'A revoked score cannot be un-revoked (FSD ADM-10-02). The judge must re-enter the mark.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER scores_immutable_update
  BEFORE UPDATE ON scores
  FOR EACH ROW EXECUTE FUNCTION scores_enforce_immutability();

CREATE TRIGGER scores_immutable_delete
  BEFORE DELETE ON scores
  FOR EACH ROW EXECUTE FUNCTION scores_enforce_immutability();


-- Criterion marks inherit the immutability of their parent score (4.3.9).
CREATE OR REPLACE FUNCTION score_criteria_values_enforce_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION
    'Criterion marks are immutable (FSD 4.3.3). Revoke the parent score instead.'
    USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER score_criteria_values_immutable
  BEFORE UPDATE OR DELETE ON score_criteria_values
  FOR EACH ROW EXECUTE FUNCTION score_criteria_values_enforce_immutability();


-- -----------------------------------------------------------------------------
-- AUDIT LOG: append-only. FSD ADM-14-03.
--
-- "No user interface exists to edit or delete an entry, and the database user
-- used by the application has no DELETE or UPDATE grant on the audit table."
-- The grants are applied separately in 0011 for a dedicated application role;
-- this trigger is the enforcement that holds regardless of which role connects,
-- including the Supabase default owner.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_logs_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION
    'The audit log is append-only (FSD ADM-14-03). % is not permitted on audit_logs.', TG_OP
    USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();


-- -----------------------------------------------------------------------------
-- MEMBERS: maintain the numeric projection of the chest number.
-- Supports correct ordering (ADM-05-06 "sorting by chest number") and the
-- numeric-first judge lookup (JDG-03-01).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION members_sync_chest_numeric()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  digits text;
BEGIN
  digits := regexp_replace(NEW.chest_number::text, '[^0-9]', '', 'g');
  -- Trim to a width that cannot overflow integer; longer codes simply sort by text.
  IF digits = '' OR length(digits) > 9 THEN
    NEW.chest_number_numeric := NULL;
  ELSE
    NEW.chest_number_numeric := digits::integer;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER members_chest_numeric
  BEFORE INSERT OR UPDATE OF chest_number ON members
  FOR EACH ROW EXECUTE FUNCTION members_sync_chest_numeric();


-- -----------------------------------------------------------------------------
-- PERFORMANCES: exactly one on stage per session. ADM-09-02.
--
-- Setting a performance current automatically stands the previous one down, in
-- the same statement. Without this, "set current" would be a two-step operation
-- with a window in which judge devices could disagree about who is on stage.
-- The partial unique index performances_one_current_per_session is the backstop.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION performances_single_current()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.is_current AND NEW.session_id IS NOT NULL THEN
    -- The recursive fire of this trigger sees is_current = false and is a no-op.
    UPDATE performances
       SET is_current = false
     WHERE session_id = NEW.session_id
       AND id <> NEW.id
       AND is_current;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER performances_enforce_single_current
  BEFORE INSERT OR UPDATE OF is_current ON performances
  FOR EACH ROW WHEN (NEW.is_current)
  EXECUTE FUNCTION performances_single_current();


-- -----------------------------------------------------------------------------
-- PERFORMANCES: state machine. FSD 7.1.
--
-- The transition table below is taken directly from 7.1, with two documented
-- additions the specification implies elsewhere but does not tabulate:
--
--   SCHEDULED -> IN_PROGRESS
--     6.3 keeps manual chest-number search available "at all times ... as the
--     primary route where no coordinator is present". With no coordinator there
--     is no ON_STAGE step, so the first submitted mark must be able to move a
--     SCHEDULED performance straight to IN_PROGRESS.
--
--   SCHEDULED / ON_STAGE / IN_PROGRESS -> COMPLETE
--     ADM-08-02 permits a panel of one. With panel_size = 1 the first submission
--     both starts and completes the performance inside a single transaction.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION performances_validate_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  allowed performance_status[];
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'SCHEDULED'   THEN ARRAY['ON_STAGE','IN_PROGRESS','COMPLETE','ABSENT','WITHDRAWN','VOID']
    WHEN 'ON_STAGE'    THEN ARRAY['IN_PROGRESS','COMPLETE','ABSENT','VOID','SCHEDULED']
    WHEN 'IN_PROGRESS' THEN ARRAY['COMPLETE','VOID']
    -- COMPLETE -> IN_PROGRESS only when a score is revoked (ADM-10-03).
    WHEN 'COMPLETE'    THEN ARRAY['IN_PROGRESS','VOID']
    -- ABSENT -> SCHEDULED only if reinstated by an admin (7.1).
    WHEN 'ABSENT'      THEN ARRAY['SCHEDULED']
    WHEN 'VOID'        THEN ARRAY[]::text[]        -- terminal
    WHEN 'WITHDRAWN'   THEN ARRAY[]::text[]        -- terminal
  END::performance_status[];

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION
      'Invalid performance transition % -> % (FSD 7.1 state machine).', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER performances_transition_guard
  BEFORE UPDATE OF status ON performances
  FOR EACH ROW EXECUTE FUNCTION performances_validate_transition();


-- -----------------------------------------------------------------------------
-- ITEM CRITERIA: the criterion maxima must sum to the item maximum.
-- FSD ADM-04-06 / 4.3.9 -- criteria "sum to the maximum" and the judge's mark is
-- their sum, so a mismatch would silently cap or inflate every mark in the item.
--
-- Deferred to commit so a criteria set can be rewritten row by row inside one
-- transaction without tripping mid-edit.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION item_criteria_validate_sum()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  target_item uuid;
  criteria_total numeric(10,2);
  criteria_count integer;
  item_max numeric(6,2);
BEGIN
  target_item := COALESCE(NEW.item_id, OLD.item_id);

  SELECT COUNT(*), COALESCE(SUM(max_mark), 0)
    INTO criteria_count, criteria_total
    FROM item_criteria WHERE item_id = target_item;

  -- No criteria defined is the normal case: the item is scored as a single mark.
  IF criteria_count = 0 THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(i.max_mark, sc.max_mark)
    INTO item_max
    FROM items i
    LEFT JOIN scoring_config sc ON sc.event_id = i.event_id
   WHERE i.id = target_item;

  IF item_max IS NULL THEN
    RETURN NULL;  -- item removed in the same transaction
  END IF;

  IF criteria_total <> item_max THEN
    RAISE EXCEPTION
      'Scoring criteria for this item total % but the item maximum is % (FSD ADM-04-06). They must be equal.',
      criteria_total, item_max
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER item_criteria_sum_matches_item_max
  AFTER INSERT OR UPDATE OR DELETE ON item_criteria
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION item_criteria_validate_sum();


-- -----------------------------------------------------------------------------
-- DELETION GUARDS.
--
-- Several foreign keys already use ON DELETE RESTRICT, which would refuse these
-- deletions with a generic constraint message. These triggers fire first and
-- name the actual rule, so the administrator is told which specification rule
-- blocked them rather than which index did. FSD 11.3: "Error messages state what
-- went wrong and what to do next, in plain language."
-- -----------------------------------------------------------------------------

-- ADM-06-06: a registration cannot be removed once a score exists against its
-- performance.
CREATE OR REPLACE FUNCTION registrations_guard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  score_count integer;
BEGIN
  SELECT COUNT(*) INTO score_count
    FROM scores s
    JOIN performances p ON p.id = s.performance_id
   WHERE p.registration_id = OLD.id;

  IF score_count > 0 THEN
    RAISE EXCEPTION
      'This registration has % submitted mark(s) and cannot be deleted (FSD ADM-06-06). Withdraw it instead.',
      score_count
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$fn$;

CREATE TRIGGER registrations_delete_guard
  BEFORE DELETE ON registrations
  FOR EACH ROW EXECUTE FUNCTION registrations_guard_delete();


-- ADM-05-09: a member cannot be deleted once they have any submitted score.
-- 4.2.2: deletion is soft; the chest number remains reserved.
CREATE OR REPLACE FUNCTION members_guard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  score_count integer;
BEGIN
  SELECT COUNT(*) INTO score_count
    FROM scores s
    JOIN performances p ON p.id = s.performance_id
    JOIN registrations r ON r.id = p.registration_id
    LEFT JOIN registration_members rm ON rm.registration_id = r.id
   WHERE r.member_id = OLD.id OR rm.member_id = OLD.id;

  IF score_count > 0 THEN
    RAISE EXCEPTION
      'Member % has submitted scores and cannot be deleted (FSD ADM-05-09). Deactivate instead; the chest number stays reserved.',
      OLD.chest_number
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$fn$;

CREATE TRIGGER members_delete_guard
  BEFORE DELETE ON members
  FOR EACH ROW EXECUTE FUNCTION members_guard_delete();


-- ADM-02-03: a church cannot be deleted if it has members.
CREATE OR REPLACE FUNCTION churches_guard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  member_count integer;
BEGIN
  SELECT COUNT(*) INTO member_count FROM members WHERE church_id = OLD.id;
  IF member_count > 0 THEN
    RAISE EXCEPTION
      'Church "%" has % member(s) and cannot be deleted (FSD ADM-02-03). Deactivate it instead.',
      OLD.name, member_count
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$fn$;

CREATE TRIGGER churches_delete_guard
  BEFORE DELETE ON churches
  FOR EACH ROW EXECUTE FUNCTION churches_guard_delete();


-- ADM-04-05: an item cannot be deleted once any performance exists against it;
-- it may only be cancelled.
CREATE OR REPLACE FUNCTION items_guard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  perf_count integer;
BEGIN
  SELECT COUNT(*) INTO perf_count FROM performances WHERE item_id = OLD.id;
  IF perf_count > 0 THEN
    RAISE EXCEPTION
      'Item "%" has % performance(s) and cannot be deleted (FSD ADM-04-05). Cancel it with a reason instead.',
      OLD.name, perf_count
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$fn$;

CREATE TRIGGER items_delete_guard
  BEFORE DELETE ON items
  FOR EACH ROW EXECUTE FUNCTION items_guard_delete();


-- ADM-01-12: users are deactivated, never hard-deleted, so historical scores
-- remain attributable.
CREATE OR REPLACE FUNCTION users_guard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  score_count integer;
BEGIN
  SELECT COUNT(*) INTO score_count FROM scores WHERE judge_id = OLD.id;
  IF score_count > 0 THEN
    RAISE EXCEPTION
      'User "%" has submitted % score(s) and cannot be deleted (FSD ADM-01-12). Deactivate the account instead.',
      OLD.username, score_count
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$fn$;

CREATE TRIGGER users_delete_guard
  BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION users_guard_delete();
