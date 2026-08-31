/**
 * Display formatting.
 *
 * Marks and aggregates are rendered to two decimal places, matching the FSD 7.5
 * result table (8.67, 7.50, 6.67), while the stored value keeps three (see the
 * backend's AGGREGATE_PRECISION). Rounding only at the display boundary means a
 * ranking is never decided by a rounded figure.
 */

export function formatMark(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(decimals);
}

export function formatAggregate(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(2);
}

export function formatPoints(value: number | null | undefined): string {
  if (value === null || value === undefined) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** FSD 7.5 renders an unplaced finisher with an em dash rather than an ordinal. */
export function formatPosition(position: number | null, placed: boolean): string {
  if (position === null || !placed) return '—';
  return String(position);
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  // A bare YYYY-MM-DD is parsed as UTC midnight, which renders as the previous
  // day west of Greenwich. Appending a local time keeps a date of birth on the
  // date it was entered.
  const date = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T00:00:00`) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);

  if (seconds < 45) return 'just now';
  if (seconds < 90) return 'a minute ago';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 7200) return 'an hour ago';
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours ago`;
  return formatDateTime(date);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** Labels for the FSD 18.1 status enumerations. */
export const performanceStatusLabel: Record<string, string> = {
  SCHEDULED: 'Scheduled',
  ON_STAGE: 'On stage',
  IN_PROGRESS: 'Being scored',
  COMPLETE: 'Complete',
  ABSENT: 'Absent',
  VOID: 'Voided',
  WITHDRAWN: 'Withdrawn',
};

export const publicationStateLabel: Record<string, string> = {
  IN_PROGRESS: 'In progress',
  READY: 'Ready',
  PROVISIONAL: 'Provisional',
  PUBLISHED: 'Published',
  WITHHELD: 'Withheld',
};

/** FSD 4.5 tie-break criteria, in plain language for the result sheet. */
export const tiebreakLabel: Record<string, string> = {
  JUDGE_TOP_MARK_COUNT: 'Judges who gave their item-high here',
  HIGHEST_SINGLE_MARK: 'Highest single mark',
  LOWEST_SPREAD: 'Narrowest spread',
  CHIEF_JUDGE_MARK: "Chief judge's mark",
};

export const aggregationLabel: Record<string, string> = {
  AVERAGE: 'Average',
  SUM: 'Sum',
  TRIMMED_MEAN: 'Trimmed mean',
  WEIGHTED_AVERAGE: 'Weighted average',
};

export function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}
