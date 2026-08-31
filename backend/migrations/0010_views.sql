-- =============================================================================
-- 0010_views.sql
-- Read models for the live console, leaderboards and readiness reporting.
--
-- These views exist so the operationally critical screens are a single indexed
-- query rather than an N+1 assembled in application code. FSD 11.1 sets hard
-- latency targets (chest lookup < 300 ms p95, full recomputation < 10 s) and the
-- live console is polled continuously during an event.
--
-- FSD references:
--   5.9   Live judging console (ADM-09-08 outstanding marks)
--   7.6   Church championship computation
--   4.7.6 Individual champion
--   13    Pre-event readiness report
-- =============================================================================

-- -----------------------------------------------------------------------------
-- v_performance_progress -- one row per performance with its live scoring state.
--
-- ADM-09-08: "A persistent outstanding marks panel lists every performance in
-- the session that is not COMPLETE, naming the judges who have not submitted.
-- This is the single most important operational feature in the system."
--
-- missing_judges is derived from the performance_judges SNAPSHOT, not from
-- current panel membership, so a mid-session panel change (ADM-08-06) cannot
-- cause the console to chase the wrong judge.
-- -----------------------------------------------------------------------------
CREATE VIEW v_performance_progress AS
SELECT
  p.id                AS performance_id,
  p.event_id,
  p.session_id,
  p.item_id,
  p.registration_id,
  p.status,
  p.panel_size,
  p.is_current,
  p.attempt_no,
  p.call_order,
  p.aggregate_score,
  p.completed_at,
  COALESCE(s.submitted_count, 0)                       AS submitted_count,
  p.panel_size - COALESCE(s.submitted_count, 0)        AS outstanding_count,
  COALESCE(mj.missing_judges, '[]'::jsonb)             AS missing_judges,
  COALESCE(sj.submitted_judge_ids, ARRAY[]::uuid[])    AS submitted_judge_ids
FROM performances p
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS submitted_count
    FROM scores sc
   WHERE sc.performance_id = p.id AND NOT sc.revoked
) s ON true
LEFT JOIN LATERAL (
  SELECT array_agg(sc.judge_id) AS submitted_judge_ids
    FROM scores sc
   WHERE sc.performance_id = p.id AND NOT sc.revoked
) sj ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
           jsonb_build_object('judgeId', pj.judge_id, 'fullName', u.full_name)
           ORDER BY u.full_name
         ) AS missing_judges
    FROM performance_judges pj
    JOIN users u ON u.id = pj.judge_id
   WHERE pj.performance_id = p.id
     AND NOT EXISTS (
       SELECT 1 FROM scores sc
        WHERE sc.performance_id = p.id
          AND sc.judge_id = pj.judge_id
          AND NOT sc.revoked
     )
) mj ON true;

COMMENT ON VIEW v_performance_progress IS
  'ADM-09-08 outstanding-marks panel. missing_judges comes from the performance_judges snapshot, not live panel membership.';


-- -----------------------------------------------------------------------------
-- v_member_points -- personal points per member from PUBLISHED items only.
--
-- FSD 4.7.6: the individual champion is the member with the highest total
-- personal points across the items they entered.
--
-- ASSUMPTION (flagged for committee confirmation, see docs/OPEN-QUESTIONS.md):
-- for a GROUP item, the points earned by the team are credited in full to every
-- member of that team for the purpose of individual standings. Church points are
-- unaffected -- a team registration credits its owning church exactly once.
-- -----------------------------------------------------------------------------
CREATE VIEW v_member_points AS
WITH scoring_members AS (
  -- Individual registrations: the member is on the registration itself.
  SELECT ir.id AS result_id, ir.event_id, ir.item_id, ir.position, ir.points,
         ir.aggregate_score, r.member_id
    FROM item_results ir
    JOIN registrations r ON r.id = ir.registration_id
   WHERE r.member_id IS NOT NULL
  UNION ALL
  -- Team registrations: every listed team member.
  SELECT ir.id AS result_id, ir.event_id, ir.item_id, ir.position, ir.points,
         ir.aggregate_score, rm.member_id
    FROM item_results ir
    JOIN registrations r ON r.id = ir.registration_id
    JOIN registration_members rm ON rm.registration_id = r.id
   WHERE r.member_id IS NULL
)
SELECT
  sm.event_id,
  sm.member_id,
  COUNT(*) FILTER (WHERE sm.position IS NOT NULL)          AS placed_count,
  COUNT(DISTINCT sm.item_id)                               AS items_competed,
  COALESCE(SUM(sm.points), 0)                              AS total_points,
  COUNT(*) FILTER (WHERE sm.position = 1)                  AS first_places,
  COUNT(*) FILTER (WHERE sm.position = 2)                  AS second_places,
  COUNT(*) FILTER (WHERE sm.position = 3)                  AS third_places,
  COALESCE(SUM(sm.aggregate_score), 0)                     AS aggregate_total
FROM scoring_members sm
JOIN item_publications ip ON ip.item_id = sm.item_id
WHERE ip.state = 'PUBLISHED'
GROUP BY sm.event_id, sm.member_id;

COMMENT ON VIEW v_member_points IS
  'FSD 4.7.6 individual standings, PUBLISHED items only. Group-item points credit every team member (assumption, see docs/OPEN-QUESTIONS.md).';


-- -----------------------------------------------------------------------------
-- v_church_leaderboard -- FSD 7.6 church championship computation.
--
-- "points := sum of item_result.points for all results where result.item is
-- PUBLISHED and result.member.church = C"
--
-- Attribution uses item_results.church_id, which was frozen at result
-- computation time. FSD 12.2 requires points already earned to stay with the
-- original church even if a member's church record is later corrected.
-- -----------------------------------------------------------------------------
CREATE VIEW v_church_leaderboard AS
SELECT
  ir.event_id,
  ir.church_id,
  c.name                                          AS church_name,
  c.short_code,
  COALESCE(SUM(ir.points), 0)                     AS total_points,
  COUNT(*) FILTER (WHERE ir.position = 1)         AS first_places,
  COUNT(*) FILTER (WHERE ir.position = 2)         AS second_places,
  COUNT(*) FILTER (WHERE ir.position = 3)         AS third_places,
  COUNT(*) FILTER (WHERE ir.position IS NOT NULL) AS placed_count,
  COUNT(DISTINCT ir.item_id)                      AS items_entered,
  COALESCE(SUM(ir.aggregate_score), 0)            AS aggregate_total
FROM item_results ir
JOIN item_publications ip ON ip.item_id = ir.item_id
JOIN churches c           ON c.id = ir.church_id
WHERE ip.state = 'PUBLISHED'
GROUP BY ir.event_id, ir.church_id, c.name, c.short_code;

COMMENT ON VIEW v_church_leaderboard IS
  'FSD 7.6. Ranking and tie-break (1st count, then 2nd count, then aggregate total) are applied in the result service.';


-- -----------------------------------------------------------------------------
-- v_item_readiness -- per-item scoring and publication state.
--
-- Drives ADM-12-09 ("every result screen shows the count of items still
-- unpublished") and the 7.4 NOT_READY guard: an item is READY only when every
-- performance is COMPLETE, ABSENT, VOID or WITHDRAWN.
-- -----------------------------------------------------------------------------
CREATE VIEW v_item_readiness AS
SELECT
  i.id                AS item_id,
  i.event_id,
  i.name              AS item_name,
  i.code              AS item_code,
  i.category_id,
  i.status            AS item_status,
  COALESCE(ip.state, 'IN_PROGRESS'::item_result_state) AS publication_state,
  ip.has_unresolved_tie,
  ip.published_at,
  COUNT(p.id)                                                   AS performance_count,
  COUNT(p.id) FILTER (WHERE p.status = 'COMPLETE')              AS complete_count,
  COUNT(p.id) FILTER (WHERE p.status = 'ABSENT')                AS absent_count,
  COUNT(p.id) FILTER (WHERE p.status = 'VOID')                  AS void_count,
  COUNT(p.id) FILTER (WHERE p.status = 'WITHDRAWN')             AS withdrawn_count,
  COUNT(p.id) FILTER (
    WHERE p.status IN ('SCHEDULED', 'ON_STAGE', 'IN_PROGRESS')
  )                                                             AS pending_count,
  -- FSD 7.4: rank_item returns NOT_READY while any performance is still pending.
  (COUNT(p.id) FILTER (
     WHERE p.status IN ('SCHEDULED', 'ON_STAGE', 'IN_PROGRESS')
   ) = 0)                                                       AS is_ready
FROM items i
LEFT JOIN item_publications ip ON ip.item_id = i.id
LEFT JOIN performances p       ON p.item_id = i.id
GROUP BY i.id, i.event_id, i.name, i.code, i.category_id, i.status,
         ip.state, ip.has_unresolved_tie, ip.published_at;


-- -----------------------------------------------------------------------------
-- v_judge_activity -- FSD 5.13 judge activity report.
--
-- "Deviation from panel mean is a quiet but powerful quality signal: a judge who
-- consistently marks two points above the rest of the panel is not necessarily
-- wrong, but the committee should know before the results are announced rather
-- than after."
--
-- mean_deviation is the average of (this judge's mark - the panel mean for that
-- same performance), so it is signed: positive means habitually generous.
-- -----------------------------------------------------------------------------
CREATE VIEW v_judge_activity AS
SELECT
  p.event_id,
  s.judge_id,
  u.full_name                                   AS judge_name,
  COUNT(*)                                      AS scores_submitted,
  COUNT(*) FILTER (WHERE s.revoked)             AS scores_revoked,
  COUNT(*) FILTER (WHERE s.is_out_of_sequence)  AS out_of_sequence_count,
  MIN(s.submitted_at)                           AS first_submission_at,
  MAX(s.submitted_at)                           AS last_submission_at,
  ROUND(AVG(s.mark), 3)                         AS average_mark,
  ROUND(AVG(s.mark - pm.panel_mean), 3)         AS mean_deviation
FROM scores s
JOIN performances p ON p.id = s.performance_id
JOIN users u        ON u.id = s.judge_id
LEFT JOIN LATERAL (
  SELECT AVG(s2.mark) AS panel_mean
    FROM scores s2
   WHERE s2.performance_id = s.performance_id AND NOT s2.revoked
) pm ON true
WHERE NOT s.revoked
GROUP BY p.event_id, s.judge_id, u.full_name;

COMMENT ON VIEW v_judge_activity IS
  'FSD 5.13 judge activity report. mean_deviation is signed: positive means this judge marks above their panel.';
