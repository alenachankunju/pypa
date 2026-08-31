-- =============================================================================
-- 0006_performances_and_scores.sql
-- The scoring core: performances, the panel snapshot, scores, criterion marks.
--
-- This migration carries three of the four critical constraints named in
-- FSD 8.2. It is the most integrity-sensitive file in the schema.
--
-- FSD references:
--   4.1  The Performance concept
--   4.3  Scoring rules
--   5.9  Live judging console (ADM-09-01 .. ADM-09-09)
--   5.10 Score exception handling (ADM-10-01 .. ADM-10-05)
--   6.6  Confirmation and submission (JDG-06-04, JDG-06-05)
--   7.1  Performance state machine
--   7.2  Multi-judge concurrency
--   8.2  Critical constraints
--   11.4 Paper contingency back-entry
-- =============================================================================

-- How a score reached the system. FSD 11.4 requires marks captured on paper to
-- be entered afterwards through a dedicated back-entry screen that records who
-- entered them and why -- so provenance must be a first-class column, not a note.
CREATE TYPE score_entry_mode AS ENUM (
  'JUDGE_DEVICE',
  'JUDGE_OFFLINE_SYNC',
  'ADMIN_BACK_ENTRY'
);

-- -----------------------------------------------------------------------------
-- performances -- one registration presented once on stage. FSD 4.1.
--
-- This is the atomic unit judges score against, and the single design decision
-- that solves simultaneous entry, completion detection, re-performance, absence,
-- team items and wrong-item submission (4.1 table).
-- -----------------------------------------------------------------------------
CREATE TABLE performances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  registration_id uuid NOT NULL REFERENCES registrations(id) ON DELETE RESTRICT,

  -- Denormalised from the registration. The item is carried on the performance
  -- so that a wrong-item submission is detectable and blockable at submission
  -- time (4.1, JDG-04-04) without an extra join on the hot path.
  item_id         uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,

  session_id      uuid REFERENCES sessions(id) ON DELETE RESTRICT,

  -- ADM-09-07: a voided performance is retained and a new one created for the
  -- re-run. attempt_no distinguishes them.
  attempt_no      integer NOT NULL DEFAULT 1,

  -- FSD 7.2: "The panel size is copied onto the performance at the moment it is
  -- created, rather than being read live from the panel. This is deliberate: if
  -- a judge is swapped mid-session, performances already in progress keep the
  -- target they started with, and the result sheet remains explainable."
  panel_size      integer NOT NULL,

  status          performance_status NOT NULL DEFAULT 'SCHEDULED',

  -- FSD 7.3: aggregate values are STORED, not computed on demand, so that a
  -- later configuration change cannot silently alter a historical result.
  aggregate_score numeric(8,3),
  aggregate_method_used aggregation_method,

  -- ADM-09-02: the one performance currently on stage for its session.
  is_current      boolean NOT NULL DEFAULT false,
  on_stage_at     timestamptz,

  started_at      timestamptz,
  completed_at    timestamptz,

  -- ADM-09-06 / ADM-09-07: statuses that require an operator explanation.
  absent_note     text,
  void_reason     text,
  voided_by       uuid REFERENCES users(id),
  voided_at       timestamptz,

  -- ADM-06-07: order in which participants are called to the stage.
  call_order      integer,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  updated_by      uuid REFERENCES users(id),

  CONSTRAINT performances_panel_size_positive CHECK (panel_size >= 1),
  CONSTRAINT performances_attempt_positive    CHECK (attempt_no >= 1),
  -- ADM-09-07: voiding always carries a mandatory reason.
  CONSTRAINT performances_void_has_reason CHECK (
    status <> 'VOID' OR void_reason IS NOT NULL
  ),
  -- 7.1: only a COMPLETE performance may carry an aggregate.
  CONSTRAINT performances_aggregate_only_when_complete CHECK (
    aggregate_score IS NULL OR status = 'COMPLETE'
  )
);

-- FSD 8.1: UNIQUE(registration_id, attempt_no).
CREATE UNIQUE INDEX performances_registration_attempt_key
  ON performances (registration_id, attempt_no);

-- ADM-09-02: at most one performance is on stage per session at any moment.
-- This makes "set current" atomic and removes the possibility of two judges
-- following different participants.
CREATE UNIQUE INDEX performances_one_current_per_session
  ON performances (session_id)
  WHERE is_current AND session_id IS NOT NULL;

CREATE INDEX performances_item_status_idx    ON performances (item_id, status);
CREATE INDEX performances_session_status_idx ON performances (session_id, status);
CREATE INDEX performances_event_idx          ON performances (event_id);
CREATE INDEX performances_call_order_idx     ON performances (session_id, item_id, call_order);
-- Hot path for the outstanding-marks panel (ADM-09-08).
CREATE INDEX performances_incomplete_idx
  ON performances (session_id, item_id)
  WHERE status IN ('SCHEDULED', 'ON_STAGE', 'IN_PROGRESS');

CREATE TRIGGER performances_set_updated_at
  BEFORE UPDATE ON performances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN performances.panel_size IS
  'FSD 7.2: snapshot of the completion target at creation time. Never read live from the panel.';


-- -----------------------------------------------------------------------------
-- performance_judges -- snapshot of the panel expected to score a performance.
--
-- ADM-09-08 requires the outstanding-marks panel to NAME the judges who have not
-- submitted -- "the single most important operational feature in the system".
-- Deriving that from current panel membership would misreport any performance
-- created before a mid-session panel change (ADM-08-06). The expected panel is
-- therefore snapshotted alongside panel_size.
-- -----------------------------------------------------------------------------
CREATE TABLE performance_judges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  performance_id uuid NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  judge_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Snapshot of panel_judges.weight, so a later weight change cannot alter a
  -- historical WEIGHTED_AVERAGE aggregate (4.4).
  weight         numeric(6,3) NOT NULL DEFAULT 1.0,
  is_chief       boolean NOT NULL DEFAULT false,

  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX performance_judges_perf_judge_key
  ON performance_judges (performance_id, judge_id);
CREATE INDEX performance_judges_judge_idx ON performance_judges (judge_id);


-- -----------------------------------------------------------------------------
-- scores -- one judge's mark for one performance. FSD 4.3, 8.1, 8.2.
--
-- IMMUTABILITY (4.3.3): "A submitted score is immutable. A judge cannot edit or
-- delete it. This is enforced at the database level, not only in the interface."
-- The trigger in migration 0009 rejects every UPDATE except the specific revoke
-- transition, and rejects every DELETE unconditionally.
-- -----------------------------------------------------------------------------
CREATE TABLE scores (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  performance_id  uuid NOT NULL REFERENCES performances(id) ON DELETE RESTRICT,
  judge_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- 4.3.1: 0 to the configured maximum, to a configured number of decimal
  -- places. The upper bound is item-dependent so it is validated in the service
  -- layer against the item maximum; the floor is absolute and enforced here.
  mark            numeric(6,2) NOT NULL,

  -- JDG-05-05: administrator-visible only, never affects the calculation.
  remarks         text,

  -- JDG-08-06: "The recorded time of a score is the client submission time
  -- carried in the payload, not the server receipt time, so that an offline
  -- queue does not distort the audit trail." Both are kept -- submitted_at is
  -- authoritative for the trail, received_at for operational forensics.
  submitted_at    timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),

  -- ADM-14-02: score submissions are logged with the device and session id.
  device_id       text,
  session_id      uuid REFERENCES sessions(id) ON DELETE SET NULL,

  -- JDG-06-05: the idempotency key guarantees a retried request cannot create a
  -- second score row; the server returns the original result for a repeated key.
  idempotency_key text NOT NULL,

  -- Snapshot of the judge weight in force at submission (4.4 WEIGHTED_AVERAGE).
  judge_weight    numeric(6,3) NOT NULL DEFAULT 1.0,

  -- 12.1: a judge who scores an item that is not the one on stage may proceed
  -- after acknowledging the warning, but the score is flagged for review.
  is_out_of_sequence boolean NOT NULL DEFAULT false,

  -- 11.4: provenance for paper back-entry.
  entry_mode        score_entry_mode NOT NULL DEFAULT 'JUDGE_DEVICE',
  entered_by        uuid REFERENCES users(id),
  back_entry_reason text,

  -- ADM-10-01/02: revocation flags the row; it is never deleted, retains its
  -- original value and timestamp, and is excluded from all calculations.
  revoked         boolean NOT NULL DEFAULT false,
  revoked_by      uuid REFERENCES users(id),
  revoked_at      timestamptz,
  revoked_reason  text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scores_mark_non_negative CHECK (mark >= 0),
  CONSTRAINT scores_weight_positive   CHECK (judge_weight > 0),
  -- ADM-10-01: a mandatory free-text reason of at least 15 characters.
  CONSTRAINT scores_revoked_shape CHECK (
    NOT revoked
    OR (revoked_at IS NOT NULL
        AND revoked_by IS NOT NULL
        AND length(btrim(revoked_reason)) >= 15)
  ),
  CONSTRAINT scores_back_entry_shape CHECK (
    entry_mode <> 'ADMIN_BACK_ENTRY'
    OR (entered_by IS NOT NULL AND back_entry_reason IS NOT NULL)
  )
);

-- ---------------------------------------------------------------------------
-- FSD 8.2 critical constraint #1: UNIQUE (performance_id, judge_id) on scores.
-- Prevents "a judge scoring the same performance twice, including via a double
-- tap or a network retry" (8.2) and satisfies 7.2.2 -- two simultaneous requests
-- from the same judge cannot both succeed; the second is rejected by the
-- DATABASE, not by application logic that might have a race condition.
--
-- The index is PARTIAL on revoked = false, and that is required rather than
-- incidental. ADM-10-03 states that after a revocation "the judge's device shows
-- the performance as awaiting their mark again". A total unique index would make
-- that re-entry physically impossible, because the revoked row still occupies
-- the (performance_id, judge_id) slot. Restricting uniqueness to live rows
-- expresses the actual rule -- a judge has exactly one VALID score per
-- performance (4.3.2) -- while retaining every revoked row for the audit trail.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX scores_performance_judge_key
  ON scores (performance_id, judge_id)
  WHERE NOT revoked;

-- FSD 8.2 critical constraint #2: UNIQUE (idempotency_key) on scores.
-- Prevents "a queued offline submission being written twice on reconnection"
-- (8.2, JDG-08-03/05).
CREATE UNIQUE INDEX scores_idempotency_key ON scores (idempotency_key);

CREATE INDEX scores_performance_idx ON scores (performance_id) WHERE NOT revoked;
CREATE INDEX scores_judge_idx       ON scores (judge_id, submitted_at DESC);
CREATE INDEX scores_session_idx     ON scores (session_id);
CREATE INDEX scores_revoked_idx     ON scores (revoked) WHERE revoked;

COMMENT ON TABLE scores IS
  'FSD 4.3.3: immutable once written. UPDATE is restricted to the revoke transition and DELETE is refused, both by trigger (migration 0009).';
COMMENT ON INDEX scores_performance_judge_key IS
  'FSD 8.2 constraint. Partial on NOT revoked so ADM-10-03 re-entry after revocation remains possible.';


-- -----------------------------------------------------------------------------
-- score_criteria_values -- per-criterion marks where an item defines criteria.
-- FSD 4.3.9, ADM-04-06, JDG-05-04. The judge's mark is the sum of these.
-- -----------------------------------------------------------------------------
CREATE TABLE score_criteria_values (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  score_id        uuid NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  item_criteria_id uuid NOT NULL REFERENCES item_criteria(id) ON DELETE RESTRICT,
  mark            numeric(6,2) NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT score_criteria_values_non_negative CHECK (mark >= 0)
);

CREATE UNIQUE INDEX score_criteria_values_score_criterion_key
  ON score_criteria_values (score_id, item_criteria_id);
CREATE INDEX score_criteria_values_score_idx ON score_criteria_values (score_id);
