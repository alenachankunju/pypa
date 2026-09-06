/**
 * Item result computation and storage (FSD 7.4, 5.12).
 *
 * Computation is idempotent (FSD 7.7: "Recomputation is idempotent and can be
 * re-run safely at any time"), so this can be called after every completed
 * performance, on demand, or as part of a full-event recompute.
 */
import type { Executor } from '../../db/pool.js';
import { db } from '../../db/pool.js';
import type { ItemResultState } from '../../db/schema.js';
import { errors } from '../../utils/errors.js';
import { rankItemWithGradePoints } from '../scoring/ranking.js';
import type { ItemRankingOutcome, RankedResult, UnresolvedTie } from '../scoring/types.js';
import { loadItemContext, loadRankablePerformances, loadScoringRules } from './context.js';

export interface ComputeItemResultOutcome {
  itemId: string;
  state: ItemResultState;
  results: RankedResult[];
  unresolvedTies: UnresolvedTie[];
  /** 12.1: an item with no participants is auto-cancelled at computation. */
  autoCancelled: boolean;
  /** Present when the item still has pending performances (FSD 7.4 NOT_READY). */
  pending?: { performanceId: string; status: string }[];
}

/**
 * Compute and store the result for one item.
 *
 * @param persist When false, the ranking is returned without writing — used by
 *                ADM-12-08's "what-if" preview, which must be able to show
 *                provisional standings without altering stored results.
 */
export async function computeItemResult(
  itemId: string,
  eventId: string,
  options: { persist?: boolean; actorId?: string | null } = {},
  executor: Executor = db,
): Promise<ComputeItemResultOutcome> {
  const persist = options.persist ?? true;

  const rules = await loadScoringRules(eventId, executor);
  const [context, performances] = await Promise.all([
    loadItemContext(itemId, eventId, rules, executor),
    loadRankablePerformances(itemId, executor),
  ]);

  const outcome: ItemRankingOutcome = rankItemWithGradePoints(performances, context, rules);

  // -----------------------------------------------------------------------
  // 12.1: "An item has no participants — The item is auto-marked cancelled at
  // result computation, contributes no points, and appears in the exceptions
  // report."
  // -----------------------------------------------------------------------
  if (outcome.status === 'NO_PARTICIPANTS') {
    if (persist) {
      await executor.deleteFrom('item_results').where('item_id', '=', itemId).execute();
      await upsertPublication(itemId, eventId, 'READY', false, executor);
      await executor
        .updateTable('items')
        .set({
          status: 'CANCELLED',
          cancelled_reason:
            'No participants were registered for this item. Cancelled automatically at result computation (FSD 12.1).',
          updated_by: options.actorId ?? null,
        })
        .where('id', '=', itemId)
        .where('status', '=', 'ACTIVE')
        .execute();
    }
    return {
      itemId,
      state: 'READY',
      results: [],
      unresolvedTies: [],
      autoCancelled: true,
    };
  }

  // -----------------------------------------------------------------------
  // FSD 7.4: NOT_READY while any performance is not COMPLETE / ABSENT / VOID /
  // WITHDRAWN.
  //
  // Any PREVIOUSLY stored ranking is cleared here, not left in place. It is
  // tempting to think of a partial state as "worse" than a stale complete one,
  // but the opposite is true for a rule this sensitive: a stale row survives
  // exactly the case that matters most — ADM-10-03's revoke, which "returns
  // the affected performance to PARTIAL" precisely so the excluded mark stops
  // counting. If the previously computed row for that performance is left in
  // item_results, the result screen keeps showing it as COMPLETE with its old
  // aggregate — the one figure ADM-10-02 says must be "excluded from all
  // calculations" is exactly the one still on screen. FSD 7.4's own rule is
  // that the WHOLE item is unrankable while any performance is pending, so
  // showing a partial ranking here would be showing something the
  // specification says cannot yet exist.
  // -------------------------------------------------------------------
  if (outcome.status === 'NOT_READY') {
    if (persist) {
      await executor.deleteFrom('item_results').where('item_id', '=', itemId).execute();
      await upsertPublication(itemId, eventId, 'IN_PROGRESS', false, executor);
    }
    return {
      itemId,
      state: 'IN_PROGRESS',
      results: [],
      unresolvedTies: [],
      autoCancelled: false,
      pending: outcome.pending,
    };
  }

  const hasUnresolvedTie = outcome.unresolvedTies.length > 0;

  if (!persist) {
    return {
      itemId,
      state: hasUnresolvedTie ? 'READY' : 'READY',
      results: outcome.results,
      unresolvedTies: outcome.unresolvedTies,
      autoCancelled: false,
    };
  }

  // -----------------------------------------------------------------------
  // Replace the stored rows wholesale.
  //
  // Delete-then-insert rather than a diff: the result set is small, the
  // operation runs inside the caller's transaction, and a partial update is the
  // one outcome that must be impossible here. A stale row left behind from a
  // previous computation would silently award points twice on the leaderboard.
  // -----------------------------------------------------------------------
  await executor.deleteFrom('item_results').where('item_id', '=', itemId).execute();

  if (outcome.results.length > 0) {
    await executor
      .insertInto('item_results')
      .values(
        outcome.results.map((row) => ({
          event_id: eventId,
          item_id: itemId,
          performance_id: row.performanceId,
          registration_id: row.registrationId,
          church_id: row.churchId,
          position: row.position,
          aggregate_score: row.aggregate,
          grade: row.grade,
          points: row.points,
          is_shared_position: row.isSharedPosition,
          tie_break_applied: row.tieBreakApplied,
          tie_break_note: row.tieBreakNote,
          manually_resolved: row.manuallyResolved,
          performance_status: row.performanceStatus,
        })),
      )
      .execute();
  }

  // -----------------------------------------------------------------------
  // 4.8: an item whose performances are all resolved is READY. Publication
  // beyond that is a human action (ADM-12-03), so computation never advances an
  // item to PROVISIONAL or PUBLISHED on its own — and never demotes one that is
  // already published, which would silently un-announce a result.
  // -----------------------------------------------------------------------
  const state = await advanceToReady(itemId, eventId, hasUnresolvedTie, executor);

  return {
    itemId,
    state,
    results: outcome.results,
    unresolvedTies: outcome.unresolvedTies,
    autoCancelled: false,
  };
}

/**
 * Move an item to READY without disturbing a state a human has already set.
 *
 * PROVISIONAL, PUBLISHED and WITHHELD are all operator decisions (4.8); a
 * recomputation triggered by, say, a late absence marking must not knock a
 * published item back to READY behind the administrator's back. Where the stored
 * result genuinely needs to change under a published item, ADM-12-05's explicit
 * unpublish is the route.
 */
async function advanceToReady(
  itemId: string,
  eventId: string,
  hasUnresolvedTie: boolean,
  executor: Executor,
): Promise<ItemResultState> {
  const existing = await executor
    .selectFrom('item_publications')
    .select(['state'])
    .where('item_id', '=', itemId)
    .executeTakeFirst();

  const humanControlled: ItemResultState[] = ['PROVISIONAL', 'PUBLISHED', 'WITHHELD'];
  const nextState: ItemResultState =
    existing && humanControlled.includes(existing.state) ? existing.state : 'READY';

  await upsertPublication(itemId, eventId, nextState, hasUnresolvedTie, executor);
  return nextState;
}

/**
 * PUBLISHED and WITHHELD each carry a CHECK constraint tied to columns this
 * function doesn't set (published_by/published_at, withheld_reason). Postgres
 * validates an INSERT's proposed row against every CHECK constraint before it
 * even attempts conflict resolution (ExecConstraints runs ahead of
 * ExecCheckIndexConstraints) — so on `INSERT ... ON CONFLICT DO UPDATE`, using
 * the real target state as the INSERT candidate fails here even when a
 * conflicting row already exists and the UPDATE branch would have produced a
 * fully valid result untouched on those columns. This was a real, reproducible
 * production bug: recomputing (simply viewing) an already-published item's
 * results threw exactly this error on every call, because advanceToReady only
 * ever asks for PUBLISHED/WITHHELD when a row already exists — so the ON
 * CONFLICT branch was always the one meant to fire, but Postgres never got
 * that far. READY is unconditionally constraint-safe, and is never actually
 * committed in this case since a conflict always resolves first.
 */
async function upsertPublication(
  itemId: string,
  eventId: string,
  state: ItemResultState,
  hasUnresolvedTie: boolean,
  executor: Executor,
): Promise<void> {
  const insertSafeState: ItemResultState = state === 'PUBLISHED' || state === 'WITHHELD' ? 'READY' : state;

  await executor
    .insertInto('item_publications')
    .values({
      event_id: eventId,
      item_id: itemId,
      state: insertSafeState,
      has_unresolved_tie: hasUnresolvedTie,
      last_computed_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column('item_id').doUpdateSet({
        state,
        has_unresolved_tie: hasUnresolvedTie,
        last_computed_at: new Date(),
      }),
    )
    .execute();
}

/**
 * Read a stored item result for display (ADM-12-01).
 *
 * "Ranked list showing position, chest number, member name, church name, each
 * judge's individual mark, the aggregate, the grade, and the points awarded."
 *
 * The per-judge breakdown is included, which is why this is an ADMIN-only read
 * path. FSD 6.9 forbids a judge from seeing any other judge's mark, so nothing
 * in the judge namespace may call this.
 */
export interface ItemResultRow {
  position: number | null;
  placed: boolean;
  performanceId: string;
  registrationId: string;
  chestNumber: string | null;
  participantName: string;
  teamMembers: { chestNumber: string; fullName: string }[] | null;
  churchId: string | null;
  churchName: string | null;
  churchShortCode: string | null;
  aggregate: number | null;
  grade: string | null;
  points: number;
  isSharedPosition: boolean;
  tieBreakApplied: string | null;
  tieBreakNote: string | null;
  manuallyResolved: boolean;
  performanceStatus: string;
  attemptNo: number;
  isLateEntry: boolean;
  judgeMarks: { judgeId: string; judgeName: string; mark: number; isChief: boolean; remarks: string | null }[];
}

export async function getItemResult(
  itemId: string,
  executor: Executor = db,
): Promise<{
  item: { id: string; name: string; code: string; maxMark: number | null; type: string };
  publication: { state: ItemResultState; hasUnresolvedTie: boolean; publishedAt: Date | null };
  rows: ItemResultRow[];
}> {
  const item = await executor
    .selectFrom('items')
    .select(['id', 'name', 'code', 'max_mark', 'type'])
    .where('id', '=', itemId)
    .executeTakeFirst();

  if (!item) throw errors.notFound('Item', itemId);

  const [publication, resultRows, judgeMarks, teamMembers] = await Promise.all([
    executor
      .selectFrom('item_publications')
      .select(['state', 'has_unresolved_tie', 'published_at'])
      .where('item_id', '=', itemId)
      .executeTakeFirst(),

    executor
      .selectFrom('item_results as ir')
      .innerJoin('performances as p', 'p.id', 'ir.performance_id')
      .innerJoin('registrations as r', 'r.id', 'ir.registration_id')
      .leftJoin('members as m', 'm.id', 'r.member_id')
      .leftJoin('churches as c', 'c.id', 'ir.church_id')
      .select([
        'ir.position',
        'ir.performance_id',
        'ir.registration_id',
        'ir.aggregate_score',
        'ir.grade',
        'ir.points',
        'ir.is_shared_position',
        'ir.tie_break_applied',
        'ir.tie_break_note',
        'ir.manually_resolved',
        'ir.performance_status',
        'ir.church_id',
        'p.attempt_no',
        'r.team_name',
        'r.is_late_entry',
        'm.chest_number',
        'm.full_name as member_name',
        'c.name as church_name',
        'c.short_code as church_short_code',
      ])
      .where('ir.item_id', '=', itemId)
      .orderBy('ir.position', 'asc')
      .orderBy('ir.aggregate_score', 'desc')
      .execute(),

    executor
      .selectFrom('scores as s')
      .innerJoin('performances as p', 'p.id', 's.performance_id')
      .innerJoin('users as u', 'u.id', 's.judge_id')
      .leftJoin('performance_judges as pj', (join) =>
        join
          .onRef('pj.performance_id', '=', 's.performance_id')
          .onRef('pj.judge_id', '=', 's.judge_id'),
      )
      .select([
        's.performance_id',
        's.judge_id',
        's.mark',
        's.remarks',
        'u.full_name as judge_name',
        'pj.is_chief',
      ])
      .where('p.item_id', '=', itemId)
      .where('s.revoked', '=', false)
      .orderBy('u.full_name')
      .execute(),

    executor
      .selectFrom('registration_members as rm')
      .innerJoin('members as m', 'm.id', 'rm.member_id')
      .select(['rm.registration_id', 'm.chest_number', 'm.full_name'])
      .where('rm.item_id', '=', itemId)
      .orderBy('rm.is_team_leader', 'desc')
      .orderBy('m.chest_number')
      .execute(),
  ]);

  const marksByPerformance = new Map<string, ItemResultRow['judgeMarks']>();
  for (const m of judgeMarks) {
    const list = marksByPerformance.get(m.performance_id) ?? [];
    list.push({
      judgeId: m.judge_id,
      judgeName: m.judge_name,
      mark: Number(m.mark),
      isChief: Boolean(m.is_chief),
      remarks: m.remarks,
    });
    marksByPerformance.set(m.performance_id, list);
  }

  const teamsByRegistration = new Map<string, { chestNumber: string; fullName: string }[]>();
  for (const tm of teamMembers) {
    const list = teamsByRegistration.get(tm.registration_id) ?? [];
    list.push({ chestNumber: tm.chest_number, fullName: tm.full_name });
    teamsByRegistration.set(tm.registration_id, list);
  }

  // The highest position for which points are configured, so the report layer
  // can render an em dash beyond it exactly as FSD 7.5 does.
  const maxPlaced = Math.max(
    0,
    ...resultRows.filter((r) => Number(r.points) > 0).map((r) => r.position ?? 0),
  );

  const rows: ItemResultRow[] = resultRows.map((row) => ({
    position: row.position,
    placed: row.position !== null && row.position <= maxPlaced,
    performanceId: row.performance_id,
    registrationId: row.registration_id,
    chestNumber: row.chest_number,
    participantName: row.member_name ?? row.team_name ?? 'Unknown',
    teamMembers: teamsByRegistration.get(row.registration_id) ?? null,
    churchId: row.church_id,
    churchName: row.church_name,
    churchShortCode: row.church_short_code,
    aggregate: row.aggregate_score === null ? null : Number(row.aggregate_score),
    grade: row.grade,
    points: Number(row.points),
    isSharedPosition: row.is_shared_position,
    tieBreakApplied: row.tie_break_applied,
    tieBreakNote: row.tie_break_note,
    manuallyResolved: row.manually_resolved,
    performanceStatus: row.performance_status,
    attemptNo: row.attempt_no,
    isLateEntry: row.is_late_entry,
    judgeMarks: marksByPerformance.get(row.performance_id) ?? [],
  }));

  return {
    item: {
      id: item.id,
      name: item.name,
      code: item.code,
      maxMark: item.max_mark === null ? null : Number(item.max_mark),
      type: item.type,
    },
    publication: {
      state: publication?.state ?? 'IN_PROGRESS',
      hasUnresolvedTie: publication?.has_unresolved_tie ?? false,
      publishedAt: publication?.published_at ?? null,
    },
    rows,
  };
}
