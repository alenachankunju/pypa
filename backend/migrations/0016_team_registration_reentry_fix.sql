-- =============================================================================
-- 0016_team_registration_reentry_fix.sql
-- Fixes the team-registration half of ADM-06-02 / ADM-06-05: a withdrawn team
-- entry blocked re-entry, the exact bug 0013 already fixed for individuals.
--
-- registrations_item_team_key (0004) was UNIQUE (item_id, lower(team_name))
-- WHERE team_name IS NOT NULL — it had no status qualifier at all, so a
-- WITHDRAWN team's row still occupied its team name for that item, and
-- re-registering a new team under the same name failed as a duplicate with
-- the generic "That record already exists." (the constraint name wasn't even
-- in utils/errors.ts's UNIQUE_VIOLATIONS map, since it was never expected to
-- fire in normal use).
--
-- withdrawRegistration() (registrations.service.ts) is changed alongside this
-- migration to also delete the withdrawn registration's registration_members
-- rows — that table carries no status of its own, so a member who was on a
-- withdrawn team would otherwise still collide with registration_members_item_
-- member_key on any later attempt to enter that item, individually or on a
-- new team. The parent registrations row (status WITHDRAWN, team_name kept)
-- remains as the historical record; the audit log already captured the
-- member roster at creation time, so nothing is lost by clearing the live
-- join rows.
-- =============================================================================

DROP INDEX registrations_item_team_key;

CREATE UNIQUE INDEX registrations_item_team_key
  ON registrations (item_id, lower(team_name))
  WHERE team_name IS NOT NULL AND status = 'REGISTERED';
