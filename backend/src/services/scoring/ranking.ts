/**
 * The item ranking algorithm (FSD 7.4).
 *
 * This is a direct implementation of the pseudocode in 7.4, with the tie-break
 * recursion made explicit and every edge case from 12.1 handled by name. It is a
 * pure function: same inputs, same outputs, no clock, no database. AC-09
 * requires that the worked example in FSD 7.5 "reproduces exactly", and that is
 * asserted as a unit test against this function.
 *
 * A note on section 4.6 versus 7.4. The prose in 4.6 can be read as saying that
 * when shared positions are permitted, tied performances simply share a position.
 * The pseudocode in 7.4 is explicit that the tie-break sequence runs FIRST and
 * allow_shared_positions governs only what remains tied afterwards. The
 * pseudocode is the algorithm and is implemented here; 4.6 is describing the
 * outcome, not the order of operations.
 */
import { AGGREGATE_PRECISION, roundTo } from './aggregate.js';
import { gradeFor } from './grades.js';
import { buildTiebreakContext, describeTiebreak, resolveTieGroup, type TiebreakGroup } from './tiebreak.js';
import type {
  ItemRankingContext,
  ItemRankingOutcome,
  RankablePerformance,
  RankedResult,
  ScoringRules,
  UnresolvedTie,
} from './types.js';

/** Statuses that count as resolved for the purposes of FSD 7.4's readiness gate. */
const RESOLVED_STATUSES = new Set(['COMPLETE', 'ABSENT', 'VOID', 'WITHDRAWN']);

export function rankItem(
  performances: RankablePerformance[],
  item: ItemRankingContext,
  rules: ScoringRules,
): ItemRankingOutcome {
  // --- 12.1: "An item has no participants" ---------------------------------
  // "The item is auto-marked cancelled at result computation, contributes no
  // points, and appears in the exceptions report."
  if (performances.length === 0) {
    return { status: 'NO_PARTICIPANTS' };
  }

  // --- 7.4 readiness gate --------------------------------------------------
  // "IF any P in I is not in (COMPLETE, ABSENT, VOID, WITHDRAWN): return NOT_READY"
  const pending = performances
    .filter((p) => !RESOLVED_STATUSES.has(p.status))
    .map((p) => ({ performanceId: p.performanceId, status: p.status }));

  if (pending.length > 0) {
    return { status: 'NOT_READY', pending };
  }

  // --- Partition ------------------------------------------------------------
  // 7.1: "Only performances in COMPLETE state are included in ranking. ABSENT,
  // VOID and WITHDRAWN performances appear on the result sheet with their status
  // but receive no position and no points."
  const complete = performances.filter((p) => p.status === 'COMPLETE');
  const unranked = performances.filter((p) => p.status !== 'COMPLETE');

  const results: RankedResult[] = [];
  const unresolvedTies: UnresolvedTie[] = [];

  // --- 12.1: "An item has only one participant" ----------------------------
  // "The participant is ranked first if a minimum-score threshold is met, or
  // awarded no position if the administrator has configured a walkover rule
  // requiring a minimum aggregate."
  const soleParticipant = complete.length === 1 ? complete[0] : undefined;
  const walkoverFailed =
    soleParticipant !== undefined &&
    rules.walkoverMinAggregate !== null &&
    (soleParticipant.aggregate ?? 0) < rules.walkoverMinAggregate;

  if (soleParticipant && walkoverFailed) {
    results.push({
      ...baseResult(soleParticipant, item, rules),
      position: null,
      placed: false,
      points: 0,
      tieBreakNote:
        `Walkover: the only participant scored ${soleParticipant.aggregate}, below the ` +
        `configured minimum of ${rules.walkoverMinAggregate} (FSD 12.1). No position awarded.`,
    });
    results.push(...unranked.map((p) => unrankedResult(p, item, rules)));
    return { status: 'RANKED', results, unresolvedTies };
  }

  // --- Sort and group by aggregate -----------------------------------------
  // "sort performances by aggregate DESC; group into tie-groups of equal aggregate"
  const sorted = [...complete].sort(
    (a, b) => normalisedAggregate(b) - normalisedAggregate(a),
  );

  const tieGroups: RankablePerformance[][] = [];
  for (const performance of sorted) {
    const currentGroup = tieGroups[tieGroups.length - 1];
    const lastMember = currentGroup?.[0];
    if (
      currentGroup &&
      lastMember &&
      normalisedAggregate(lastMember) === normalisedAggregate(performance)
    ) {
      currentGroup.push(performance);
    } else {
      tieGroups.push([performance]);
    }
  }

  // --- Apply the tie-break sequence to each group ---------------------------
  const context = buildTiebreakContext(complete);
  const orderedGroups: TiebreakGroup[] = [];

  for (const group of tieGroups) {
    if (group.length === 1) {
      orderedGroups.push({ performances: group, separatedBy: null, criteriaApplied: [] });
    } else {
      orderedGroups.push(...resolveTieGroup(group, rules.tiebreakOrder, context));
    }
  }

  // --- Assign positions ----------------------------------------------------
  let position = 1;

  for (const group of orderedGroups) {
    const isUnresolvedTie = group.performances.length > 1;

    if (isUnresolvedTie) {
      if (rules.allowSharedPositions) {
        // 4.6: "two participants tied for first are both awarded first place,
        // both receive the full first-place points, and no second place is
        // awarded (the next participant is third)."
        for (const performance of group.performances) {
          results.push({
            ...baseResult(performance, item, rules),
            position,
            placed: isPlaced(position, item),
            points: pointsFor(position, item),
            isSharedPosition: true,
            tieBreakApplied: group.separatedBy,
            tieBreakNote:
              `Shared position ${position}: the tie-break sequence could not separate these ` +
              `performances and shared positions are permitted (FSD 4.6).`,
          });
        }
      } else {
        // 4.5: "the system does not guess. It raises the item to the
        // administrator with a clear 'tie requires decision' flag."
        unresolvedTies.push({
          aggregate: normalisedAggregate(group.performances[0]!),
          position,
          performanceIds: group.performances.map((p) => p.performanceId),
          criteriaApplied: group.criteriaApplied,
        });

        for (const performance of group.performances) {
          results.push({
            ...baseResult(performance, item, rules),
            position,
            placed: isPlaced(position, item),
            // No points are awarded until the tie is decided: publishing is
            // blocked anyway (ADM-12-02), and awarding provisional points would
            // make the leaderboard preview wrong.
            points: 0,
            isSharedPosition: false,
            tieBreakApplied: group.separatedBy,
            tieBreakNote:
              `Unresolved tie at position ${position}. Criteria applied without separation: ` +
              `${group.criteriaApplied.join(', ') || 'none configured'}. ` +
              `An administrator must decide this tie before the result can be published (FSD 4.5).`,
          });
        }
      }
      // "skip the next position(s)" — a shared 1st with two entrants means the
      // next performance is 3rd, not 2nd.
      position += group.performances.length;
    } else {
      const performance = group.performances[0]!;
      results.push({
        ...baseResult(performance, item, rules),
        position,
        placed: isPlaced(position, item),
        points: pointsFor(position, item),
        tieBreakApplied: group.separatedBy,
        tieBreakNote: describeTiebreak(group.separatedBy),
      });
      position += 1;
    }
  }

  // --- Non-ranked performances (7.1) ---------------------------------------
  results.push(...unranked.map((p) => unrankedResult(p, item, rules)));

  // --- Administrator tie decisions (4.5.5) ---------------------------------
  const withDecisions = applyManualDecisions(results, item, rules);

  // A tie group whose every member now carries an administrator decision is no
  // longer unresolved, and must stop blocking publication (ADM-12-02).
  const decidedIds = new Set((item.manualDecisions ?? []).map((d) => d.performanceId));
  const stillUnresolved = unresolvedTies.filter(
    (tie) => !tie.performanceIds.every((id) => decidedIds.has(id)),
  );

  return { status: 'RANKED', results: withDecisions, unresolvedTies: stillUnresolved };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Aggregate at storage precision, so tie detection is deterministic. */
function normalisedAggregate(performance: RankablePerformance): number {
  return roundTo(performance.aggregate ?? 0, AGGREGATE_PRECISION);
}

/**
 * Fields common to every result row.
 *
 * Grade is computed here for EVERY complete performance, not only placed ones.
 * FSD 7.4's pseudocode computes it inside the positioned loop, but the worked
 * example in 7.5 shows the fourth-placed participant with a grade of B and an em
 * dash for position — so grade genuinely is "independent of position" as the
 * glossary states, and the example is the clearer authority.
 */
function baseResult(
  performance: RankablePerformance,
  item: ItemRankingContext,
  rules: ScoringRules,
): RankedResult {
  const graded = gradeFor(performance.aggregate, item.maxMark, rules.gradeBands);

  return {
    performanceId: performance.performanceId,
    registrationId: performance.registrationId,
    churchId: performance.churchId,
    performanceStatus: performance.status,
    position: null,
    placed: false,
    aggregate: performance.aggregate,
    grade: graded?.grade ?? null,
    points: 0,
    isSharedPosition: false,
    tieBreakApplied: null,
    tieBreakNote: null,
    manuallyResolved: false,
  };
}

/** ABSENT / VOID / WITHDRAWN — on the sheet, but with no position and no points. */
function unrankedResult(
  performance: RankablePerformance,
  item: ItemRankingContext,
  rules: ScoringRules,
): RankedResult {
  return {
    ...baseResult(performance, item, rules),
    grade: null,
    position: null,
    placed: false,
    points: 0,
  };
}

/** Highest position for which points are configured (ADM-11-03: any number). */
function maxConfiguredPosition(item: ItemRankingContext): number {
  const positions = Object.keys(item.positionPoints).map(Number).filter(Number.isFinite);
  return positions.length > 0 ? Math.max(...positions) : 0;
}

function isPlaced(position: number, item: ItemRankingContext): boolean {
  return position <= maxConfiguredPosition(item);
}

/**
 * Points for a position.
 *
 * 4.7.1: position points are configured per position and may be overridden per
 * item. 4.7.2: "Items may carry a weight multiplier (default 1.0). A group item
 * weighted 2.0 awards double points."
 */
function pointsFor(position: number, item: ItemRankingContext): number {
  const base = item.positionPoints[position];
  if (base === undefined) return 0;
  return roundTo(base * item.weightMultiplier, 3);
}

/**
 * Overlay administrator tie decisions (FSD 4.5.5, ADM-12-02, API resolve-tie).
 *
 * A decision names a performance and the position it is to take. Points are
 * recomputed from that position, so a decision moving someone from a blocked tie
 * at 1st into 2nd awards second-place points automatically. Rows are re-sorted
 * so the result sheet reads in position order.
 */
function applyManualDecisions(
  results: RankedResult[],
  item: ItemRankingContext,
  rules: ScoringRules,
): RankedResult[] {
  const decisions = item.manualDecisions ?? [];
  if (decisions.length === 0) return sortResults(results);

  const byPerformance = new Map(decisions.map((d) => [d.performanceId, d]));

  const updated = results.map((row): RankedResult => {
    const decision = byPerformance.get(row.performanceId);
    if (!decision) return row;

    return {
      ...row,
      position: decision.assignedPosition,
      placed: isPlaced(decision.assignedPosition, item),
      points: pointsFor(decision.assignedPosition, item),
      isSharedPosition: decision.declaredShared,
      manuallyResolved: true,
      tieBreakNote: `Tie decided by an administrator: ${decision.reason}`,
    };
  });

  // Grade points (4.7.3) are added after positions are final so a manual
  // decision cannot double-count them.
  return sortResults(applyGradePoints(updated, item, rules));
}

/**
 * 4.7.3: "Optional grade points may be awarded independently of position, based
 * on the aggregate score percentage. Grade points are disabled by default."
 */
export function applyGradePoints(
  results: RankedResult[],
  item: ItemRankingContext,
  rules: ScoringRules,
): RankedResult[] {
  if (!rules.gradePointsEnabled) return results;

  return results.map((row) => {
    if (row.performanceStatus !== 'COMPLETE') return row;
    const graded = gradeFor(row.aggregate, item.maxMark, rules.gradeBands);
    if (!graded || graded.points === 0) return row;
    return { ...row, points: roundTo(row.points + graded.points, 3) };
  });
}

/** Position order, then aggregate descending, with unranked rows last. */
function sortResults(results: RankedResult[]): RankedResult[] {
  return [...results].sort((a, b) => {
    if (a.position !== null && b.position !== null) {
      if (a.position !== b.position) return a.position - b.position;
      return (b.aggregate ?? 0) - (a.aggregate ?? 0);
    }
    if (a.position !== null) return -1;
    if (b.position !== null) return 1;
    return (b.aggregate ?? 0) - (a.aggregate ?? 0);
  });
}

/**
 * Entry point used by the result service, which needs grade points applied even
 * when there are no manual decisions to trigger applyManualDecisions.
 */
export function rankItemWithGradePoints(
  performances: RankablePerformance[],
  item: ItemRankingContext,
  rules: ScoringRules,
): ItemRankingOutcome {
  const outcome = rankItem(performances, item, rules);
  if (outcome.status !== 'RANKED') return outcome;

  const hasManualDecisions = (item.manualDecisions?.length ?? 0) > 0;
  // applyManualDecisions already applied grade points on that path.
  const results = hasManualDecisions
    ? outcome.results
    : sortResults(applyGradePoints(outcome.results, item, rules));

  return { ...outcome, results };
}
