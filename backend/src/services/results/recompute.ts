/**
 * Recomputation and the change report (FSD 7.7).
 *
 * "Any change that could affect a result — a revoked score, a re-entered mark, a
 * voided performance, an unpublished item, a configuration change — triggers
 * recomputation of the affected item, then of all church and championship
 * totals."
 *
 * "After any recomputation the system reports what changed, listing every
 * position that moved, so that the committee is never surprised."
 *
 * That last sentence is the reason this module exists rather than callers simply
 * invoking computeItemResult. A recomputation without a diff is a silent change,
 * and a silent change to an announced result is precisely the failure the whole
 * publication lifecycle is designed to prevent.
 */
import type { Executor } from '../../db/pool.js';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { AuditAction, writeAudit, type AuditActor } from '../audit.js';
import { computeItemResult } from './itemResults.js';

/** One position that moved, as printed on the change report. */
export interface PositionChange {
  itemId: string;
  itemName: string;
  performanceId: string;
  chestNumber: string | null;
  participantName: string;
  churchName: string | null;
  from: number | null;
  to: number | null;
  pointsFrom: number;
  pointsTo: number;
}

export interface RecomputeResult {
  runId: string;
  scope: 'ITEM' | 'EVENT';
  itemsProcessed: number;
  durationMs: number;
  changes: PositionChange[];
  /** Items that could not be ranked because performances are still pending. */
  notReady: { itemId: string; itemName: string; pendingCount: number }[];
  /** Items blocked by a tie the sequence could not break (FSD 4.5.5). */
  unresolvedTies: { itemId: string; itemName: string; performanceIds: string[] }[];
}

/** What prompted the recomputation. Recorded so the trail explains itself. */
export type RecomputeTrigger =
  | 'SCORE_SUBMITTED'
  | 'SCORE_REVOKED'
  | 'PERFORMANCE_VOIDED'
  | 'PERFORMANCE_ABSENT'
  | 'RESULT_UNPUBLISHED'
  | 'CONFIG_CHANGED'
  | 'TIE_RESOLVED'
  | 'MANUAL';

/**
 * Recompute one item and report what moved.
 *
 * Called after every event that can change a ranking. Cheap enough to run on
 * each completed performance: an item holds tens of rows, and the whole
 * operation is one transaction.
 */
export async function recomputeItem(
  itemId: string,
  eventId: string,
  trigger: RecomputeTrigger,
  actor: AuditActor,
  reason?: string,
): Promise<RecomputeResult> {
  return runRecompute([itemId], eventId, 'ITEM', trigger, actor, reason);
}

/**
 * ADM-15 / FSD 7.7: "A manual 'recalculate everything' action is available to
 * Super Admin and is logged."
 *
 * FSD 11.1 budgets 10 seconds for a full-event recomputation. Items are
 * processed sequentially inside one transaction so the result set is never
 * observed half-updated — a leaderboard read mid-recompute would otherwise show
 * some items counted twice and others not at all.
 */
export async function recomputeEvent(
  eventId: string,
  trigger: RecomputeTrigger,
  actor: AuditActor,
  reason?: string,
): Promise<RecomputeResult> {
  const items = await db
    .selectFrom('items')
    .select('id')
    .where('event_id', '=', eventId)
    .where('status', '=', 'ACTIVE')
    .orderBy('display_order')
    .execute();

  return runRecompute(
    items.map((i) => i.id),
    eventId,
    'EVENT',
    trigger,
    actor,
    reason,
  );
}

async function runRecompute(
  itemIds: string[],
  eventId: string,
  scope: 'ITEM' | 'EVENT',
  trigger: RecomputeTrigger,
  actor: AuditActor,
  reason?: string,
): Promise<RecomputeResult> {
  const startedAt = Date.now();

  return db.transaction().execute(async (trx) => {
    // ------------------------------------------------------------------
    // Snapshot before. Only positions and points are captured — those are the
    // figures a committee announces and therefore the ones whose movement must
    // be reported.
    // ------------------------------------------------------------------
    const before = await snapshotPositions(itemIds, trx);

    const notReady: RecomputeResult['notReady'] = [];
    const unresolvedTies: RecomputeResult['unresolvedTies'] = [];

    for (const itemId of itemIds) {
      const outcome = await computeItemResult(itemId, eventId, { actorId: actor.id }, trx);

      if (outcome.state === 'IN_PROGRESS' && outcome.pending?.length) {
        const name = await itemName(itemId, trx);
        notReady.push({ itemId, itemName: name, pendingCount: outcome.pending.length });
      }
      if (outcome.unresolvedTies.length > 0) {
        const name = await itemName(itemId, trx);
        for (const tie of outcome.unresolvedTies) {
          unresolvedTies.push({ itemId, itemName: name, performanceIds: tie.performanceIds });
        }
      }
    }

    const after = await snapshotPositions(itemIds, trx);
    const changes = diffPositions(before, after);

    const durationMs = Date.now() - startedAt;

    const run = await trx
      .insertInto('recompute_runs')
      .values({
        event_id: eventId,
        scope,
        item_id: scope === 'ITEM' ? (itemIds[0] ?? null) : null,
        trigger,
        reason: reason ?? null,
        finished_at: new Date(),
        duration_ms: durationMs,
        changes: JSON.stringify(changes) as never,
        changed_count: changes.length,
        triggered_by: actor.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Only worth an audit entry when something actually moved, or when a human
    // asked for it. Recomputation runs constantly during scoring, and logging
    // every no-op would bury the entries that matter (ADM-14-04 searchability).
    if (changes.length > 0 || trigger === 'MANUAL' || trigger === 'CONFIG_CHANGED') {
      await writeAudit(
        {
          eventId,
          actor,
          action: AuditAction.RECOMPUTED,
          entityType: scope === 'ITEM' ? 'item' : 'event',
          entityId: scope === 'ITEM' ? (itemIds[0] ?? null) : eventId,
          newValue: {
            trigger,
            itemsProcessed: itemIds.length,
            changedCount: changes.length,
            durationMs,
            runId: run.id,
          },
          reason: reason ?? null,
        },
        trx,
      );
    }

    if (durationMs > 10_000) {
      // FSD 11.1: "Result recomputation, full event — Under 10 seconds."
      logger.warn(
        { durationMs, itemCount: itemIds.length, scope },
        'recomputation exceeded the FSD 11.1 budget of 10 seconds',
      );
    }

    return {
      runId: run.id,
      scope,
      itemsProcessed: itemIds.length,
      durationMs,
      changes,
      notReady,
      unresolvedTies,
    };
  });
}

interface PositionSnapshot {
  key: string;
  itemId: string;
  itemName: string;
  performanceId: string;
  chestNumber: string | null;
  participantName: string;
  churchName: string | null;
  position: number | null;
  points: number;
}

async function snapshotPositions(
  itemIds: string[],
  executor: Executor,
): Promise<Map<string, PositionSnapshot>> {
  if (itemIds.length === 0) return new Map();

  const rows = await executor
    .selectFrom('item_results as ir')
    .innerJoin('items as i', 'i.id', 'ir.item_id')
    .innerJoin('registrations as r', 'r.id', 'ir.registration_id')
    .leftJoin('members as m', 'm.id', 'r.member_id')
    .leftJoin('churches as c', 'c.id', 'ir.church_id')
    .select([
      'ir.item_id',
      'ir.performance_id',
      'ir.position',
      'ir.points',
      'i.name as item_name',
      'm.chest_number',
      'm.full_name as member_name',
      'r.team_name',
      'c.name as church_name',
    ])
    .where('ir.item_id', 'in', itemIds)
    .execute();

  return new Map(
    rows.map((row) => {
      const key = `${row.item_id}:${row.performance_id}`;
      return [
        key,
        {
          key,
          itemId: row.item_id,
          itemName: row.item_name,
          performanceId: row.performance_id,
          chestNumber: row.chest_number,
          participantName: row.member_name ?? row.team_name ?? 'Unknown',
          churchName: row.church_name,
          position: row.position,
          points: Number(row.points),
        },
      ];
    }),
  );
}

/**
 * FSD 7.7: "listing every position that moved".
 *
 * A row that appears or disappears is reported too — a newly ranked performance
 * (from null) or one removed by a void (to null) is a movement the committee
 * needs to see just as much as a swap between second and third.
 */
function diffPositions(
  before: Map<string, PositionSnapshot>,
  after: Map<string, PositionSnapshot>,
): PositionChange[] {
  const changes: PositionChange[] = [];

  for (const [key, next] of after) {
    const prior = before.get(key);
    const positionMoved = (prior?.position ?? null) !== next.position;
    const pointsMoved = (prior?.points ?? 0) !== next.points;

    if (positionMoved || pointsMoved) {
      changes.push({
        itemId: next.itemId,
        itemName: next.itemName,
        performanceId: next.performanceId,
        chestNumber: next.chestNumber,
        participantName: next.participantName,
        churchName: next.churchName,
        from: prior?.position ?? null,
        to: next.position,
        pointsFrom: prior?.points ?? 0,
        pointsTo: next.points,
      });
    }
  }

  // Rows that vanished entirely, for example when a performance was voided.
  for (const [key, prior] of before) {
    if (!after.has(key)) {
      changes.push({
        itemId: prior.itemId,
        itemName: prior.itemName,
        performanceId: prior.performanceId,
        chestNumber: prior.chestNumber,
        participantName: prior.participantName,
        churchName: prior.churchName,
        from: prior.position,
        to: null,
        pointsFrom: prior.points,
        pointsTo: 0,
      });
    }
  }

  return changes.sort(
    (a, b) => a.itemName.localeCompare(b.itemName) || (a.to ?? 999) - (b.to ?? 999),
  );
}

async function itemName(itemId: string, executor: Executor): Promise<string> {
  const row = await executor
    .selectFrom('items')
    .select('name')
    .where('id', '=', itemId)
    .executeTakeFirst();
  return row?.name ?? 'Unknown item';
}

/** Recent recomputation history, for the change-report screen. */
export async function recentRecomputeRuns(eventId: string, limit = 20) {
  return db
    .selectFrom('recompute_runs as rr')
    .leftJoin('users as u', 'u.id', 'rr.triggered_by')
    .select([
      'rr.id',
      'rr.scope',
      'rr.item_id',
      'rr.trigger',
      'rr.reason',
      'rr.started_at',
      'rr.duration_ms',
      'rr.changed_count',
      'rr.changes',
      'u.full_name as triggered_by_name',
    ])
    .where('rr.event_id', '=', eventId)
    .orderBy('rr.started_at', 'desc')
    .limit(limit)
    .execute();
}
