/**
 * The tie-break sequence (FSD 4.5).
 *
 * "The system applies the following tie-break criteria in configurable order
 * until the tie is broken ... If a tie remains after all automated criteria, the
 * system does not guess. It raises the item to the administrator ... Silent
 * tie-breaking is prohibited."
 *
 * That last sentence shapes the whole module. Every function here either
 * separates a group by a stated criterion or reports that it could not; nothing
 * falls back to an arbitrary ordering such as chest number or insertion order.
 */
import type { TiebreakCriterion } from '../../db/schema.js';
import type { JudgeMark, RankablePerformance } from './types.js';

/**
 * Per-item context a criterion may need beyond the performances themselves.
 *
 * JUDGE_TOP_MARK_COUNT is the reason this exists: it cannot be evaluated from a
 * tied pair alone, because it asks which performance received a judge's highest
 * mark *of the whole item*.
 */
export interface TiebreakContext {
  /** judgeId -> that judge's highest mark awarded anywhere in this item. */
  judgeTopMarks: Map<string, number>;
}

/**
 * Build the per-item context once, before ranking begins.
 *
 * Only COMPLETE performances contribute: an ABSENT or VOID performance has no
 * marks, and a judge's "highest mark of that item" must not be influenced by a
 * performance that was struck from the record (FSD 7.1).
 */
export function buildTiebreakContext(performances: RankablePerformance[]): TiebreakContext {
  const judgeTopMarks = new Map<string, number>();

  for (const performance of performances) {
    if (performance.status !== 'COMPLETE') continue;
    for (const mark of performance.marks) {
      const current = judgeTopMarks.get(mark.judgeId);
      if (current === undefined || mark.mark > current) {
        judgeTopMarks.set(mark.judgeId, mark.mark);
      }
    }
  }

  return { judgeTopMarks };
}

/**
 * Score one performance against one criterion. Higher is always better, so the
 * caller can sort descending without knowing which criterion it applied.
 *
 * Returns null where the criterion cannot be evaluated for this performance —
 * for example CHIEF_JUDGE_MARK on a panel with no designated chief. A null is
 * not a zero: a criterion that cannot be evaluated must not silently rank a
 * performance last. Groups containing a null are left unseparated so the next
 * criterion (or the administrator) decides.
 */
export function scoreCriterion(
  performance: RankablePerformance,
  criterion: TiebreakCriterion,
  context: TiebreakContext,
): number | null {
  const marks = performance.marks;
  if (marks.length === 0) return null;

  switch (criterion) {
    /**
     * 4.5.1 — "Higher number of judges who awarded their single highest mark of
     * that item to this performance."
     *
     * This is the criterion the FSD's worked example (7.5) turns on, so its
     * semantics matter: for each judge, take the highest mark that judge gave
     * anywhere in the item, and count how many judges gave exactly that mark to
     * this performance. A judge whose item-high is shared between two
     * performances counts for both, which is correct — the judge did award their
     * top mark to each of them.
     */
    case 'JUDGE_TOP_MARK_COUNT': {
      let count = 0;
      for (const mark of marks) {
        const judgeTop = context.judgeTopMarks.get(mark.judgeId);
        if (judgeTop !== undefined && mark.mark === judgeTop) count += 1;
      }
      return count;
    }

    /** 4.5.2 — "Higher individual maximum mark received from any single judge." */
    case 'HIGHEST_SINGLE_MARK':
      return Math.max(...marks.map((m) => m.mark));

    /**
     * 4.5.3 — "Lower spread (difference between the highest and lowest judge
     * mark), indicating stronger consensus."
     *
     * Negated so that, like every other criterion, a higher returned value is
     * the better outcome.
     */
    case 'LOWEST_SPREAD': {
      const values = marks.map((m) => m.mark);
      return -(Math.max(...values) - Math.min(...values));
    }

    /**
     * 4.5.4 — "Chief judge's mark, where a chief judge is designated on the
     * panel." Where none is designated this yields null and the criterion is
     * skipped rather than treated as a zero mark.
     */
    case 'CHIEF_JUDGE_MARK': {
      const chief = marks.find((m: JudgeMark) => m.isChief);
      return chief ? chief.mark : null;
    }

    default:
      return null;
  }
}

export interface TiebreakGroup {
  performances: RankablePerformance[];
  /** The criterion that separated this group from its siblings, if any. */
  separatedBy: TiebreakCriterion | null;
  /** Every criterion attempted on the path to this group, in order. */
  criteriaApplied: TiebreakCriterion[];
}

/**
 * Resolve a group of performances tied on aggregate.
 *
 * Returns an ordered list of sub-groups, best first. A sub-group of one is
 * resolved; a sub-group of more than one remains tied after every configured
 * criterion was exhausted, and the caller escalates it (FSD 4.5.5).
 *
 * The recursion matters. FSD 7.4 says "apply criterion; if group fully
 * separated, stop", which glosses over the common partial case: a criterion may
 * split five tied performances into a group of two and a group of three, and the
 * next criterion must then be applied WITHIN each remaining group, not across
 * the whole original set. Applying it across the whole set would let a
 * performance already beaten on criterion 1 overtake on criterion 2.
 */
export function resolveTieGroup(
  group: RankablePerformance[],
  criteria: TiebreakCriterion[],
  context: TiebreakContext,
  applied: TiebreakCriterion[] = [],
): TiebreakGroup[] {
  if (group.length <= 1) {
    return [
      {
        performances: group,
        separatedBy: applied.length > 0 ? (applied[applied.length - 1] ?? null) : null,
        criteriaApplied: [...applied],
      },
    ];
  }

  if (criteria.length === 0) {
    // Every criterion exhausted and still tied. FSD 4.5.5 — escalate.
    return [{ performances: group, separatedBy: null, criteriaApplied: [...applied] }];
  }

  const [criterion, ...remaining] = criteria as [TiebreakCriterion, ...TiebreakCriterion[]];
  const nextApplied = [...applied, criterion];

  // Partition by criterion value. A performance the criterion cannot evaluate
  // gets the sentinel key so it stays grouped with its peers rather than being
  // ranked last on a value it never had.
  const NOT_EVALUABLE = Symbol('not-evaluable');
  const buckets = new Map<number | symbol, RankablePerformance[]>();

  for (const performance of group) {
    const value = scoreCriterion(performance, criterion, context);
    const key: number | symbol = value === null ? NOT_EVALUABLE : value;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(performance);
    else buckets.set(key, [performance]);
  }

  // If the criterion put everything in one bucket it separated nothing; move on
  // to the next criterion without recording it as the separator.
  if (buckets.size <= 1) {
    return resolveTieGroup(group, remaining, context, nextApplied);
  }

  // Numeric buckets first, best (highest) first. Any non-evaluable bucket ranks
  // after all evaluated ones — it could not demonstrate merit on this criterion,
  // but it is not assigned a value it does not have.
  const numericKeys = [...buckets.keys()].filter((k): k is number => typeof k === 'number');
  numericKeys.sort((a, b) => b - a);

  const orderedKeys: (number | symbol)[] = [...numericKeys];
  if (buckets.has(NOT_EVALUABLE)) orderedKeys.push(NOT_EVALUABLE);

  const output: TiebreakGroup[] = [];
  for (const key of orderedKeys) {
    const bucket = buckets.get(key)!;
    if (bucket.length === 1) {
      output.push({
        performances: bucket,
        separatedBy: criterion,
        criteriaApplied: [...nextApplied],
      });
    } else {
      // Still tied within this bucket — recurse with the remaining criteria.
      output.push(...resolveTieGroup(bucket, remaining, context, nextApplied));
    }
  }

  return output;
}

/** Human-readable explanation of how a tie was separated, for the result sheet. */
export function describeTiebreak(criterion: TiebreakCriterion | null): string | null {
  if (!criterion) return null;
  switch (criterion) {
    case 'JUDGE_TOP_MARK_COUNT':
      return 'Separated on the number of judges who awarded their highest mark of this item to this performance (FSD 4.5.1).';
    case 'HIGHEST_SINGLE_MARK':
      return 'Separated on the highest individual mark received from any single judge (FSD 4.5.2).';
    case 'LOWEST_SPREAD':
      return 'Separated on the narrowest spread between the highest and lowest judge mark (FSD 4.5.3).';
    case 'CHIEF_JUDGE_MARK':
      return "Separated on the chief judge's mark (FSD 4.5.4).";
    default:
      return null;
  }
}
