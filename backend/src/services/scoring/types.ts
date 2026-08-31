/**
 * Shared types for the scoring and result computation engine (FSD 7).
 *
 * Everything in src/services/scoring is deliberately PURE: it takes plain data
 * in and returns plain data out, with no database access and no clock reads.
 * That is what makes FSD 11.6's requirement — "Automated test coverage required
 * on the scoring and result engine specifically; this is the component where a
 * defect is most expensive" — practical rather than aspirational, and it lets
 * AC-09 ("the worked example in Section 7.5 reproduces exactly") be a unit test.
 */
import type {
  AggregationMethod,
  PerformanceStatus,
  TiebreakCriterion,
} from '../../db/schema.js';

/** One judge's valid (non-revoked) mark for one performance. */
export interface JudgeMark {
  judgeId: string;
  mark: number;
  /** Snapshot from performance_judges, used only by WEIGHTED_AVERAGE (4.4). */
  weight: number;
  /** Designated chief judge, used by the CHIEF_JUDGE_MARK tie-break (4.5.4). */
  isChief: boolean;
}

/** A performance as the ranking engine sees it. */
export interface RankablePerformance {
  performanceId: string;
  registrationId: string;
  churchId: string | null;
  status: PerformanceStatus;
  /** Stored aggregate (FSD 7.3 — computed once at completion, never on demand). */
  aggregate: number | null;
  /** Valid marks only. Revoked scores are excluded before this point (ADM-10-02). */
  marks: JudgeMark[];
}

/** Points awarded for a finishing position (4.7.1). */
export interface PositionPointsMap {
  /** position -> points, before the item weight multiplier is applied. */
  [position: number]: number;
}

/** A grade threshold (4.7.3, 18.2 defaults: A >= 80%, B >= 60%, C >= 40%). */
export interface GradeBandSpec {
  grade: string;
  minPercentage: number;
  points: number;
}

/** The scoring rules in force, resolved from scoring_config for one event. */
export interface ScoringRules {
  maxMark: number;
  decimalPlaces: number;
  aggregationMethod: AggregationMethod;
  allowSharedPositions: boolean;
  tiebreakOrder: TiebreakCriterion[];
  gradePointsEnabled: boolean;
  gradeBands: GradeBandSpec[];
  /** 12.1: minimum aggregate for a sole participant to be placed. */
  walkoverMinAggregate: number | null;
}

/** Item-level inputs to ranking. */
export interface ItemRankingContext {
  itemId: string;
  /** ADM-04-02: per-item override, else the event maximum. */
  maxMark: number;
  /** 4.7.2: a group item weighted 2.0 awards double points. */
  weightMultiplier: number;
  /** Merged event defaults and per-item overrides (ADM-11-04). */
  positionPoints: PositionPointsMap;
  /** 4.5.5: administrator decisions that override the automated sequence. */
  manualDecisions?: ManualTieDecision[];
}

/** An administrator's recorded resolution of a tie (4.5.5, ADM-12-02). */
export interface ManualTieDecision {
  performanceId: string;
  assignedPosition: number;
  declaredShared: boolean;
  reason: string;
}

/** One row of a computed item result (ADM-12-01). */
export interface RankedResult {
  performanceId: string;
  registrationId: string;
  churchId: string | null;
  performanceStatus: PerformanceStatus;
  /** 1..n for every COMPLETE performance; null for ABSENT / VOID / WITHDRAWN. */
  position: number | null;
  /**
   * True where the position carries points, i.e. it falls within the configured
   * position_points. FSD 7.5 renders unplaced finishers with an em dash while
   * 7.4 still assigns them an ordinal — this flag carries that distinction to
   * the report layer instead of overloading `position` with null.
   */
  placed: boolean;
  aggregate: number | null;
  grade: string | null;
  points: number;
  isSharedPosition: boolean;
  tieBreakApplied: TiebreakCriterion | null;
  tieBreakNote: string | null;
  manuallyResolved: boolean;
}

export type ItemRankingOutcome =
  | {
      status: 'RANKED';
      results: RankedResult[];
      /** 4.5.5: tie groups the sequence could not separate. Empty when clean. */
      unresolvedTies: UnresolvedTie[];
    }
  | {
      /** FSD 7.4: rank_item returns NOT_READY while any performance is pending. */
      status: 'NOT_READY';
      pending: { performanceId: string; status: PerformanceStatus }[];
    }
  | {
      /** 12.1: "An item has no participants — auto-marked cancelled." */
      status: 'NO_PARTICIPANTS';
    };

/** A tie the automated sequence could not break (4.5.5). */
export interface UnresolvedTie {
  aggregate: number;
  position: number;
  performanceIds: string[];
  /** Every criterion that was tried, in order, so the escalation is explainable. */
  criteriaApplied: TiebreakCriterion[];
}
