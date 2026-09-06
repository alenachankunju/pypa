-- =============================================================================
-- 0013_registration_reentry_fix.sql
-- Fixes ADM-06-02 / ADM-06-05: a withdrawn registration blocked re-entry.
--
-- ADM-06-05 makes withdrawal a state change, not a deletion, which implies the
-- member can be registered again later (a substitute takes the slot, or the
-- original participant returns). But registrations_item_member_key (0004) was
-- UNIQUE(item_id, member_id) WHERE member_id IS NOT NULL — it exempted team
-- rows, not withdrawn ones, so the old WITHDRAWN row still occupied the slot
-- and a new registration attempt failed as a duplicate.
--
-- assertEntryCaps (services/eligibility.ts) already filters on
-- status = 'REGISTERED' when counting entries, so withdrawn rows were never
-- double-counted against per-church/per-member caps — only this index was
-- wrong.
-- =============================================================================

DROP INDEX registrations_item_member_key;

CREATE UNIQUE INDEX registrations_item_member_key
  ON registrations (item_id, member_id)
  WHERE member_id IS NOT NULL AND status = 'REGISTERED';
