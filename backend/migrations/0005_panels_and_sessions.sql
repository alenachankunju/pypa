-- =============================================================================
-- 0005_panels_and_sessions.sql
-- Panels, panel membership, judging sessions and the items bound to them.
--
-- FSD references:
--   5.7  Judge management        (ADM-07-02, ADM-07-03)
--   5.8  Panel and session mgmt  (ADM-08-01 .. ADM-08-07)
--   7.2  Multi-judge concurrency -- panel size as the completion target
--   12.3 Operational edge cases  -- overlapping sessions, judge on two panels
-- =============================================================================

-- -----------------------------------------------------------------------------
-- panels -- a named set of judges. FSD 5.8.
--
-- ADM-08-02: panel size is not fixed. Any number of judges from one upwards is
-- supported; the system uses the actual assigned count as the completion target.
-- Nothing in this schema assumes three (2.5).
-- -----------------------------------------------------------------------------
CREATE TABLE panels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name           text NOT NULL,

  -- ADM-08-01 / tie-break criterion 4 (4.5): a designated chief judge whose mark
  -- can be used to separate an otherwise unbreakable tie.
  chief_judge_id uuid REFERENCES users(id) ON DELETE SET NULL,

  notes          text,
  is_active      boolean NOT NULL DEFAULT true,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  updated_by     uuid REFERENCES users(id),

  CONSTRAINT panels_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX panels_event_name_key ON panels (event_id, lower(name));
CREATE INDEX panels_event_active_idx      ON panels (event_id, is_active);

CREATE TRIGGER panels_set_updated_at
  BEFORE UPDATE ON panels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- panel_judges -- judges on a panel. FSD 8.1.
--
-- ADM-08-06 (mid-session panel change) requires that it remain clear which
-- performances were judged by which panel composition. Membership is therefore
-- NEVER hard-deleted: a removed judge keeps their row with removed_at set. The
-- uniqueness constraint is partial so the same judge may later be re-added.
--
-- weight supports the WEIGHTED_AVERAGE aggregation method (4.4).
-- -----------------------------------------------------------------------------
CREATE TABLE panel_judges (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id                 uuid NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  weight                   numeric(6,3) NOT NULL DEFAULT 1.0,

  -- ADM-07-03: assigning a judge affiliated with a competing church raises a
  -- warning that may be overridden with a recorded reason.
  conflict_override_reason text,

  added_at                 timestamptz NOT NULL DEFAULT now(),
  removed_at               timestamptz,
  removed_by               uuid REFERENCES users(id),
  removed_reason           text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES users(id),
  updated_by               uuid REFERENCES users(id),

  CONSTRAINT panel_judges_weight_positive CHECK (weight > 0)
);

-- FSD 8.1: UNIQUE(panel_id, user_id), applied to current membership only.
CREATE UNIQUE INDEX panel_judges_panel_user_key
  ON panel_judges (panel_id, user_id)
  WHERE removed_at IS NULL;

CREATE INDEX panel_judges_user_idx  ON panel_judges (user_id) WHERE removed_at IS NULL;
CREATE INDEX panel_judges_panel_idx ON panel_judges (panel_id);

CREATE TRIGGER panel_judges_set_updated_at
  BEFORE UPDATE ON panel_judges
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE panel_judges IS
  'ADM-08-06: membership is soft-removed so historical panel composition stays reconstructible.';


-- -----------------------------------------------------------------------------
-- sessions -- a panel bound to one or more items at a stage for a period.
--
-- ADM-08-04: only when a session is OPEN can its judges enter marks.
-- ADM-08-05: closing is blocked if any performance is not COMPLETE, ABSENT or
--            VOID; force-closing requires a reason and is prominently flagged.
-- -----------------------------------------------------------------------------
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name               text NOT NULL,
  stage              text,
  panel_id           uuid NOT NULL REFERENCES panels(id) ON DELETE RESTRICT,

  scheduled_start    timestamptz,
  scheduled_end      timestamptz,

  status             session_status NOT NULL DEFAULT 'DRAFT',

  opened_at          timestamptz,
  opened_by          uuid REFERENCES users(id),
  closed_at          timestamptz,
  closed_by          uuid REFERENCES users(id),

  -- ADM-08-05: mandatory when a session is closed with incomplete performances.
  force_closed_reason text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  updated_by         uuid REFERENCES users(id),

  CONSTRAINT sessions_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT sessions_schedule_order CHECK (
    scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end >= scheduled_start
  ),
  -- A force-closed session must always carry its justification.
  CONSTRAINT sessions_force_close_has_reason CHECK (
    status <> 'FORCE_CLOSED' OR force_closed_reason IS NOT NULL
  )
);

CREATE UNIQUE INDEX sessions_event_name_key ON sessions (event_id, lower(name));
CREATE INDEX sessions_event_status_idx      ON sessions (event_id, status);
CREATE INDEX sessions_panel_idx             ON sessions (panel_id);
CREATE INDEX sessions_schedule_idx          ON sessions (event_id, scheduled_start);

CREATE TRIGGER sessions_set_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- session_items -- items judged in a session. FSD 8.1, UNIQUE(session_id, item_id).
--
-- An item may legitimately be judged across more than one session (for example
-- heats and a final on different stages), so item_id is not globally unique here.
-- -----------------------------------------------------------------------------
CREATE TABLE session_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  display_order integer NOT NULL DEFAULT 0,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  updated_by    uuid REFERENCES users(id)
);

CREATE UNIQUE INDEX session_items_session_item_key ON session_items (session_id, item_id);
CREATE INDEX session_items_item_idx                ON session_items (item_id);
CREATE INDEX session_items_order_idx               ON session_items (session_id, display_order);

CREATE TRIGGER session_items_set_updated_at
  BEFORE UPDATE ON session_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
