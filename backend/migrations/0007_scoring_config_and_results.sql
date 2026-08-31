-- =============================================================================
-- 0007_scoring_config_and_results.sql
-- Scoring configuration, position points, grade bands, computed results,
-- the publication lifecycle, manual tie decisions and recomputation history.
--
-- FSD references:
--   4.4  Aggregation rules
--   4.5  Ranking and tie-break rules
--   4.6  Shared positions
--   4.7  Points and championship rules
--   4.8  Result lifecycle
--   5.11 Scoring configuration (ADM-11-01 .. ADM-11-09)
--   5.12 Results and publication (ADM-12-01 .. ADM-12-09)
--   7.4  Item ranking algorithm
--   7.7  Recomputation
-- =============================================================================

-- FSD 4.5: the tie-break sequence, applied in configurable order until the tie
-- is broken. UNRESOLVED is the terminal criterion -- reaching it escalates to
-- the administrator rather than guessing. "Silent tie-breaking is prohibited."
CREATE TYPE tiebreak_criterion AS ENUM (
  'JUDGE_TOP_MARK_COUNT',  -- 4.5.1 count of judges who gave their own item-high here
  'HIGHEST_SINGLE_MARK',   -- 4.5.2 highest individual mark from any single judge
  'LOWEST_SPREAD',         -- 4.5.3 smallest max-min spread, i.e. strongest consensus
  'CHIEF_JUDGE_MARK'       -- 4.5.4 the designated chief judge's mark
);

-- -----------------------------------------------------------------------------
-- scoring_config -- event-wide scoring rules. Exactly one row per event.
--
-- ADM-11-09: locked once the first result is published. Changing it afterwards
-- requires a Super Admin action that unpublishes every result and forces full
-- recomputation. Attempts to write while locked return CONFIG_LOCKED (9.4).
-- -----------------------------------------------------------------------------
CREATE TABLE scoring_config (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                  uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- 18.2 defaults
  max_mark                  numeric(6,2) NOT NULL DEFAULT 10,
  decimal_places            integer NOT NULL DEFAULT 1,
  aggregation_method        aggregation_method NOT NULL DEFAULT 'AVERAGE',

  -- 4.6 / Q6: default is that shared positions are NOT permitted.
  allow_shared_positions    boolean NOT NULL DEFAULT false,

  -- ADM-11-06: order is configurable by drag and drop; stored as an ordered array.
  tiebreak_order            tiebreak_criterion[] NOT NULL
                              DEFAULT ARRAY[
                                'JUDGE_TOP_MARK_COUNT',
                                'HIGHEST_SINGLE_MARK',
                                'LOWEST_SPREAD',
                                'CHIEF_JUDGE_MARK'
                              ]::tiebreak_criterion[],

  -- 4.7.3 / Q8: grades displayed, grade points disabled by default.
  grade_points_enabled      boolean NOT NULL DEFAULT false,

  -- 4.7.8 / Q14: minimum items for individual champion eligibility.
  min_items_for_champion    integer NOT NULL DEFAULT 2,

  -- 4.7.7 / ADM-11-08
  compute_category_champions boolean NOT NULL DEFAULT true,

  -- 4.2.7 / Q10: maximum items per member. NULL means unlimited.
  max_items_per_member      integer DEFAULT 4,

  -- 12.1: an item with only one participant is ranked first if a minimum-score
  -- threshold is met, or awarded no position where a walkover rule is set.
  -- NULL disables the walkover rule.
  walkover_min_aggregate    numeric(8,3),

  -- JDG-04-03: whether items outside the judge's session are hidden or greyed.
  -- Default is greyed, "because it helps the judge confirm they have the right
  -- person".
  show_out_of_session_items boolean NOT NULL DEFAULT true,

  -- ADM-11-09
  locked                    boolean NOT NULL DEFAULT false,
  locked_at                 timestamptz,
  locked_by                 uuid REFERENCES users(id),

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid REFERENCES users(id),
  updated_by                uuid REFERENCES users(id),

  CONSTRAINT scoring_config_max_mark_positive CHECK (max_mark > 0),
  CONSTRAINT scoring_config_decimals_sane     CHECK (decimal_places BETWEEN 0 AND 3),
  CONSTRAINT scoring_config_min_items_sane    CHECK (min_items_for_champion >= 0),
  CONSTRAINT scoring_config_tiebreak_not_empty
    CHECK (array_length(tiebreak_order, 1) IS NOT NULL)
);

CREATE UNIQUE INDEX scoring_config_event_key ON scoring_config (event_id);

CREATE TRIGGER scoring_config_set_updated_at
  BEFORE UPDATE ON scoring_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- position_points -- points awarded per finishing position. FSD 4.7.1, ADM-11-03.
--
-- item_id NULL is the event-wide default (18.2: 1st = 5, 2nd = 3, 3rd = 1).
-- A row with item_id set is a per-item override (ADM-11-04), so that group items
-- can be worth more than solo items.
-- ADM-11-03: the interface accepts ANY number of positions, not only three.
-- -----------------------------------------------------------------------------
CREATE TABLE position_points (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  item_id    uuid REFERENCES items(id) ON DELETE CASCADE,
  position   integer NOT NULL,
  points     numeric(8,3) NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),

  CONSTRAINT position_points_position_positive CHECK (position >= 1),
  CONSTRAINT position_points_points_non_negative CHECK (points >= 0)
);

-- Two partial indexes rather than one with NULLS NOT DISTINCT, so the schema
-- does not depend on the PostgreSQL 15 nulls-distinct syntax.
CREATE UNIQUE INDEX position_points_default_key
  ON position_points (event_id, position) WHERE item_id IS NULL;
CREATE UNIQUE INDEX position_points_item_key
  ON position_points (item_id, position) WHERE item_id IS NOT NULL;

CREATE TRIGGER position_points_set_updated_at
  BEFORE UPDATE ON position_points
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- grade_bands -- optional quality band derived from aggregate percentage.
-- FSD 4.7.3, ADM-11-07. Defaults (18.2): A >= 80%, B >= 60%, C >= 40%.
-- Grade is independent of position (glossary).
-- -----------------------------------------------------------------------------
CREATE TABLE grade_bands (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  grade          text NOT NULL,
  min_percentage numeric(6,2) NOT NULL,
  points         numeric(8,3) NOT NULL DEFAULT 0,
  display_order  integer NOT NULL DEFAULT 0,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  updated_by     uuid REFERENCES users(id),

  CONSTRAINT grade_bands_pct_range CHECK (min_percentage >= 0 AND min_percentage <= 100),
  CONSTRAINT grade_bands_points_non_negative CHECK (points >= 0)
);

CREATE UNIQUE INDEX grade_bands_event_grade_key ON grade_bands (event_id, upper(grade));
CREATE INDEX grade_bands_event_threshold_idx    ON grade_bands (event_id, min_percentage DESC);

CREATE TRIGGER grade_bands_set_updated_at
  BEFORE UPDATE ON grade_bands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- item_publications -- result lifecycle per item. FSD 4.8, 8.1.
--
-- States: IN_PROGRESS -> READY -> PROVISIONAL -> PUBLISHED, with WITHHELD as a
-- freeze pending dispute. ADM-12-03: only a Super Admin may publish.
-- ADM-12-05: unpublish requires a mandatory reason and triggers recomputation.
-- -----------------------------------------------------------------------------
CREATE TABLE item_publications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  item_id           uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  state             item_result_state NOT NULL DEFAULT 'IN_PROGRESS',

  -- ADM-12-02: an item containing an unresolved tie cannot progress to
  -- Provisional. Surfaced as a flag so the admin console can badge the item.
  has_unresolved_tie boolean NOT NULL DEFAULT false,

  published_by      uuid REFERENCES users(id),
  published_at      timestamptz,
  unpublished_by    uuid REFERENCES users(id),
  unpublished_at    timestamptz,
  unpublish_reason  text,
  withheld_reason   text,

  last_computed_at  timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  updated_by        uuid REFERENCES users(id),

  CONSTRAINT item_publications_published_shape CHECK (
    state <> 'PUBLISHED' OR (published_by IS NOT NULL AND published_at IS NOT NULL)
  ),
  CONSTRAINT item_publications_withheld_shape CHECK (
    state <> 'WITHHELD' OR withheld_reason IS NOT NULL
  )
);

CREATE UNIQUE INDEX item_publications_item_key ON item_publications (item_id);
CREATE INDEX item_publications_event_state_idx ON item_publications (event_id, state);

CREATE TRIGGER item_publications_set_updated_at
  BEFORE UPDATE ON item_publications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- item_results -- the computed ranking rows. FSD 7.4, 8.1, ADM-12-01.
--
-- Regenerated wholesale by the result engine on every recomputation for the
-- item. Rows exist for non-ranked performances too (ABSENT, VOID, WITHDRAWN):
-- FSD 7.1 requires them to "appear on the result sheet with their status but
-- receive no position and no points", so the result sheet is complete rather
-- than silently short.
-- -----------------------------------------------------------------------------
CREATE TABLE item_results (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  item_id            uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  performance_id     uuid NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  registration_id    uuid NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,

  -- Denormalised for reporting speed and for permanence: church attribution must
  -- not drift if master data is later edited.
  church_id          uuid REFERENCES churches(id) ON DELETE SET NULL,

  -- NULL for a performance that received no position (ABSENT / VOID / WITHDRAWN,
  -- or an unplaced finisher below the configured positions).
  position           integer,
  aggregate_score    numeric(8,3),
  grade              text,
  points             numeric(8,3) NOT NULL DEFAULT 0,

  -- 4.6: two participants tied for first are both awarded first place.
  is_shared_position boolean NOT NULL DEFAULT false,

  -- 7.4: which criterion separated this performance from its tie group, if any.
  tie_break_applied  tiebreak_criterion,
  tie_break_note     text,
  -- Set where an administrator resolved the tie by hand (4.5.5).
  manually_resolved  boolean NOT NULL DEFAULT false,

  -- Status carried through so the result sheet can print ABSENT etc. (7.1).
  performance_status performance_status NOT NULL,

  computed_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT item_results_position_positive CHECK (position IS NULL OR position >= 1),
  CONSTRAINT item_results_points_non_negative CHECK (points >= 0)
);

CREATE UNIQUE INDEX item_results_item_performance_key ON item_results (item_id, performance_id);
CREATE INDEX item_results_item_position_idx           ON item_results (item_id, position);
CREATE INDEX item_results_church_idx                  ON item_results (church_id);
CREATE INDEX item_results_event_idx                   ON item_results (event_id);
CREATE INDEX item_results_registration_idx            ON item_results (registration_id);


-- -----------------------------------------------------------------------------
-- manual_tie_decisions -- an administrator's recorded resolution of a tie the
-- automated sequence could not break. FSD 4.5.5, ADM-12-02, 9.2 resolve-tie.
--
-- "If a tie remains after all automated criteria, the system does not guess."
-- Every row here is a human decision that must be reproducible and printable.
-- -----------------------------------------------------------------------------
CREATE TABLE manual_tie_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  item_id           uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  performance_id    uuid NOT NULL REFERENCES performances(id) ON DELETE CASCADE,

  assigned_position integer NOT NULL,
  declared_shared   boolean NOT NULL DEFAULT false,
  reason            text NOT NULL,

  decided_by        uuid NOT NULL REFERENCES users(id),
  decided_at        timestamptz NOT NULL DEFAULT now(),
  superseded_at     timestamptz,

  CONSTRAINT manual_tie_decisions_position_positive CHECK (assigned_position >= 1),
  CONSTRAINT manual_tie_decisions_reason_length CHECK (length(btrim(reason)) >= 15)
);

CREATE UNIQUE INDEX manual_tie_decisions_active_key
  ON manual_tie_decisions (item_id, performance_id)
  WHERE superseded_at IS NULL;
CREATE INDEX manual_tie_decisions_item_idx ON manual_tie_decisions (item_id);


-- -----------------------------------------------------------------------------
-- recompute_runs -- history of result recomputation. FSD 7.7.
--
-- "After any recomputation the system reports what changed, listing every
-- position that moved, so that the committee is never surprised." The diff is
-- captured here rather than only logged, so it can be printed and attached to
-- the exceptions report (ADM-10-04).
-- -----------------------------------------------------------------------------
CREATE TABLE recompute_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  scope         text NOT NULL,            -- 'ITEM' | 'EVENT'
  item_id       uuid REFERENCES items(id) ON DELETE SET NULL,
  trigger       text NOT NULL,            -- what caused it, e.g. 'SCORE_REVOKED'
  reason        text,

  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  duration_ms   integer,

  -- Ordered list of position changes: { itemId, itemName, chestNumber, memberName,
  -- from, to }. Empty array means the recomputation was a no-op.
  changes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  changed_count integer NOT NULL DEFAULT 0,

  triggered_by  uuid REFERENCES users(id)
);

CREATE INDEX recompute_runs_event_idx ON recompute_runs (event_id, started_at DESC);
