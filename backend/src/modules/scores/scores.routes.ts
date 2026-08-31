/**
 * Administrative score routes (FSD 5.10, 11.4).
 *
 * Two operations live here, and only two:
 *
 *  - Revoke a submitted score (ADM-10-01..05) — "exactly one controlled route to
 *    correct" a mistaken mark.
 *  - Paper back-entry (FSD 11.4) — entering marks captured on paper during a
 *    total systems failure, "through a dedicated back-entry screen that records
 *    who entered them and why".
 *
 * There is no route to EDIT a score, for any role. FSD 4.3.3 makes a submitted
 * mark immutable, and migration 0009 enforces that in the database.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability, requireRevokeScore } from '../../middleware/authorize.js';
import { requireLiveSession } from '../../middleware/authenticate.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { actorFromRequest } from '../../services/audit.js';
import { recomputeItem } from '../../services/results/recompute.js';
import { revokeScore, MIN_REVOKE_REASON_LENGTH } from '../../services/scoring/revokeScore.js';
import { submitScore } from '../../services/scoring/submitScore.js';
import { errors } from '../../utils/errors.js';
import { asyncHandler, created, ok } from '../../utils/http.js';

export function scoreRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());

  /**
   * FSD 9.2: POST /api/scores/{id}/revoke.
   *
   * requireLiveSession is applied here specifically: revocation is one of the
   * highest-consequence actions in the system, so an administrator who has been
   * force-logged-out (ADM-07-05) must stop being able to perform it immediately
   * rather than at the end of their access-token window.
   */
  router.post(
    '/:id/revoke',
    requireLiveSession(),
    requireRevokeScore(),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().min(MIN_REVOKE_REASON_LENGTH).max(1000) }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };

      const result = await revokeScore(
        { scoreId: id, reason, revokedBy: req.auth!.userId },
        actorFromRequest(req),
        req.eventId!,
      );

      // FSD 7.7: a revoked score is one of the named triggers for recomputation.
      const recompute = await recomputeItem(
        result.itemId,
        req.eventId!,
        'SCORE_REVOKED',
        actorFromRequest(req),
        reason,
      );

      return ok(res, {
        ...result,
        // FSD 7.7: report what changed, so the committee is never surprised.
        positionChanges: recompute.changes,
        message:
          'The mark has been revoked and excluded from all calculations. The judge has been prompted to re-enter it.',
      });
    }),
  );

  /**
   * Scores for one performance, with the judge breakdown (ADM-09-04, ADM-12-01).
   *
   * FSD 3.2 grants "View all scores for a performance" to Super Admin and Admin
   * only; a coordinator gets "View count only" and is refused here — they use the
   * session progress endpoint instead.
   */
  router.get(
    '/performance/:performanceId',
    requireCapability(Capability.VIEW_ALL_SCORES),
    validate({ params: z.object({ performanceId: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { performanceId } = req.params as { performanceId: string };

      const performance = await db
        .selectFrom('performances as p')
        .innerJoin('items as i', 'i.id', 'p.item_id')
        .select(['p.id', 'p.status', 'p.panel_size', 'p.aggregate_score', 'i.name as item_name'])
        .where('p.id', '=', performanceId)
        .where('p.event_id', '=', req.eventId!)
        .executeTakeFirst();

      if (!performance) throw errors.notFound('Performance', performanceId);

      const scores = await db
        .selectFrom('scores as s')
        .innerJoin('users as u', 'u.id', 's.judge_id')
        .leftJoin('users as rb', 'rb.id', 's.revoked_by')
        .select([
          's.id',
          's.judge_id',
          's.mark',
          's.remarks',
          's.submitted_at',
          's.received_at',
          's.device_id',
          's.entry_mode',
          's.is_out_of_sequence',
          's.revoked',
          's.revoked_at',
          's.revoked_reason',
          'u.full_name as judge_name',
          'rb.full_name as revoked_by_name',
        ])
        .where('s.performance_id', '=', performanceId)
        .orderBy('s.submitted_at')
        .execute();

      return ok(res, {
        performanceId,
        itemName: performance.item_name,
        status: performance.status,
        panelSize: performance.panel_size,
        // ADM-09-04: the aggregate becomes visible once COMPLETE.
        aggregate:
          performance.status === 'COMPLETE' && performance.aggregate_score !== null
            ? Number(performance.aggregate_score)
            : null,
        scores: scores.map((s) => ({
          id: s.id,
          judgeId: s.judge_id,
          judgeName: s.judge_name,
          mark: Number(s.mark),
          remarks: s.remarks,
          submittedAt: s.submitted_at,
          receivedAt: s.received_at,
          deviceId: s.device_id,
          entryMode: s.entry_mode,
          isOutOfSequence: s.is_out_of_sequence,
          revoked: s.revoked,
          revokedAt: s.revoked_at,
          revokedReason: s.revoked_reason,
          revokedByName: s.revoked_by_name,
        })),
      });
    }),
  );

  /**
   * FSD 11.4 paper contingency back-entry.
   *
   * "A documented paper contingency: printed blank mark sheets per item, so that
   * a total systems failure degrades to the existing manual process rather than
   * halting the competition. Marks captured on paper are entered afterwards by an
   * administrator through a dedicated back-entry screen that records who entered
   * them and why."
   *
   * The mark is still attributed to the JUDGE who awarded it — score attribution
   * is the foundation of the audit trail (FSD 3.1) — while entered_by records the
   * administrator who typed it, and back_entry_reason records why.
   */
  router.post(
    '/back-entry',
    requireLiveSession(),
    requireCapability(Capability.BACK_ENTER_SCORE),
    validate({
      body: z.object({
        performanceId: z.string().uuid(),
        judgeId: z.string().uuid(),
        mark: z.coerce.number().min(0),
        reason: z.string().min(15).max(500),
        remarks: z.string().max(250).optional().nullable(),
        /** The time written on the paper sheet, where recorded. */
        submittedAt: z.coerce.date().optional(),
        criteria: z
          .array(z.object({ itemCriteriaId: z.string().uuid(), mark: z.coerce.number().min(0) }))
          .max(20)
          .optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const input = req.body as {
        performanceId: string;
        judgeId: string;
        mark: number;
        reason: string;
        remarks?: string | null;
        submittedAt?: Date;
        criteria?: { itemCriteriaId: string; mark: number }[];
      };

      const judge = await db
        .selectFrom('users')
        .select(['id', 'full_name', 'role'])
        .where('id', '=', input.judgeId)
        .executeTakeFirst();

      if (!judge) throw errors.notFound('Judge', input.judgeId);
      if (judge.role !== 'JUDGE') {
        throw errors.validation('Back-entered marks must be attributed to a judge account.');
      }

      const result = await submitScore(
        {
          performanceId: input.performanceId,
          judgeId: input.judgeId,
          mark: input.mark,
          remarks: input.remarks ?? null,
          idempotencyKey: randomUUID(),
          submittedAt: input.submittedAt ?? new Date(),
          criteria: input.criteria,
          entryMode: 'ADMIN_BACK_ENTRY',
          enteredBy: req.auth!.userId,
          backEntryReason: input.reason,
        },
        actorFromRequest(req),
        req.eventId!,
      );

      return created(res, {
        ...result,
        judgeName: judge.full_name,
        enteredBy: req.auth!.fullName,
        message: `Mark recorded on behalf of ${judge.full_name}. This entry is flagged in the exceptions report.`,
      });
    }),
  );

  return router;
}
