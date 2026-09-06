-- =============================================================================
-- 0015_offline_queue_visibility.sql
-- JDG-08-07: the server had no visibility into a judge's offline queue depth,
-- so a judge sitting on unsynced marks looked identical to one who simply
-- hadn't scored yet. The judge's device now reports its queue depth against
-- its own session row; the live console surfaces it next to "Waiting".
-- =============================================================================

ALTER TABLE user_sessions
  ADD COLUMN queued_marks integer NOT NULL DEFAULT 0,
  ADD COLUMN queued_marks_reported_at timestamptz;

COMMENT ON COLUMN user_sessions.queued_marks IS
  'JDG-08-07: last-reported count of marks sitting in this device''s offline queue, unsent. Self-reported by the client, not a correctness guarantee — purely operational visibility for the coordinator.';
