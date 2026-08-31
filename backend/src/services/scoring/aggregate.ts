/**
 * Aggregation — turning several judges' marks into one number for a performance.
 *
 * FSD 4.4: "The aggregation method is configured once, before the event, and
 * cannot be changed after the first result is published." That immutability is
 * enforced by ADM-11-09 at the configuration layer; this module only implements
 * the four methods.
 */
import type { AggregationMethod } from '../../db/schema.js';
import type { JudgeMark } from './types.js';

/**
 * Precision at which aggregates are stored and compared.
 *
 * performances.aggregate_score is numeric(8,3), so three decimal places is the
 * storage precision and therefore the precision at which two performances are
 * considered tied. This matters: with three judges marking out of 10, an average
 * is frequently a repeating decimal (26.0 / 3 = 8.666...), and rounding both
 * sides of a comparison identically is what makes tie detection deterministic
 * rather than dependent on floating-point noise.
 *
 * FSD 4.5 anticipates this — "Ties are extremely common when marking out of 10
 * with three judges" — and answers it with the tie-break sequence, not with
 * extra precision.
 */
export const AGGREGATE_PRECISION = 3;

/**
 * Round half away from zero at a given precision.
 *
 * Math.round alone is not adequate: (8.6665).toFixed(3) and Math.round(8.6665 *
 * 1000) / 1000 disagree for values whose binary representation falls just below
 * the .5 boundary. Adding Number.EPSILON scaled to the magnitude of the value
 * corrects the representation error before rounding, so 8.6665 rounds to 8.667
 * rather than 8.666.
 */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  const scaled = value * factor;
  return Math.round(scaled + Math.sign(scaled) * Number.EPSILON * Math.abs(scaled)) / factor;
}

export interface AggregateResult {
  value: number;
  method: AggregationMethod;
  /** Number of marks that contributed. */
  markCount: number;
  /**
   * Set where the requested method could not be applied and a documented
   * fallback was used. Surfaced to the administrator rather than hidden.
   */
  fallbackNote?: string;
}

/**
 * Compute the aggregate for one performance.
 *
 * @param marks Valid marks only. Revoked scores (ADM-10-02) must be filtered out
 *              by the caller before this is called.
 */
export function computeAggregate(
  marks: JudgeMark[],
  method: AggregationMethod,
): AggregateResult {
  if (marks.length === 0) {
    throw new Error('computeAggregate called with no marks — a performance cannot be aggregated.');
  }

  const values = marks.map((m) => m.mark);

  switch (method) {
    case 'SUM':
      return {
        value: roundTo(sum(values), AGGREGATE_PRECISION),
        method,
        markCount: marks.length,
      };

    case 'TRIMMED_MEAN':
      return trimmedMean(marks);

    case 'WEIGHTED_AVERAGE':
      return weightedAverage(marks);

    case 'AVERAGE':
    default:
      return {
        value: roundTo(sum(values) / values.length, AGGREGATE_PRECISION),
        method: 'AVERAGE',
        markCount: marks.length,
      };
  }
}

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/**
 * FSD 4.4: "Discard the highest and lowest score, average the rest. Requires at
 * least four judges; guards against one outlier judge."
 *
 * With fewer than four marks the method is undefined — trimming a panel of three
 * leaves a single mark, which is not a trimmed mean but a median, and trimming a
 * panel of two leaves nothing at all. Rather than fail a live item, this falls
 * back to AVERAGE and says so in fallbackNote, which the result service records
 * on the performance and the exceptions report prints.
 *
 * The configuration layer additionally refuses to save TRIMMED_MEAN alongside
 * panels smaller than four (see config module), so this path should be
 * unreachable in a correctly set up event. It exists because "should be
 * unreachable" is not a guarantee on event day.
 */
function trimmedMean(marks: JudgeMark[]): AggregateResult {
  const values = marks.map((m) => m.mark).sort((a, b) => a - b);

  if (values.length < 4) {
    return {
      value: roundTo(sum(values) / values.length, AGGREGATE_PRECISION),
      method: 'AVERAGE',
      markCount: marks.length,
      fallbackNote:
        `Trimmed mean requires at least 4 judges (FSD 4.4) but this performance has ` +
        `${values.length}. The arithmetic average was used instead.`,
    };
  }

  // Discard exactly one highest and one lowest, even when duplicated: trimming
  // by value would remove every tied extreme and change the panel size.
  const trimmed = values.slice(1, -1);
  return {
    value: roundTo(sum(trimmed) / trimmed.length, AGGREGATE_PRECISION),
    method: 'TRIMMED_MEAN',
    markCount: marks.length,
  };
}

/**
 * FSD 4.4: "Each judge carries a configured weight. For panels with a chief
 * judge; use with caution as it invites disputes."
 *
 * Weights are snapshotted onto performance_judges and copied to scores.judge_weight
 * at submission, so changing a judge's weight later cannot alter a historical
 * aggregate (FSD 7.3).
 */
function weightedAverage(marks: JudgeMark[]): AggregateResult {
  const totalWeight = marks.reduce((total, m) => total + m.weight, 0);

  if (totalWeight <= 0) {
    return {
      value: roundTo(sum(marks.map((m) => m.mark)) / marks.length, AGGREGATE_PRECISION),
      method: 'AVERAGE',
      markCount: marks.length,
      fallbackNote:
        'Weighted average could not be applied because the panel weights total zero. ' +
        'The arithmetic average was used instead.',
    };
  }

  const weighted = marks.reduce((total, m) => total + m.mark * m.weight, 0);
  return {
    value: roundTo(weighted / totalWeight, AGGREGATE_PRECISION),
    method: 'WEIGHTED_AVERAGE',
    markCount: marks.length,
  };
}

/**
 * Whether a mark is valid for an item.
 *
 * FSD 4.3.1: "from 0 to the configured maximum (default 10). Decimal marks are
 * permitted to a configurable number of places (default 1, e.g. 8.5)."
 * JDG-05-03 requires out-of-range values to be impossible to enter rather than
 * rejected afterwards; this is the server-side half of that guarantee, which
 * FSD 11.2 insists on independently of the interface.
 */
export function validateMark(
  mark: number,
  maxMark: number,
  decimalPlaces: number,
): { valid: boolean; reason?: string } {
  if (!Number.isFinite(mark)) {
    return { valid: false, reason: 'The mark must be a number.' };
  }
  if (mark < 0 || mark > maxMark) {
    return { valid: false, reason: `The mark must be between 0 and ${maxMark}.` };
  }
  // Compare against the value re-rounded at the allowed precision: 8.55 with
  // decimalPlaces = 1 differs from 8.6, so it is rejected.
  if (roundTo(mark, decimalPlaces) !== mark) {
    return {
      valid: false,
      reason:
        decimalPlaces === 0
          ? 'The mark must be a whole number.'
          : `The mark may have at most ${decimalPlaces} decimal place${decimalPlaces === 1 ? '' : 's'}.`,
    };
  }
  return { valid: true };
}
