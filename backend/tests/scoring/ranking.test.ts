/**
 * Scoring engine tests.
 *
 * FSD 11.6 makes coverage of this component mandatory; AC-09 makes the worked
 * example in FSD 7.5 an acceptance criterion in its own right ("the worked
 * example in Section 7.5 reproduces exactly"). That example is the first test
 * below, transcribed from the document without adjustment.
 */
import { describe, expect, it } from 'vitest';
import { computeAggregate, roundTo, validateMark } from '../../src/services/scoring/aggregate.js';
import { gradeFor } from '../../src/services/scoring/grades.js';
import { rankItemWithGradePoints } from '../../src/services/scoring/ranking.js';
import type {
  GradeBandSpec,
  ItemRankingContext,
  JudgeMark,
  RankablePerformance,
  ScoringRules,
} from '../../src/services/scoring/types.js';

// --- Shared fixtures --------------------------------------------------------

/** FSD 18.2 default grade bands. */
const DEFAULT_GRADE_BANDS: GradeBandSpec[] = [
  { grade: 'A', minPercentage: 80, points: 5 },
  { grade: 'B', minPercentage: 60, points: 3 },
  { grade: 'C', minPercentage: 40, points: 1 },
];

/** FSD 18.2 defaults, with grade points disabled as specified. */
function defaultRules(overrides: Partial<ScoringRules> = {}): ScoringRules {
  return {
    maxMark: 10,
    decimalPlaces: 1,
    aggregationMethod: 'AVERAGE',
    allowSharedPositions: false,
    tiebreakOrder: [
      'JUDGE_TOP_MARK_COUNT',
      'HIGHEST_SINGLE_MARK',
      'LOWEST_SPREAD',
      'CHIEF_JUDGE_MARK',
    ],
    gradePointsEnabled: false,
    gradeBands: DEFAULT_GRADE_BANDS,
    walkoverMinAggregate: null,
    ...overrides,
  };
}

/** FSD 18.2: 1st = 5, 2nd = 3, 3rd = 1. */
function defaultItem(overrides: Partial<ItemRankingContext> = {}): ItemRankingContext {
  return {
    itemId: 'item-solo-song-junior-girls',
    maxMark: 10,
    weightMultiplier: 1.0,
    positionPoints: { 1: 5, 2: 3, 3: 1 },
    ...overrides,
  };
}

const JUDGES = ['J1', 'J2', 'J3'] as const;

/** Build a COMPLETE performance from a list of marks in judge order. */
function performance(
  id: string,
  marks: number[],
  options: { chiefIndex?: number; churchId?: string; method?: ScoringRules['aggregationMethod'] } = {},
): RankablePerformance {
  const judgeMarks: JudgeMark[] = marks.map((mark, index) => ({
    judgeId: JUDGES[index] ?? `J${index + 1}`,
    mark,
    weight: 1,
    isChief: options.chiefIndex === index,
  }));

  return {
    performanceId: id,
    registrationId: `reg-${id}`,
    churchId: options.churchId ?? null,
    status: 'COMPLETE',
    aggregate: computeAggregate(judgeMarks, options.method ?? 'AVERAGE').value,
    marks: judgeMarks,
  };
}

// ===========================================================================
// AC-09 — the FSD 7.5 worked example, reproduced exactly.
// ===========================================================================

describe('FSD 7.5 worked example (AC-09)', () => {
  // Item: Solo Song — Junior Girls. Panel of three. Maximum mark 10.
  // Aggregation: average. Position points 1st = 5, 2nd = 3, 3rd = 1.
  // Shared positions not permitted.
  const sarah = performance('118', [9.0, 8.0, 9.0], { churchId: 'zion' });
  const anna = performance('104', [8.5, 9.0, 8.5], { churchId: 'bethel' });
  const rebecca = performance('132', [7.5, 8.0, 7.0], { churchId: 'calvary' });
  const grace = performance('145', [6.5, 7.0, 6.5], { churchId: 'bethel' });

  const outcome = rankItemWithGradePoints(
    // Deliberately shuffled: ranking must not depend on input order.
    [grace, sarah, rebecca, anna],
    defaultItem(),
    defaultRules(),
  );

  it('produces a ranked result', () => {
    expect(outcome.status).toBe('RANKED');
  });

  it('computes the aggregates shown in the example', () => {
    // The document displays 8.67 / 8.67 / 7.50 / 6.67; the engine stores three
    // decimal places (numeric(8,3)), so 26/3 is 8.667 and 20/3 is 6.667.
    expect(sarah.aggregate).toBe(8.667);
    expect(anna.aggregate).toBe(8.667);
    expect(rebecca.aggregate).toBe(7.5);
    expect(grace.aggregate).toBe(6.667);

    // Rounded for display, they are exactly the figures in the document.
    expect(roundTo(sarah.aggregate!, 2)).toBe(8.67);
    expect(roundTo(grace.aggregate!, 2)).toBe(6.67);
  });

  it('breaks the 8.67 tie on criterion 4.5.1, awarding first place to chest 118', () => {
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    const byId = new Map(outcome.results.map((r) => [r.performanceId, r]));

    // Judge 1's item-high 9.0 went to 118; Judge 2's 9.0 went to 104;
    // Judge 3's 9.0 went to 118. Two against one.
    expect(byId.get('118')!.position).toBe(1);
    expect(byId.get('104')!.position).toBe(2);
    expect(byId.get('118')!.tieBreakApplied).toBe('JUDGE_TOP_MARK_COUNT');
    expect(byId.get('104')!.tieBreakApplied).toBe('JUDGE_TOP_MARK_COUNT');
  });

  it('reproduces the final result table exactly', () => {
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    const table = outcome.results.map((r) => ({
      position: r.placed ? r.position : null, // 7.5 renders an em dash for 145
      chest: r.performanceId,
      aggregate: roundTo(r.aggregate!, 2),
      grade: r.grade,
      points: r.points,
    }));

    expect(table).toEqual([
      { position: 1, chest: '118', aggregate: 8.67, grade: 'A', points: 5 },
      { position: 2, chest: '104', aggregate: 8.67, grade: 'A', points: 3 },
      { position: 3, chest: '132', aggregate: 7.5, grade: 'B', points: 1 },
      { position: null, chest: '145', aggregate: 6.67, grade: 'B', points: 0 },
    ]);
  });

  it('leaves no unresolved ties', () => {
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');
    expect(outcome.unresolvedTies).toHaveLength(0);
  });

  it('yields the church points stated in the example: Zion 5, Bethel 3, Calvary 1', () => {
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    const byChurch = new Map<string, number>();
    for (const row of outcome.results) {
      if (!row.churchId) continue;
      byChurch.set(row.churchId, (byChurch.get(row.churchId) ?? 0) + row.points);
    }

    expect(byChurch.get('zion')).toBe(5);
    expect(byChurch.get('bethel')).toBe(3); // Anna 3 + Grace 0
    expect(byChurch.get('calvary')).toBe(1);
  });
});

// ===========================================================================
// FSD 4.4 — aggregation methods
// ===========================================================================

describe('aggregation methods (FSD 4.4)', () => {
  const marks: JudgeMark[] = [
    { judgeId: 'J1', mark: 9, weight: 2, isChief: true },
    { judgeId: 'J2', mark: 8, weight: 1, isChief: false },
    { judgeId: 'J3', mark: 7, weight: 1, isChief: false },
    { judgeId: 'J4', mark: 6, weight: 1, isChief: false },
  ];

  it('AVERAGE is the arithmetic mean', () => {
    expect(computeAggregate(marks, 'AVERAGE').value).toBe(7.5);
  });

  it('SUM totals the marks', () => {
    expect(computeAggregate(marks, 'SUM').value).toBe(30);
  });

  it('TRIMMED_MEAN discards the highest and lowest', () => {
    // Drops 9 and 6, averages 8 and 7.
    const result = computeAggregate(marks, 'TRIMMED_MEAN');
    expect(result.value).toBe(7.5);
    expect(result.method).toBe('TRIMMED_MEAN');
    expect(result.fallbackNote).toBeUndefined();
  });

  it('TRIMMED_MEAN discards only one of each tied extreme, not every duplicate', () => {
    const tied: JudgeMark[] = [
      { judgeId: 'J1', mark: 9, weight: 1, isChief: false },
      { judgeId: 'J2', mark: 9, weight: 1, isChief: false },
      { judgeId: 'J3', mark: 5, weight: 1, isChief: false },
      { judgeId: 'J4', mark: 5, weight: 1, isChief: false },
    ];
    // Sorted [5,5,9,9]; trimming one from each end leaves [5,9], mean 7.
    expect(computeAggregate(tied, 'TRIMMED_MEAN').value).toBe(7);
  });

  it('TRIMMED_MEAN falls back to AVERAGE below four judges, and says so', () => {
    // FSD 4.4: "Requires at least four judges."
    const three = marks.slice(0, 3);
    const result = computeAggregate(three, 'TRIMMED_MEAN');
    expect(result.method).toBe('AVERAGE');
    expect(result.value).toBe(8);
    expect(result.fallbackNote).toContain('at least 4 judges');
  });

  it('WEIGHTED_AVERAGE honours judge weights', () => {
    // (9*2 + 8 + 7 + 6) / 5 = 39/5 = 7.8
    expect(computeAggregate(marks, 'WEIGHTED_AVERAGE').value).toBe(7.8);
  });
});

// ===========================================================================
// FSD 4.3.1 / JDG-05-03 / 12.1 — mark validation
// ===========================================================================

describe('mark validation (FSD 4.3.1, JDG-05-03)', () => {
  it('accepts a mark inside the range at the allowed precision', () => {
    expect(validateMark(8.5, 10, 1).valid).toBe(true);
    expect(validateMark(0, 10, 1).valid).toBe(true);
    expect(validateMark(10, 10, 1).valid).toBe(true);
  });

  it('rejects 11 out of 10 (FSD 12.1)', () => {
    const result = validateMark(11, 10, 1);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('between 0 and 10');
  });

  it('rejects a negative mark', () => {
    expect(validateMark(-0.5, 10, 1).valid).toBe(false);
  });

  it('rejects more decimal places than configured', () => {
    expect(validateMark(8.55, 10, 1).valid).toBe(false);
    expect(validateMark(8.5, 10, 0).valid).toBe(false);
    expect(validateMark(8.55, 10, 2).valid).toBe(true);
  });

  it('rejects a non-numeric mark', () => {
    expect(validateMark(Number.NaN, 10, 1).valid).toBe(false);
  });
});

// ===========================================================================
// FSD 4.5 — the tie-break sequence
// ===========================================================================

describe('tie-break sequence (FSD 4.5)', () => {
  it('falls through to criterion 2 when criterion 1 cannot separate', () => {
    // Judge item-highs: J1 = 9.5 (A), J2 = 8.0 (B), J3 = 7.0 (shared, so it
    // counts for both). JUDGE_TOP_MARK_COUNT is therefore 2 against 2 and
    // cannot separate. HIGHEST_SINGLE_MARK then does: 9.5 beats 9.0.
    const a = performance('A', [9.5, 7.5, 7.0]);
    const b = performance('B', [9.0, 8.0, 7.0]);
    // Both total 24.0, so both average exactly 8.0 — a genuine aggregate tie.
    expect(a.aggregate).toBe(8);
    expect(b.aggregate).toBe(8);

    const outcome = rankItemWithGradePoints([a, b], defaultItem(), defaultRules());
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    const byId = new Map(outcome.results.map((r) => [r.performanceId, r]));
    expect(byId.get('A')!.position).toBe(1);
    expect(byId.get('A')!.tieBreakApplied).toBe('HIGHEST_SINGLE_MARK');
  });

  it('separates on the narrowest spread (criterion 3)', () => {
    const outcome = rankItemWithGradePoints(
      [
        // Identical aggregate and identical highest mark; A has the tighter spread.
        performance('A', [8.0, 8.0, 8.0]),
        performance('B', [8.0, 9.0, 7.0]),
      ],
      defaultItem(),
      defaultRules({ tiebreakOrder: ['LOWEST_SPREAD'] }),
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    const byId = new Map(outcome.results.map((r) => [r.performanceId, r]));
    expect(byId.get('A')!.position).toBe(1);
    expect(byId.get('A')!.tieBreakApplied).toBe('LOWEST_SPREAD');
  });

  it("separates on the chief judge's mark (criterion 4)", () => {
    const outcome = rankItemWithGradePoints(
      [
        performance('A', [7.0, 8.0, 9.0], { chiefIndex: 0 }),
        performance('B', [9.0, 8.0, 7.0], { chiefIndex: 0 }),
      ],
      defaultItem(),
      defaultRules({ tiebreakOrder: ['CHIEF_JUDGE_MARK'] }),
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    const byId = new Map(outcome.results.map((r) => [r.performanceId, r]));
    // Chief is J1: gave 7 to A and 9 to B.
    expect(byId.get('B')!.position).toBe(1);
  });

  it('escalates rather than guessing when every criterion is exhausted (AC-10)', () => {
    // FSD 4.5: "the system does not guess ... Silent tie-breaking is prohibited."
    const outcome = rankItemWithGradePoints(
      [performance('A', [8.0, 8.0, 8.0]), performance('B', [8.0, 8.0, 8.0])],
      defaultItem(),
      defaultRules(),
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    expect(outcome.unresolvedTies).toHaveLength(1);
    expect(outcome.unresolvedTies[0]!.performanceIds.sort()).toEqual(['A', 'B']);
    expect(outcome.unresolvedTies[0]!.position).toBe(1);
    // No points are awarded while the tie blocks publication.
    expect(outcome.results.every((r) => r.points === 0)).toBe(true);
  });

  it('applies later criteria within sub-groups, not across the whole tie group', () => {
    // Three tied on aggregate. Criterion 1 separates C from {A, B};
    // criterion 2 must then run only within {A, B}.
    const a = performance('A', [9.0, 6.0, 9.0]); // 24/3 = 8
    const b = performance('B', [9.0, 7.0, 8.0]); // 24/3 = 8
    const c = performance('C', [8.0, 8.0, 8.0]); // 24/3 = 8

    const outcome = rankItemWithGradePoints([a, b, c], defaultItem(), defaultRules());
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    const positions = new Map(outcome.results.map((r) => [r.performanceId, r.position]));
    // A and B each hold a judge item-high of 9.0 (J1 and J3); C holds none.
    // So C must finish last regardless of what criterion 2 says about A vs B.
    expect(positions.get('C')).toBe(3);
    expect(new Set([positions.get('A'), positions.get('B')])).toEqual(new Set([1, 2]));
  });
});

// ===========================================================================
// FSD 4.6 — shared positions
// ===========================================================================

describe('shared positions (FSD 4.6)', () => {
  it('awards the same position and full points, then skips the next position', () => {
    const outcome = rankItemWithGradePoints(
      [
        performance('A', [8.0, 8.0, 8.0]),
        performance('B', [8.0, 8.0, 8.0]),
        performance('C', [7.0, 7.0, 7.0]),
      ],
      defaultItem(),
      defaultRules({ allowSharedPositions: true }),
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    const byId = new Map(outcome.results.map((r) => [r.performanceId, r]));

    expect(byId.get('A')!.position).toBe(1);
    expect(byId.get('B')!.position).toBe(1);
    expect(byId.get('A')!.isSharedPosition).toBe(true);
    // "both receive the full first-place points"
    expect(byId.get('A')!.points).toBe(5);
    expect(byId.get('B')!.points).toBe(5);
    // "no second place is awarded (the next participant is third)"
    expect(byId.get('C')!.position).toBe(3);
    expect(byId.get('C')!.points).toBe(1);
    expect(outcome.unresolvedTies).toHaveLength(0);
  });
});

// ===========================================================================
// FSD 7.1 / 7.4 — readiness and non-ranked statuses
// ===========================================================================

describe('readiness and performance status (FSD 7.1, 7.4)', () => {
  it('returns NOT_READY while any performance is still pending', () => {
    const pending: RankablePerformance = {
      ...performance('B', [8, 8, 8]),
      status: 'IN_PROGRESS',
    };
    const outcome = rankItemWithGradePoints(
      [performance('A', [9, 9, 9]), pending],
      defaultItem(),
      defaultRules(),
    );

    expect(outcome.status).toBe('NOT_READY');
    if (outcome.status !== 'NOT_READY') throw new Error('expected NOT_READY');
    expect(outcome.pending).toEqual([{ performanceId: 'B', status: 'IN_PROGRESS' }]);
  });

  it('reports NO_PARTICIPANTS for an empty item (FSD 12.1)', () => {
    expect(rankItemWithGradePoints([], defaultItem(), defaultRules()).status).toBe(
      'NO_PARTICIPANTS',
    );
  });

  it('lists ABSENT and VOID performances with no position and no points', () => {
    const absent: RankablePerformance = {
      performanceId: 'ABS',
      registrationId: 'reg-ABS',
      churchId: 'zion',
      status: 'ABSENT',
      aggregate: null,
      marks: [],
    };
    const voided: RankablePerformance = {
      performanceId: 'VOID',
      registrationId: 'reg-VOID',
      churchId: 'bethel',
      status: 'VOID',
      aggregate: null,
      marks: [],
    };

    const outcome = rankItemWithGradePoints(
      [performance('A', [9, 9, 9]), absent, voided],
      defaultItem(),
      defaultRules(),
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    const byId = new Map(outcome.results.map((r) => [r.performanceId, r]));
    expect(byId.get('A')!.position).toBe(1);
    for (const id of ['ABS', 'VOID']) {
      expect(byId.get(id)!.position).toBeNull();
      expect(byId.get(id)!.points).toBe(0);
      expect(byId.get(id)!.grade).toBeNull();
    }
    // They still appear on the sheet, with their status (FSD 7.1).
    expect(outcome.results).toHaveLength(3);
  });
});

// ===========================================================================
// FSD 4.7 / 12.1 — points, weights, grades, walkover
// ===========================================================================

describe('points and weighting (FSD 4.7)', () => {
  it('applies the item weight multiplier (4.7.2)', () => {
    const outcome = rankItemWithGradePoints(
      [performance('A', [9, 9, 9]), performance('B', [8, 8, 8])],
      defaultItem({ weightMultiplier: 2.0 }),
      defaultRules(),
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    const byId = new Map(outcome.results.map((r) => [r.performanceId, r]));
    expect(byId.get('A')!.points).toBe(10); // 5 * 2.0
    expect(byId.get('B')!.points).toBe(6); // 3 * 2.0
  });

  it('supports more than three configured positions (ADM-11-03)', () => {
    const outcome = rankItemWithGradePoints(
      [
        performance('A', [9, 9, 9]),
        performance('B', [8, 8, 8]),
        performance('C', [7, 7, 7]),
        performance('D', [6, 6, 6]),
        performance('E', [5, 5, 5]),
      ],
      defaultItem({ positionPoints: { 1: 10, 2: 7, 3: 5, 4: 3, 5: 1 } }),
      defaultRules(),
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');
    expect(outcome.results.map((r) => r.points)).toEqual([10, 7, 5, 3, 1]);
    expect(outcome.results.every((r) => r.placed)).toBe(true);
  });

  it('adds grade points only when enabled (4.7.3)', () => {
    const rules = defaultRules({ gradePointsEnabled: true });
    const outcome = rankItemWithGradePoints(
      [performance('A', [9, 9, 9])], // 9.0 -> 90% -> grade A -> 5 grade points
      defaultItem(),
      rules,
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');
    expect(outcome.results[0]!.points).toBe(10); // 5 position + 5 grade

    const disabled = rankItemWithGradePoints([performance('A', [9, 9, 9])], defaultItem(), defaultRules());
    if (disabled.status !== 'RANKED') throw new Error('expected RANKED');
    expect(disabled.results[0]!.points).toBe(5);
  });

  it('applies the walkover rule to a sole participant (12.1)', () => {
    const outcome = rankItemWithGradePoints(
      [performance('A', [4, 4, 4])], // aggregate 4.0
      defaultItem(),
      defaultRules({ walkoverMinAggregate: 5 }),
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    expect(outcome.results[0]!.position).toBeNull();
    expect(outcome.results[0]!.points).toBe(0);
    expect(outcome.results[0]!.tieBreakNote).toContain('Walkover');
  });

  it('ranks a sole participant first when the walkover threshold is met', () => {
    const outcome = rankItemWithGradePoints(
      [performance('A', [8, 8, 8])],
      defaultItem(),
      defaultRules({ walkoverMinAggregate: 5 }),
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');
    expect(outcome.results[0]!.position).toBe(1);
    expect(outcome.results[0]!.points).toBe(5);
  });
});

describe('grade bands (FSD 4.7.3, 18.2)', () => {
  it('maps percentages to the default bands', () => {
    expect(gradeFor(8, 10, DEFAULT_GRADE_BANDS)?.grade).toBe('A'); // 80%
    expect(gradeFor(7.9, 10, DEFAULT_GRADE_BANDS)?.grade).toBe('B'); // 79%
    expect(gradeFor(6, 10, DEFAULT_GRADE_BANDS)?.grade).toBe('B'); // 60%
    expect(gradeFor(4, 10, DEFAULT_GRADE_BANDS)?.grade).toBe('C'); // 40%
    expect(gradeFor(3.9, 10, DEFAULT_GRADE_BANDS)).toBeNull(); // below every band
  });

  it('returns null for a null aggregate', () => {
    expect(gradeFor(null, 10, DEFAULT_GRADE_BANDS)).toBeNull();
  });
});

// ===========================================================================
// FSD 4.5.5 — administrator tie decisions
// ===========================================================================

describe('manual tie decisions (FSD 4.5.5, ADM-12-02)', () => {
  it('applies the recorded decision and clears the publication block', () => {
    const item = defaultItem({
      manualDecisions: [
        {
          performanceId: 'A',
          assignedPosition: 1,
          declaredShared: false,
          reason: 'Panel agreed on the strength of the second verse; recorded by the chief judge.',
        },
        {
          performanceId: 'B',
          assignedPosition: 2,
          declaredShared: false,
          reason: 'Panel agreed on the strength of the second verse; recorded by the chief judge.',
        },
      ],
    });

    const outcome = rankItemWithGradePoints(
      [performance('A', [8, 8, 8]), performance('B', [8, 8, 8])],
      item,
      defaultRules(),
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');

    const byId = new Map(outcome.results.map((r) => [r.performanceId, r]));
    expect(byId.get('A')!.position).toBe(1);
    expect(byId.get('A')!.points).toBe(5);
    expect(byId.get('A')!.manuallyResolved).toBe(true);
    expect(byId.get('B')!.position).toBe(2);
    expect(byId.get('B')!.points).toBe(3);

    // Every member of the tie now has a decision, so publication is unblocked.
    expect(outcome.unresolvedTies).toHaveLength(0);
  });

  it('keeps the block when only part of the tie group has been decided', () => {
    const item = defaultItem({
      manualDecisions: [
        {
          performanceId: 'A',
          assignedPosition: 1,
          declaredShared: false,
          reason: 'Chief judge recorded a decision for this entrant only, pending review.',
        },
      ],
    });

    const outcome = rankItemWithGradePoints(
      [performance('A', [8, 8, 8]), performance('B', [8, 8, 8]), performance('C', [8, 8, 8])],
      item,
      defaultRules(),
    );
    if (outcome.status !== 'RANKED') throw new Error('expected RANKED');
    expect(outcome.unresolvedTies).toHaveLength(1);
  });
});

// ===========================================================================
// Numeric behaviour
// ===========================================================================

describe('rounding', () => {
  it('rounds half away from zero without floating-point drift', () => {
    expect(roundTo(8.6665, 3)).toBe(8.667);
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(26 / 3, 3)).toBe(8.667);
    expect(roundTo(20 / 3, 3)).toBe(6.667);
    expect(roundTo(-1.005, 2)).toBe(-1.01);
  });

  it('sums decimal marks without accumulating error', () => {
    const marks: JudgeMark[] = [0.1, 0.2, 0.3].map((mark, i) => ({
      judgeId: `J${i}`,
      mark,
      weight: 1,
      isChief: false,
    }));
    // 0.1 + 0.2 + 0.3 is 0.6000000000000001 in IEEE-754.
    expect(computeAggregate(marks, 'SUM').value).toBe(0.6);
  });
});
