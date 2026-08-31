/**
 * Score revocation (FSD 5.10) — the single controlled route to correct a mark.
 *
 * "Judges cannot edit scores. Genuine mistakes still happen, so there must be
 * exactly one controlled route to correct one."
 *
 * ADM-10-01: Super Admin (or a delegated Admin), with a mandatory free-text
 *            reason of at least 15 characters.
 * ADM-10-02: the original row is NOT deleted — it is flagged revoked, retains
 *            its original value and timestamp, and is excluded from calculation.
 * ADM-10-03: the performance returns to IN_PROGRESS and the judge is prompted to
 *            re-enter.
 * ADM-10-05: if the item is already published, revocation requires unpublishing
 *            first, with a warning that totals will be recalculated.
 */
import { db } from '../../db/pool.js';
import { errors } from '../../utils/errors.js';
import { AuditAction, writeAudit, type AuditActor } from '../audit.js';
import { publishScoreRevoked, publishScoringProgress } from '../realtime.js';

export interface RevokeScoreInput {
  scoreId: string;
  reason: string;
  revokedBy: string;
}

export interface RevokeScoreResult {
  scoreId: string;
  performanceId: string;
  judgeId: string;
  previousMark: number;
  performanceStatus: string;
  submittedCount: number;
  panelSize: number;
  itemId: string;
}

/** ADM-10-01: "A mandatory free-text reason of at least 15 characters." */
export const MIN_REVOKE_REASON_LENGTH = 15;

export async function revokeScore(
  input: RevokeScoreInput,
  actor: AuditActor,
  eventId: string,
): Promise<RevokeScoreResult> {
  const reason = input.reason.trim();
  if (reason.length < MIN_REVOKE_REASON_LENGTH) {
    throw errors.validation(
      `A revocation reason of at least ${MIN_REVOKE_REASON_LENGTH} characters is required. ` +
        'It is printed in the exceptions report alongside the final results (FSD ADM-10-04).',
      { minLength: MIN_REVOKE_REASON_LENGTH, provided: reason.length },
    );
  }

  return db.transaction().execute(async (trx) => {
    // Locked on its own, with no joins: PostgreSQL refuses a plain FOR UPDATE
    // once any joined table can sit on the nullable side of an outer join —
    // here, item_publications via the LEFT JOIN below (see the identical note
    // in submitScore.ts). The row is locked first, then the joined context is
    // read unlocked.
    const lockedScore = await trx
      .selectFrom('scores')
      .select(['id', 'performance_id', 'judge_id', 'mark', 'revoked', 'submitted_at'])
      .where('id', '=', input.scoreId)
      .forUpdate()
      .executeTakeFirst();

    if (!lockedScore) throw errors.notFound('Score', input.scoreId);

    const context = await trx
      .selectFrom('performances as p')
      .innerJoin('items as i', 'i.id', 'p.item_id')
      .leftJoin('item_publications as ip', 'ip.item_id', 'p.item_id')
      .select([
        'p.status as performance_status',
        'p.panel_size',
        'p.session_id',
        'p.item_id',
        'i.name as item_name',
        'ip.state as publication_state',
      ])
      .where('p.id', '=', lockedScore.performance_id)
      .executeTakeFirst();

    if (!context) throw errors.notFound('Performance', lockedScore.performance_id);

    const score = { score_id: lockedScore.id, ...lockedScore, ...context };

    if (score.revoked) {
      throw errors.conflict('That mark has already been revoked.');
    }

    // ADM-10-05: "If an item is already Published, revoking a score within it
    // requires unpublishing first, and the system warns that church totals and
    // the championship will be recalculated."
    if (score.publication_state === 'PUBLISHED') {
      throw errors.resultPublished(score.item_name);
    }

    // ADM-10-02: flag, never delete. The immutability trigger in migration 0009
    // permits exactly this UPDATE and no other, so mark and submitted_at are
    // physically incapable of changing here.
    await trx
      .updateTable('scores')
      .set({
        revoked: true,
        revoked_by: input.revokedBy,
        revoked_at: new Date(),
        revoked_reason: reason,
      })
      .where('id', '=', input.scoreId)
      .execute();

    // Recount valid marks now that this one is excluded.
    const { count } = await trx
      .selectFrom('scores')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('performance_id', '=', score.performance_id)
      .where('revoked', '=', false)
      .executeTakeFirstOrThrow();

    const submittedCount = Number(count);

    // ADM-10-03: "The affected performance returns to PARTIAL" — IN_PROGRESS in
    // the 7.1 state machine, which lists COMPLETE -> IN_PROGRESS as valid
    // "only if a score is revoked". This is that transition.
    //
    // The stored aggregate is cleared at the same time: FSD 7.3 stores
    // aggregates so a later configuration change cannot alter a historical
    // result, but an aggregate computed from a mark that has since been revoked
    // is simply wrong, and leaving it would let the result engine rank on it.
    let performanceStatus = score.performance_status;

    if (score.performance_status === 'COMPLETE') {
      await trx
        .updateTable('performances')
        .set({
          status: 'IN_PROGRESS',
          aggregate_score: null,
          aggregate_method_used: null,
          completed_at: null,
          updated_by: actor.id,
        })
        .where('id', '=', score.performance_id)
        .execute();
      performanceStatus = 'IN_PROGRESS';
    }

    await writeAudit(
      {
        eventId,
        actor,
        action: AuditAction.SCORE_REVOKED,
        entityType: 'score',
        entityId: input.scoreId,
        oldValue: {
          mark: Number(score.mark),
          judgeId: score.judge_id,
          submittedAt: score.submitted_at,
          revoked: false,
        },
        newValue: { revoked: true, revokedBy: input.revokedBy },
        reason,
        sessionId: score.session_id,
      },
      trx,
    );

    // ADM-10-03: tell the judge's device to re-open the performance for entry.
    if (score.session_id) {
      publishScoreRevoked(score.session_id, score.judge_id, score.performance_id);
      publishScoringProgress(score.session_id, {
        performanceId: score.performance_id,
        submittedCount,
        panelSize: score.panel_size,
        status: performanceStatus,
        submittedJudgeIds: [],
      });
    }

    return {
      scoreId: input.scoreId,
      performanceId: score.performance_id,
      judgeId: score.judge_id,
      previousMark: Number(score.mark),
      performanceStatus,
      submittedCount,
      panelSize: score.panel_size,
      itemId: score.item_id,
    };
  });
}
