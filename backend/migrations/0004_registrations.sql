-- =============================================================================
-- 0004_registrations.sql
-- Registrations (individual and team) and team membership.
--
-- FSD references:
--   4.2  Identity and eligibility rules
--   5.6  Registration management (ADM-06-01 .. ADM-06-07)
--   8.2  Critical constraints -- UNIQUE (item_id, member_id)
--   12.2 Data management edge cases -- late entry flagging
-- =============================================================================

-- -----------------------------------------------------------------------------
-- registrations -- the link between a member (or a team) and an item.
--
-- For an INDIVIDUAL item, member_id is set and team_name is null.
-- For a GROUP item, member_id is null, team_name is set, and the participating
-- members are listed in registration_members (ADM-06-04).
--
-- ADM-06-05: a registration is WITHDRAWN, never deleted -- withdrawal is a
-- state change so the entry list remains explainable after the fact.
-- ADM-06-06: a registration cannot be removed once a score exists against its
-- performance. Enforced by trigger in 0009.
-- -----------------------------------------------------------------------------
CREATE TABLE registrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  item_id          uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,

  -- NULL for a team registration.
  member_id        uuid REFERENCES members(id) ON DELETE RESTRICT,

  -- ADM-06-04: a team registration has a team name and an owning church.
  team_name        text,

  -- Denormalised from the member (or supplied for a team) so that church points
  -- attribution is fixed at registration time. FSD 12.2: a member may not change
  -- church once a score exists, because points already earned are attributed to
  -- the original church -- this column is what makes that attribution stable.
  church_id        uuid NOT NULL REFERENCES churches(id) ON DELETE RESTRICT,

  status           registration_status NOT NULL DEFAULT 'REGISTERED',
  withdrawn_at     timestamptz,
  withdrawn_reason text,

  -- 12.2: a registration added after the item has started is flagged as a late
  -- entry in the audit log and on the result sheet.
  is_late_entry    boolean NOT NULL DEFAULT false,

  -- ADM-05-04 / ADM-06-03: where an administrator deliberately registered an
  -- ineligible member, the justification is retained on the row itself so it can
  -- be printed on the result sheet, not only found in the audit log.
  eligibility_override_reason text,

  -- ADM-06-07: display order for the announcer call sheet, optionally randomised.
  call_order       integer,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id),
  updated_by       uuid REFERENCES users(id),

  -- Exactly one of member_id / team_name identifies the entrant.
  CONSTRAINT registrations_entrant_shape CHECK (
    (member_id IS NOT NULL AND team_name IS NULL)
    OR (member_id IS NULL AND team_name IS NOT NULL)
  ),
  CONSTRAINT registrations_withdrawn_shape CHECK (
    status <> 'WITHDRAWN' OR withdrawn_at IS NOT NULL
  )
);

-- FSD 8.2 critical constraint: UNIQUE (item_id, member_id) on registrations --
-- prevents a member being entered twice in the same item (4.2.5).
-- NULL member_id rows (teams) are exempt by design; team duplication is
-- prevented by the index on registration_members below.
CREATE UNIQUE INDEX registrations_item_member_key
  ON registrations (item_id, member_id)
  WHERE member_id IS NOT NULL;

-- Two teams in one item may not share a name.
CREATE UNIQUE INDEX registrations_item_team_key
  ON registrations (item_id, lower(team_name))
  WHERE team_name IS NOT NULL;

CREATE INDEX registrations_item_status_idx   ON registrations (item_id, status);
CREATE INDEX registrations_member_idx        ON registrations (member_id);
CREATE INDEX registrations_church_item_idx   ON registrations (church_id, item_id);
CREATE INDEX registrations_event_idx         ON registrations (event_id);
CREATE INDEX registrations_call_order_idx    ON registrations (item_id, call_order);

CREATE TRIGGER registrations_set_updated_at
  BEFORE UPDATE ON registrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- registration_members -- members within a team registration. ADM-06-04.
--
-- item_id is denormalised here so that a single unique index can enforce
-- rule 4.2.5 ("a member may not register twice for the same item") across BOTH
-- individual and team entries. Without it, a member could be silently placed in
-- two teams for the same item.
-- -----------------------------------------------------------------------------
CREATE TABLE registration_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  item_id         uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  is_team_leader  boolean NOT NULL DEFAULT false,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  updated_by      uuid REFERENCES users(id)
);

CREATE UNIQUE INDEX registration_members_reg_member_key
  ON registration_members (registration_id, member_id);

-- Rule 4.2.5 for team entries.
CREATE UNIQUE INDEX registration_members_item_member_key
  ON registration_members (item_id, member_id);

CREATE INDEX registration_members_member_idx ON registration_members (member_id);

CREATE TRIGGER registration_members_set_updated_at
  BEFORE UPDATE ON registration_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN registration_members.item_id IS
  'Denormalised from the parent registration so UNIQUE(item_id, member_id) can enforce FSD 4.2.5 for team entries.';
