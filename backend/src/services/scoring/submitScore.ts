/**
 * Score submission — the transactional core of the system (FSD 7.2, 7.3).
 *
 * This implements the pseudocode in 7.3 literally, inside a single transaction,
 * and answers the stakeholder question 7.2 opens with: "three judges all enter a
 * mark for the same member — how do we manage this without error?"
 *
 * The four mechanisms 7.2 names, and where each lives:
 *
 *   1. Shared target — every judge writes a row pointing at the same
 *      performance_id. There is no matching or reconciliation step because there
 *      is nothing to match.
 *
 *   2. Database-level uniqueness — the partial unique index
 *      scores_performance_judge_key makes a duplicate physically impossible.
 *      "Two simultaneous requests from the same judge cannot both succeed; the
 *      second is rejected by the database, not by application logic that might
 *      have a race condition." The check in this file is a courtesy that
 *      produces a better message; the index is the guarantee.
 *
 *   3. Independent rows, not a shared record — nothing here updates another
 *      judge's row, so there is no lost-update problem and no locking.
 *
 *   4. Server-side completion check — the count and the COMPLETE transition
 *      happen inside the same transaction as the insert, so exactly one
 *      concurrent submission can observe the final count.
 */
import { randomUUID } from 'node:crypto';
import type { Executor } from '../../db/pool.js';
import { db } from '../../db/pool.js';
import type { AggregationMethod, PerformanceStatus, ScoreEntryMode } from '../../db/schema.js';
import { AppError, ErrorCode, errors } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { AuditAction, writeAudit, type AuditActor } from '../audit.js';
import { publishPerformanceComplete, publishScoringProgress } from '../realtime.js';
import { computeAggregate, validateMark } from './aggregate.js';
import type { JudgeMark } from './types.js';

export interface SubmitScoreInput {
  performanceId: string;
  judgeId: string;
  mark: number;
  remarks?: string | null;
  /** JDG-06-04: client-generated, guarantees a retry cannot double-write. */
  idempotencyKey: string;
  /** JDG-08-06: client submission time, authoritative for the audit trail. */
  submittedAt: Date;
  deviceId?: string | null;
  /** 4.3.9 / JDG-05-04: per-criterion marks where the item defines criteria. */
  criteria?: { itemCriteriaId: string; mark: number }[];
  /** 12.1: set when the judge acknowledged the wrong-item warning (JDG-04-04). */
  acknowledgedOutOfSequence?: boolean;
  /** 11.4: paper back-entry provenance. */
  entryMode?: ScoreEntryMode;
  enteredBy?: string | null;
  backEntryReason?: string | null;
}

export interface SubmitScoreResult {
  scoreId: string;
  performanceId: string;
  mark: number;
  submittedAt: Date;
  /** True where an identical idempotency key had already been recorded. */
  wasReplay: boolean;
  performanceStatus: PerformanceStatus;
  submittedCount: number;
  panelSize: number;
  /** Set only once the performance is COMPLETE — never returned to a judge. */
  aggregate: number | null;
  isOutOfSequence: boolean;
}

/**
 * Submit one mark.
 *
 * @param actor Audit context. For a judge submission this is the judge; for a
 *              paper back-entry (FSD 11.4) it is the administrator, while
 *              judgeId remains the judge who awarded the mark.
 */
export async function submitScore(
  input: SubmitScoreInput,
  actor: AuditActor,
  eventId: string,
): Promise<SubmitScoreResult> {
  // ---------------------------------------------------------------------
  // JDG-06-05: idempotency, checked before the transaction.
  //
  // "The idempotency key guarantees that a retried request caused by a flaky
  // network cannot create a second score row. The server returns the original
  // result for a repeated key rather than an error."
  //
  // This is the offline queue's safety net (JDG-08-03/05): a queued mark that
  // was in fact delivered before the connection dropped replays harmlessly.
  // ---------------------------------------------------------------------
  const replay = await findByIdempotencyKey(input.idempotencyKey);
  if (replay) return replay;

  return db.transaction().execute(async (trx) => {
    // -------------------------------------------------------------------
    // Lock the performance row so the completion check below cannot
    // interleave with a concurrent submission for the same performance.
    //
    // Locked on its own, with no joins: PostgreSQL refuses a plain FOR UPDATE
    // the moment any joined table can sit on the nullable side of an outer
    // join (here, scoring_config, item_publications and sessions all can, via
    // the LEFT JOINs below) — "FOR UPDATE cannot be applied to the nullable
    // side of an outer join". FOR UPDATE on performances (not on scores) is
    // the right granularity regardless: judges still insert their own rows
    // freely and independently (7.2.3); the lock only serialises the
    // read-count-then-transition step.
    // -------------------------------------------------------------------
    const lockedPerformance = await trx
      .selectFrom('performances')
      .select(['id', 'status', 'panel_size', 'session_id', 'item_id', 'is_current'])
      .where('id', '=', input.performanceId)
      .forUpdate()
      .executeTakeFirst();

    if (!lockedPerformance) throw errors.notFound('Performance', input.performanceId);

    // Context for authorisation and validation, read unlocked now that the
    // row itself is pinned — nothing here needs to block a concurrent writer.
    // Items, scoring_config and item_publications all relate through item_id /
    // event_id and join cleanly; the session (related by session_id, which
    // items does not carry) is looked up separately.
    const itemContext = await trx
      .selectFrom('items as i')
      .leftJoin('scoring_config as sc', 'sc.event_id', 'i.event_id')
      .leftJoin('item_publications as ip', 'ip.item_id', 'i.id')
      .select([
        'i.name as item_name',
        'i.max_mark as item_max_mark',
        'sc.max_mark as config_max_mark',
        'sc.decimal_places',
        'sc.aggregation_method',
        'ip.state as publication_state',
      ])
      .where('i.id', '=', lockedPerformance.item_id)
      .executeTakeFirst();

    if (!itemContext) throw errors.notFound('Item', lockedPerformance.item_id);

    const sessionContext = lockedPerformance.session_id
      ? await trx
          .selectFrom('sessions')
          .select(['status as session_status', 'name as session_name'])
          .where('id', '=', lockedPerformance.session_id)
          .executeTakeFirst()
      : undefined;

    const performance = {
      performance_id: lockedPerformance.id,
      status: lockedPerformance.status,
      panel_size: lockedPerformance.panel_size,
      session_id: lockedPerformance.session_id,
      item_id: lockedPerformance.item_id,
      is_current: lockedPerformance.is_current,
      session_status: sessionContext?.session_status ?? null,
      session_name: sessionContext?.session_name ?? null,
      ...itemContext,
    };

    const isBackEntry = input.entryMode === 'ADMIN_BACK_ENTRY';

    // -------------------------------------------------------------------
    // FSD 9.4 SESSION_NOT_OPEN — "Scoring attempted outside an open session."
    // ADM-08-04: "Only when a session is open can its judges enter marks."
    //
    // Back-entry is exempt: FSD 11.4's paper contingency exists precisely so
    // marks captured while the system was unavailable can be entered afterwards,
    // by which time the session is normally closed.
    // -------------------------------------------------------------------
    if (!isBackEntry && performance.session_status !== 'OPEN') {
      throw errors.sessionNotOpen(performance.session_name ?? undefined);
    }

    // -------------------------------------------------------------------
    // FSD 12.1: "A judge submits offline and the network returns after the item
    // is published — The submission is rejected with RESULT_PUBLISHED and
    // escalated to the administrator, who must unpublish, accept the mark, and
    // republish. The judge is told clearly what happened."
    // -------------------------------------------------------------------
    if (performance.publication_state === 'PUBLISHED') {
      throw errors.resultPublished(performance.item_name);
    }

    // -------------------------------------------------------------------
    // FSD 9.4 PERFORMANCE_LOCKED — "Performance is COMPLETE, VOID or ABSENT."
    // -------------------------------------------------------------------
    if (!SCORABLE_STATUSES.has(performance.status)) {
      throw errors.performanceLocked(performance.status);
    }

    // -------------------------------------------------------------------
    // FSD 9.4 NOT_ON_PANEL — "Judge is not assigned to this performance's panel."
    // 11.2: "a judge cannot score a performance outside their assignment even
    // with a valid token and a crafted request."
    //
    // Checked against the performance_judges SNAPSHOT, not live panel membership,
    // so ADM-08-06's mid-session panel change leaves in-flight performances
    // scoreable by the panel that started them (7.2).
    // -------------------------------------------------------------------
    const assignment = await trx
      .selectFrom('performance_judges')
      .select(['weight', 'is_chief'])
      .where('performance_id', '=', input.performanceId)
      .where('judge_id', '=', input.judgeId)
      .executeTakeFirst();

    if (!assignment) throw errors.notOnPanel();

    // -------------------------------------------------------------------
    // FSD 9.4 MARK_OUT_OF_RANGE, 4.3.1 precision.
    // ADM-04-02: the item maximum overrides the event maximum where set.
    // -------------------------------------------------------------------
    const maxMark = Number(performance.item_max_mark ?? performance.config_max_mark ?? 10);
    const decimalPlaces = Number(performance.decimal_places ?? 1);

    const markCheck = validateMark(input.mark, maxMark, decimalPlaces);
    if (!markCheck.valid) {
      throw errors.markOutOfRange(input.mark, maxMark);
    }

    // -------------------------------------------------------------------
    // 4.3.9 / JDG-05-04: where criteria are defined, all must be filled and the
    // judge's mark is their sum.
    // -------------------------------------------------------------------
    const criteria = await trx
      .selectFrom('item_criteria')
      .select(['id', 'name', 'max_mark'])
      .where('item_id', '=', performance.item_id)
      .orderBy('display_order')
      .execute();

    if (criteria.length > 0) {
      validateCriteria(criteria, input.criteria ?? [], input.mark, decimalPlaces);
    }

    // -------------------------------------------------------------------
    // FSD 9.4 ALREADY_SCORED — 4.3.2: "A judge may score a performance exactly
    // once. There is no second submission."
    //
    // The partial unique index is the actual guarantee; this lookup exists so
    // JDG-06-07 can be honoured — "the app shows the existing mark and treats
    // the action as complete rather than showing a failure" — which needs the
    // existing mark in the error payload.
    // -------------------------------------------------------------------
    const existing = await trx
      .selectFrom('scores')
      .select(['id', 'mark', 'submitted_at'])
      .where('performance_id', '=', input.performanceId)
      .where('judge_id', '=', input.judgeId)
      .where('revoked', '=', false)
      .executeTakeFirst();

    if (existing) {
      throw errors.alreadyScored({
        scoreId: existing.id,
        mark: Number(existing.mark),
        submittedAt: existing.submitted_at,
      });
    }

    // -------------------------------------------------------------------
    // 12.1: "A judge scores an item that is not the one on stage — A blocking
    // warning is shown naming both items. Proceeding is allowed but the score is
    // flagged out-of-sequence in the audit log for review."
    //
    // The warning itself is the client's job (JDG-04-04); the flag is the
    // server's, and it must be set whether or not the client bothered to
    // acknowledge — a crafted request should not be able to hide the fact.
    // -------------------------------------------------------------------
    const isOutOfSequence = !isBackEntry && !performance.is_current;

    // -------------------------------------------------------------------
    // 7.3: INSERT score (P, J, M, submitted_at, device, idempotency_key)
    // -------------------------------------------------------------------
    const scoreId = randomUUID();

    await trx
      .insertInto('scores')
      .values({
        id: scoreId,
        performance_id: input.performanceId,
        judge_id: input.judgeId,
        mark: input.mark,
        remarks: input.remarks ?? null,
        submitted_at: input.submittedAt,
        device_id: input.deviceId ?? null,
        session_id: performance.session_id,
        idempotency_key: input.idempotencyKey,
        judge_weight: Number(assignment.weight),
        is_out_of_sequence: isOutOfSequence,
        entry_mode: input.entryMode ?? 'JUDGE_DEVICE',
        entered_by: input.enteredBy ?? null,
        back_entry_reason: input.backEntryReason ?? null,
      })
      .execute();

    if (criteria.length > 0 && input.criteria) {
      await trx
        .insertInto('score_criteria_values')
        .values(
          input.criteria.map((c) => ({
            score_id: scoreId,
            item_criteria_id: c.itemCriteriaId,
            mark: c.mark,
          })),
        )
        .execute();
    }

    // -------------------------------------------------------------------
    // 7.3: valid := SELECT count(*) FROM scores WHERE performance_id = P
    //                AND revoked = false
    // -------------------------------------------------------------------
    const validScores = await trx
      .selectFrom('scores as s')
      .innerJoin('performance_judges as pj', (join) =>
        join.onRef('pj.performance_id', '=', 's.performance_id').onRef('pj.judge_id', '=', 's.judge_id'),
      )
      .select(['s.judge_id', 's.mark', 's.judge_weight', 'pj.is_chief'])
      .where('s.performance_id', '=', input.performanceId)
      .where('s.revoked', '=', false)
      .execute();

    const submittedCount = validScores.length;
    const panelSize = performance.panel_size;

    let newStatus: PerformanceStatus;
    let aggregate: number | null = null;
    let aggregateMethod: AggregationMethod | null = null;

    if (submittedCount >= panelSize) {
      // 7.3: the performance is COMPLETE and the aggregate is computed and
      // stored. FSD 4.3.7: "A performance is COMPLETE only when every judge on
      // its panel has submitted. Partial scoring never contributes to a result."
      const marks: JudgeMark[] = validScores.map((s) => ({
        judgeId: s.judge_id,
        mark: Number(s.mark),
        weight: Number(s.judge_weight),
        isChief: s.is_chief,
      }));

      const method = (performance.aggregation_method ?? 'AVERAGE') as AggregationMethod;
      const result = computeAggregate(marks, method);

      aggregate = result.value;
      aggregateMethod = result.method;
      newStatus = 'COMPLETE';

      if (result.fallbackNote) {
        logger.warn(
          { performanceId: input.performanceId, note: result.fallbackNote },
          'aggregation fell back to AVERAGE',
        );
      }

      await trx
        .updateTable('performances')
        .set({
          status: 'COMPLETE',
          aggregate_score: aggregate,
          aggregate_method_used: aggregateMethod,
          completed_at: new Date(),
          updated_by: actor.id,
        })
        .where('id', '=', input.performanceId)
        .execute();
    } else {
      newStatus = 'IN_PROGRESS';

      // Only transition when there is something to transition from: re-issuing
      // IN_PROGRESS on an already-IN_PROGRESS row would be a no-op update, and
      // the state-machine trigger (migration 0009) refuses ON_STAGE -> ON_STAGE
      // style churn by treating same-status writes as valid but pointless.
      if (performance.status !== 'IN_PROGRESS') {
        await trx
          .updateTable('performances')
          .set({
            status: 'IN_PROGRESS',
            started_at: new Date(),
            updated_by: actor.id,
          })
          .where('id', '=', input.performanceId)
          .execute();
      }
    }

    // -------------------------------------------------------------------
    // ADM-14-02: score submissions are logged with the device and session id.
    // Written inside the transaction so an unauditable score cannot exist.
    // -------------------------------------------------------------------
    await writeAudit(
      {
        eventId,
        actor,
        action: isOutOfSequence ? AuditAction.SCORE_OUT_OF_SEQUENCE : AuditAction.SCORE_SUBMITTED,
        entityType: 'score',
        entityId: scoreId,
        newValue: {
          performanceId: input.performanceId,
          judgeId: input.judgeId,
          mark: input.mark,
          itemId: performance.item_id,
          itemName: performance.item_name,
          submittedAt: input.submittedAt.toISOString(),
          entryMode: input.entryMode ?? 'JUDGE_DEVICE',
          isOutOfSequence,
        },
        reason: input.backEntryReason ?? null,
        deviceId: input.deviceId ?? null,
        sessionId: performance.session_id,
      },
      trx,
    );

    // -------------------------------------------------------------------
    // 7.3: publish realtime event: progress(P, valid, P.panel_size)
    // Outside the transaction's correctness path — fire-and-forget (FSD 3.3).
    // -------------------------------------------------------------------
    if (performance.session_id) {
      publishScoringProgress(performance.session_id, {
        performanceId: input.performanceId,
        submittedCount,
        panelSize,
        status: newStatus,
        submittedJudgeIds: validScores.map((s) => s.judge_id),
      });

      if (newStatus === 'COMPLETE') {
        publishPerformanceComplete(performance.session_id, input.performanceId, aggregate);
      }
    }

    return {
      scoreId,
      performanceId: input.performanceId,
      mark: input.mark,
      submittedAt: input.submittedAt,
      wasReplay: false,
      performanceStatus: newStatus,
      submittedCount,
      panelSize,
      aggregate,
      isOutOfSequence,
    };
  });
}

/** 7.1: statuses from which a mark may still be accepted. */
const SCORABLE_STATUSES = new Set<PerformanceStatus>(['SCHEDULED', 'ON_STAGE', 'IN_PROGRESS']);

/**
 * JDG-06-05 replay lookup.
 *
 * Returns the original outcome for a key that has already been recorded, so a
 * retried request is indistinguishable from the first from the client's point of
 * view.
 */
async function findByIdempotencyKey(
  idempotencyKey: string,
  executor: Executor = db,
): Promise<SubmitScoreResult | null> {
  const row = await executor
    .selectFrom('scores as s')
    .innerJoin('performances as p', 'p.id', 's.performance_id')
    .select([
      's.id as score_id',
      's.performance_id',
      's.mark',
      's.submitted_at',
      's.is_out_of_sequence',
      'p.status',
      'p.panel_size',
      'p.aggregate_score',
    ])
    .where('s.idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();

  if (!row) return null;

  const { count } = await executor
    .selectFrom('scores')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('performance_id', '=', row.performance_id)
    .where('revoked', '=', false)
    .executeTakeFirstOrThrow();

  return {
    scoreId: row.score_id,
    performanceId: row.performance_id,
    mark: Number(row.mark),
    submittedAt: new Date(row.submitted_at),
    wasReplay: true,
    performanceStatus: row.status,
    submittedCount: Number(count),
    panelSize: row.panel_size,
    aggregate: row.aggregate_score === null ? null : Number(row.aggregate_score),
    isOutOfSequence: row.is_out_of_sequence,
  };
}

/**
 * 4.3.9 / JDG-05-04: every criterion must be supplied, each within its own
 * maximum, and the total must equal the submitted mark.
 */
function validateCriteria(
  defined: { id: string; name: string; max_mark: number }[],
  supplied: { itemCriteriaId: string; mark: number }[],
  totalMark: number,
  decimalPlaces: number,
): void {
  const suppliedById = new Map(supplied.map((c) => [c.itemCriteriaId, c.mark]));

  const missing = defined.filter((c) => !suppliedById.has(c.id));
  if (missing.length > 0) {
    throw errors.validation(
      `This item is scored against criteria and all must be completed. Missing: ${missing
        .map((c) => c.name)
        .join(', ')}.`,
      { missing: missing.map((c) => ({ id: c.id, name: c.name })) },
    );
  }

  const unexpected = supplied.filter((c) => !defined.some((d) => d.id === c.itemCriteriaId));
  if (unexpected.length > 0) {
    throw errors.validation('A mark was supplied for a criterion that does not belong to this item.');
  }

  let total = 0;
  for (const criterion of defined) {
    const mark = suppliedById.get(criterion.id)!;
    const max = Number(criterion.max_mark);
    const check = validateMark(mark, max, decimalPlaces);
    if (!check.valid) {
      throw new AppError(
        ErrorCode.MARK_OUT_OF_RANGE,
        `"${criterion.name}" must be between 0 and ${max}. ${check.reason ?? ''}`.trim(),
        { details: { criterionId: criterion.id, criterion: criterion.name, max } },
      );
    }
    total += mark;
  }

  // Compared with a tolerance rather than by equality: the criteria arrive as
  // separate decimals and their sum accumulates IEEE-754 error, so 8.5 + 1.5
  // can be 9.999999999999998.
  if (Math.abs(total - totalMark) > 1e-9) {
    throw errors.validation(
      `The criterion marks total ${Math.round(total * 1000) / 1000} but the submitted mark is ${totalMark}. They must match.`,
      { criteriaTotal: total, submittedMark: totalMark },
    );
  }
}
