/**
 * Loading the inputs the ranking engine needs.
 *
 * The engine in src/services/scoring is pure — it has no database access at all.
 * This module is the boundary: it reads the event's configuration, an item's
 * settings and its performances, and hands the engine plain data.
 */
import type { Executor } from '../../db/pool.js';
import { db, parsePgTextArray } from '../../db/pool.js';
import type { TiebreakCriterion } from '../../db/schema.js';
import { errors } from '../../utils/errors.js';
import type {
  GradeBandSpec,
  ItemRankingContext,
  JudgeMark,
  ManualTieDecision,
  PositionPointsMap,
  RankablePerformance,
  ScoringRules,
} from '../scoring/types.js';

/**
 * Resolve the scoring rules in force for an event.
 *
 * Falls back to the FSD 18.2 defaults where no scoring_config row exists yet, so
 * a provisional result can be previewed during setup before step 5 of the FSD 13
 * sequence has been completed.
 */
export async function loadScoringRules(
  eventId: string,
  executor: Executor = db,
): Promise<ScoringRules> {
  const [config, bands] = await Promise.all([
    executor
      .selectFrom('scoring_config')
      .selectAll()
      .where('event_id', '=', eventId)
      .executeTakeFirst(),
    executor
      .selectFrom('grade_bands')
      .select(['grade', 'min_percentage', 'points'])
      .where('event_id', '=', eventId)
      .orderBy('min_percentage', 'desc')
      .execute(),
  ]);

  const gradeBands: GradeBandSpec[] = bands.map((b) => ({
    grade: b.grade,
    minPercentage: Number(b.min_percentage),
    points: Number(b.points),
  }));

  return {
    maxMark: Number(config?.max_mark ?? 10),
    decimalPlaces: Number(config?.decimal_places ?? 1),
    aggregationMethod: config?.aggregation_method ?? 'AVERAGE',
    allowSharedPositions: config?.allow_shared_positions ?? false,
    tiebreakOrder: config?.tiebreak_order
      ? (parsePgTextArray(config.tiebreak_order) as TiebreakCriterion[])
      : ['JUDGE_TOP_MARK_COUNT', 'HIGHEST_SINGLE_MARK', 'LOWEST_SPREAD', 'CHIEF_JUDGE_MARK'],
    gradePointsEnabled: config?.grade_points_enabled ?? false,
    gradeBands,
    walkoverMinAggregate:
      config?.walkover_min_aggregate === null || config?.walkover_min_aggregate === undefined
        ? null
        : Number(config.walkover_min_aggregate),
  };
}

/**
 * Build the per-item ranking context.
 *
 * ADM-11-04 allows per-item point overrides. Those are merged over the event
 * defaults here, position by position, so an item can override first place while
 * inheriting second and third.
 */
export async function loadItemContext(
  itemId: string,
  eventId: string,
  rules: ScoringRules,
  executor: Executor = db,
): Promise<ItemRankingContext> {
  const item = await executor
    .selectFrom('items')
    .select(['id', 'max_mark', 'weight_multiplier', 'name'])
    .where('id', '=', itemId)
    .executeTakeFirst();

  if (!item) throw errors.notFound('Item', itemId);

  const [pointRows, decisionRows] = await Promise.all([
    executor
      .selectFrom('position_points')
      .select(['item_id', 'position', 'points'])
      .where('event_id', '=', eventId)
      .where((eb) => eb.or([eb('item_id', 'is', null), eb('item_id', '=', itemId)]))
      .execute(),
    executor
      .selectFrom('manual_tie_decisions')
      .select(['performance_id', 'assigned_position', 'declared_shared', 'reason'])
      .where('item_id', '=', itemId)
      .where('superseded_at', 'is', null)
      .execute(),
  ]);

  const positionPoints: PositionPointsMap = {};
  // Event defaults first, then per-item overrides on top.
  for (const row of pointRows.filter((r) => r.item_id === null)) {
    positionPoints[row.position] = Number(row.points);
  }
  for (const row of pointRows.filter((r) => r.item_id !== null)) {
    positionPoints[row.position] = Number(row.points);
  }

  const manualDecisions: ManualTieDecision[] = decisionRows.map((d) => ({
    performanceId: d.performance_id,
    assignedPosition: d.assigned_position,
    declaredShared: d.declared_shared,
    reason: d.reason,
  }));

  return {
    itemId,
    maxMark: Number(item.max_mark ?? rules.maxMark),
    weightMultiplier: Number(item.weight_multiplier),
    positionPoints,
    manualDecisions,
  };
}

/**
 * Load an item's performances with their valid marks.
 *
 * ADM-10-02: revoked scores are "excluded from all calculations", so the join
 * filters them out here rather than anywhere downstream — the ranking engine
 * never sees a revoked mark at all.
 *
 * Performances are read in one query with their marks aggregated as JSON, rather
 * than as a query per performance. FSD 11.1 budgets 10 seconds for a full-event
 * recomputation, and an N+1 across several hundred items would not meet it.
 */
export async function loadRankablePerformances(
  itemId: string,
  executor: Executor = db,
): Promise<RankablePerformance[]> {
  // Two flat queries joined in memory, rather than one query with a correlated
  // JSON aggregate. An item holds tens of performances and low hundreds of
  // marks, so the join costs nothing measurable, and the resulting SQL is
  // simple enough to read in a query plan when the 10-second full-event budget
  // (FSD 11.1) needs checking.
  const [performances, marks] = await Promise.all([
    executor
      .selectFrom('performances as p')
      .innerJoin('registrations as r', 'r.id', 'p.registration_id')
      .select([
        'p.id as performance_id',
        'p.registration_id',
        'p.status',
        'p.aggregate_score',
        'r.church_id',
      ])
      .where('p.item_id', '=', itemId)
      // WITHDRAWN and ABSENT performances are kept: FSD 7.1 requires them on the
      // result sheet with their status, so nothing is filtered by status here.
      .orderBy('p.call_order')
      .orderBy('p.created_at')
      .execute(),

    executor
      .selectFrom('scores as s')
      .innerJoin('performances as p', 'p.id', 's.performance_id')
      .innerJoin('performance_judges as pj', (join) =>
        join
          .onRef('pj.performance_id', '=', 's.performance_id')
          .onRef('pj.judge_id', '=', 's.judge_id'),
      )
      .select([
        's.performance_id',
        's.judge_id',
        's.mark',
        's.judge_weight',
        'pj.is_chief',
      ])
      .where('p.item_id', '=', itemId)
      // ADM-10-02: revoked scores are excluded from all calculations. Filtering
      // here means the ranking engine never sees one.
      .where('s.revoked', '=', false)
      .execute(),
  ]);

  const marksByPerformance = new Map<string, JudgeMark[]>();
  for (const mark of marks) {
    const list = marksByPerformance.get(mark.performance_id);
    const entry: JudgeMark = {
      judgeId: mark.judge_id,
      mark: Number(mark.mark),
      weight: Number(mark.judge_weight),
      isChief: mark.is_chief,
    };
    if (list) list.push(entry);
    else marksByPerformance.set(mark.performance_id, [entry]);
  }

  return performances.map((row) => ({
    performanceId: row.performance_id,
    registrationId: row.registration_id,
    churchId: row.church_id,
    status: row.status,
    aggregate: row.aggregate_score === null ? null : Number(row.aggregate_score),
    marks: marksByPerformance.get(row.performance_id) ?? [],
  }));
}
