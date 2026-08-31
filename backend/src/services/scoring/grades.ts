/**
 * Grade bands (FSD 4.7.3, ADM-11-07).
 *
 * Glossary: "Grade — an optional quality band (A / B / C) derived from the
 * aggregate score percentage, independent of position."
 *
 * Independent is the operative word. A grade says how good the performance was;
 * a position says how it compared to the others in the item. FSD 7.5's worked
 * example shows both being reported for a participant who placed nowhere.
 */
import type { GradeBandSpec } from './types.js';

/**
 * Resolve the grade for an aggregate score.
 *
 * @param aggregate  The performance aggregate.
 * @param maxMark    The item maximum, used to express the aggregate as a
 *                   percentage. FSD 18.2 defaults: A >= 80%, B >= 60%, C >= 40%.
 * @returns The highest band whose threshold is met, or null where the score
 *          falls below every configured band or no bands are configured.
 */
export function gradeFor(
  aggregate: number | null,
  maxMark: number,
  bands: GradeBandSpec[],
): { grade: string; points: number } | null {
  if (aggregate === null || bands.length === 0 || maxMark <= 0) return null;

  const percentage = (aggregate / maxMark) * 100;

  // Highest threshold first, so the first match is the best band that applies.
  const ordered = [...bands].sort((a, b) => b.minPercentage - a.minPercentage);
  const matched = ordered.find((band) => percentage >= band.minPercentage);

  return matched ? { grade: matched.grade, points: matched.points } : null;
}

/**
 * Validate a set of grade bands.
 *
 * Duplicate thresholds are the failure worth catching: two bands at 60% would
 * make the grade awarded depend on sort stability rather than on the rules, and
 * a committee that has published "B is 60% and above" would find some 60%
 * performances graded C.
 */
export function validateGradeBands(bands: GradeBandSpec[]): string[] {
  const problems: string[] = [];
  const seenThresholds = new Set<number>();
  const seenGrades = new Set<string>();

  for (const band of bands) {
    if (band.minPercentage < 0 || band.minPercentage > 100) {
      problems.push(`Grade "${band.grade}" has a threshold of ${band.minPercentage}%, which is outside 0–100.`);
    }
    if (seenThresholds.has(band.minPercentage)) {
      problems.push(`Two grades share the threshold ${band.minPercentage}%. Each grade needs a distinct threshold.`);
    }
    if (seenGrades.has(band.grade.toUpperCase())) {
      problems.push(`Grade "${band.grade}" is defined more than once.`);
    }
    seenThresholds.add(band.minPercentage);
    seenGrades.add(band.grade.toUpperCase());
  }

  return problems;
}
