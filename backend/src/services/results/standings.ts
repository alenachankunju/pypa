/**
 * Championship standings (FSD 4.7, 7.6).
 *
 * Every total here derives from PUBLISHED items only — enforced in the views
 * v_church_leaderboard and v_member_points (migration 0010). FSD 4.7.4 is
 * explicit: "A church's total is the sum of all points earned by its members
 * across all published items." A provisional or withheld item contributes
 * nothing, which is what makes ADM-12-09's unpublished count meaningful.
 */
import { db } from '../../db/pool.js';
import { loadScoringRules } from './context.js';

/** How a rank was decided, so the leaderboard can explain itself (FSD 7.6). */
export type StandingsTiebreak =
  | 'POINTS'
  | 'FIRST_PLACES'
  | 'SECOND_PLACES'
  | 'AGGREGATE_TOTAL'
  | 'UNRESOLVED';

export interface ChurchStanding {
  rank: number;
  churchId: string;
  churchName: string;
  shortCode: string;
  totalPoints: number;
  firstPlaces: number;
  secondPlaces: number;
  thirdPlaces: number;
  placedCount: number;
  itemsEntered: number;
  memberCount: number;
  aggregateTotal: number;
  isChampion: boolean;
  /** True where this church shares its rank with another. */
  isTied: boolean;
  decidedBy: StandingsTiebreak;
}

/**
 * ADM-12-06: "Church leaderboard: total points, first-place count, second-place
 * count, participant count, ranked, with the champion highlighted."
 *
 * FSD 7.6 tie-break order:
 *   1. greater count of 1st positions
 *   2. greater count of 2nd positions
 *   3. higher sum of aggregate scores across all items
 *   4. flag for manual committee decision
 *
 * Criterion 4 is a flag, not a guess — the same principle as FSD 4.5's
 * "Silent tie-breaking is prohibited". Two churches that survive all three
 * automated criteria are returned sharing a rank with decidedBy = 'UNRESOLVED',
 * and the interface shows the committee that a decision is required.
 */
export async function churchLeaderboard(eventId: string): Promise<ChurchStanding[]> {
  const [rows, memberCounts] = await Promise.all([
    db
      .selectFrom('v_church_leaderboard')
      .selectAll()
      .where('event_id', '=', eventId)
      .execute(),
    db
      .selectFrom('members')
      .select((eb) => ['church_id', eb.fn.countAll<number>().as('member_count')])
      .where('event_id', '=', eventId)
      .where('is_active', '=', true)
      .groupBy('church_id')
      .execute(),
  ]);

  const membersByChurch = new Map(memberCounts.map((m) => [m.church_id, Number(m.member_count)]));

  // A church that has entered but not yet scored still belongs on the board with
  // zero points; the view only returns churches with at least one result row, so
  // the zero-point churches are added here rather than being silently absent.
  const scoredChurchIds = new Set(rows.map((r) => r.church_id));
  const unscored = await db
    .selectFrom('churches as c')
    .innerJoin('members as m', 'm.church_id', 'c.id')
    .select(['c.id as church_id', 'c.name as church_name', 'c.short_code'])
    .where('m.event_id', '=', eventId)
    .where('c.is_active', '=', true)
    .groupBy(['c.id', 'c.name', 'c.short_code'])
    .execute();

  const combined = [
    ...rows.map((r) => ({
      churchId: r.church_id,
      churchName: r.church_name,
      shortCode: r.short_code,
      totalPoints: Number(r.total_points),
      firstPlaces: Number(r.first_places),
      secondPlaces: Number(r.second_places),
      thirdPlaces: Number(r.third_places),
      placedCount: Number(r.placed_count),
      itemsEntered: Number(r.items_entered),
      aggregateTotal: Number(r.aggregate_total),
    })),
    ...unscored
      .filter((c) => !scoredChurchIds.has(c.church_id))
      .map((c) => ({
        churchId: c.church_id,
        churchName: c.church_name,
        shortCode: c.short_code,
        totalPoints: 0,
        firstPlaces: 0,
        secondPlaces: 0,
        thirdPlaces: 0,
        placedCount: 0,
        itemsEntered: 0,
        aggregateTotal: 0,
      })),
  ];

  // FSD 7.6 comparison chain, applied in order.
  combined.sort(
    (a, b) =>
      b.totalPoints - a.totalPoints ||
      b.firstPlaces - a.firstPlaces ||
      b.secondPlaces - a.secondPlaces ||
      b.aggregateTotal - a.aggregateTotal,
  );

  return assignRanks(combined, (a, b) => {
    if (a.totalPoints !== b.totalPoints) return 'POINTS';
    if (a.firstPlaces !== b.firstPlaces) return 'FIRST_PLACES';
    if (a.secondPlaces !== b.secondPlaces) return 'SECOND_PLACES';
    if (a.aggregateTotal !== b.aggregateTotal) return 'AGGREGATE_TOTAL';
    return 'UNRESOLVED';
  }).map((row, index, all) => ({
    ...row,
    memberCount: membersByChurch.get(row.churchId) ?? 0,
    // ADM-12-06: the champion is highlighted. Where the top rank is shared and
    // unresolved, both are flagged as champion and the committee decides.
    isChampion: row.rank === 1 && all[0]!.totalPoints > 0,
  }));
}

export interface MemberStanding {
  rank: number;
  memberId: string;
  chestNumber: string;
  fullName: string;
  churchId: string;
  churchName: string;
  categoryId: string | null;
  categoryName: string | null;
  totalPoints: number;
  itemsCompeted: number;
  firstPlaces: number;
  secondPlaces: number;
  thirdPlaces: number;
  aggregateTotal: number;
  /** 4.7.8: whether the minimum-participation rule is met. */
  eligible: boolean;
  ineligibleReason: string | null;
  isChampion: boolean;
  isTied: boolean;
  decidedBy: StandingsTiebreak;
}

/**
 * ADM-12-07: individual champion, and category champions where enabled.
 *
 * FSD 4.7.6: "The individual champion is the member with the highest total
 * personal points across the items they entered. Ties are broken by number of
 * first places, then by higher total aggregate score."
 *
 * FSD 4.7.8: "A minimum-participation rule may be configured, requiring a member
 * to have competed in at least N items to be eligible for individual champion."
 * Ineligible members are RETURNED rather than filtered out, marked with the
 * reason — an administrator preparing the announcement needs to see that a
 * high-scoring member was excluded and why, not find them silently missing.
 */
export async function individualStandings(
  eventId: string,
  options: { categoryId?: string; limit?: number } = {},
): Promise<MemberStanding[]> {
  const rules = await loadScoringRules(eventId);
  const minItems = rules === null ? 0 : await minItemsForChampion(eventId);

  let query = db
    .selectFrom('v_member_points as mp')
    .innerJoin('members as m', 'm.id', 'mp.member_id')
    .innerJoin('churches as c', 'c.id', 'm.church_id')
    .leftJoin('categories as cat', 'cat.id', 'm.category_id')
    .select([
      'mp.member_id',
      'mp.total_points',
      'mp.items_competed',
      'mp.first_places',
      'mp.second_places',
      'mp.third_places',
      'mp.aggregate_total',
      'm.chest_number',
      'm.full_name',
      'm.church_id',
      'm.category_id',
      'c.name as church_name',
      'cat.name as category_name',
    ])
    .where('mp.event_id', '=', eventId);

  if (options.categoryId) {
    query = query.where('m.category_id', '=', options.categoryId);
  }

  const rows = await query.execute();

  const mapped = rows.map((r) => ({
    memberId: r.member_id,
    chestNumber: r.chest_number,
    fullName: r.full_name,
    churchId: r.church_id,
    churchName: r.church_name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    totalPoints: Number(r.total_points),
    itemsCompeted: Number(r.items_competed),
    firstPlaces: Number(r.first_places),
    secondPlaces: Number(r.second_places),
    thirdPlaces: Number(r.third_places),
    aggregateTotal: Number(r.aggregate_total),
    eligible: Number(r.items_competed) >= minItems,
    ineligibleReason:
      Number(r.items_competed) >= minItems
        ? null
        : `Competed in ${r.items_competed} item(s); at least ${minItems} are required for champion eligibility (FSD 4.7.8).`,
  }));

  // FSD 4.7.6 chain: points, then first places, then aggregate total.
  mapped.sort(
    (a, b) =>
      b.totalPoints - a.totalPoints ||
      b.firstPlaces - a.firstPlaces ||
      b.aggregateTotal - a.aggregateTotal,
  );

  const ranked = assignRanks(mapped, (a, b) => {
    if (a.totalPoints !== b.totalPoints) return 'POINTS';
    if (a.firstPlaces !== b.firstPlaces) return 'FIRST_PLACES';
    if (a.aggregateTotal !== b.aggregateTotal) return 'AGGREGATE_TOTAL';
    return 'UNRESOLVED';
  });

  // The champion is the highest-ranked ELIGIBLE member, which is not necessarily
  // rank 1 once the minimum-participation rule bites.
  const champion = ranked.find((r) => r.eligible && r.totalPoints > 0);

  const withChampion = ranked.map((row) => ({
    ...row,
    isChampion: champion !== undefined && row.memberId === champion.memberId,
  }));

  return options.limit ? withChampion.slice(0, options.limit) : withChampion;
}

/**
 * FSD 4.7.7: "Optional category champions (best Junior, best Senior, etc.) are
 * computed on the same basis, restricted to members in that category."
 */
export async function categoryChampions(eventId: string): Promise<
  { categoryId: string; categoryName: string; champion: MemberStanding | null; contenders: MemberStanding[] }[]
> {
  const config = await db
    .selectFrom('scoring_config')
    .select('compute_category_champions')
    .where('event_id', '=', eventId)
    .executeTakeFirst();

  if (config && !config.compute_category_champions) return [];

  const categories = await db
    .selectFrom('categories')
    .select(['id', 'name'])
    .where('event_id', '=', eventId)
    .where('is_active', '=', true)
    .orderBy('display_order')
    .execute();

  return Promise.all(
    categories.map(async (category) => {
      const standings = await individualStandings(eventId, { categoryId: category.id });
      return {
        categoryId: category.id,
        categoryName: category.name,
        champion: standings.find((s) => s.isChampion) ?? null,
        contenders: standings.slice(0, 10),
      };
    }),
  );
}

/**
 * ADM-12-08 "what-if" preview: standings including unpublished READY items.
 *
 * "The administrator can see provisional standings including unpublished Ready
 * items, clearly watermarked as provisional, to prepare for the announcement."
 *
 * This deliberately bypasses the PUBLISHED filter that the standings views
 * apply, so the caller MUST label the output provisional. The route that serves
 * it sets `provisional: true` in the response meta for exactly that reason.
 */
export async function provisionalChurchLeaderboard(eventId: string): Promise<ChurchStanding[]> {
  const rows = await db
    .selectFrom('item_results as ir')
    .innerJoin('item_publications as ip', 'ip.item_id', 'ir.item_id')
    .innerJoin('churches as c', 'c.id', 'ir.church_id')
    .select((eb) => [
      'ir.church_id',
      'c.name as church_name',
      'c.short_code',
      eb.fn.sum<number>('ir.points').as('total_points'),
      eb.fn.count<number>('ir.id').filterWhere('ir.position', '=', 1).as('first_places'),
      eb.fn.count<number>('ir.id').filterWhere('ir.position', '=', 2).as('second_places'),
      eb.fn.count<number>('ir.id').filterWhere('ir.position', '=', 3).as('third_places'),
      eb.fn.count<number>('ir.id').filterWhere('ir.position', 'is not', null).as('placed_count'),
      eb.fn.count<number>('ir.item_id').distinct().as('items_entered'),
      eb.fn.sum<number>('ir.aggregate_score').as('aggregate_total'),
    ])
    .where('ir.event_id', '=', eventId)
    // Everything a human has reviewed or signed off, i.e. READY and beyond.
    // WITHHELD is excluded: FSD 4.8 says a withheld item is "excluded from
    // totals with a visible warning".
    .where('ip.state', 'in', ['READY', 'PROVISIONAL', 'PUBLISHED'])
    .groupBy(['ir.church_id', 'c.name', 'c.short_code'])
    .execute();

  const mapped = rows.map((r) => ({
    churchId: r.church_id!,
    churchName: r.church_name,
    shortCode: r.short_code,
    totalPoints: Number(r.total_points ?? 0),
    firstPlaces: Number(r.first_places),
    secondPlaces: Number(r.second_places),
    thirdPlaces: Number(r.third_places),
    placedCount: Number(r.placed_count),
    itemsEntered: Number(r.items_entered),
    aggregateTotal: Number(r.aggregate_total ?? 0),
  }));

  mapped.sort(
    (a, b) =>
      b.totalPoints - a.totalPoints ||
      b.firstPlaces - a.firstPlaces ||
      b.secondPlaces - a.secondPlaces ||
      b.aggregateTotal - a.aggregateTotal,
  );

  return assignRanks(mapped, (a, b) => {
    if (a.totalPoints !== b.totalPoints) return 'POINTS';
    if (a.firstPlaces !== b.firstPlaces) return 'FIRST_PLACES';
    if (a.secondPlaces !== b.secondPlaces) return 'SECOND_PLACES';
    if (a.aggregateTotal !== b.aggregateTotal) return 'AGGREGATE_TOTAL';
    return 'UNRESOLVED';
  }).map((row) => ({ ...row, memberCount: 0, isChampion: row.rank === 1 && row.totalPoints > 0 }));
}

/**
 * Assign competition ranks to a pre-sorted list.
 *
 * Rows that compare equal on every criterion share a rank and the next rank
 * skips accordingly (1, 1, 3) — the same convention FSD 4.6 uses for shared
 * positions within an item. `decidedBy` records which criterion separated a row
 * from the one above it, so an UNRESOLVED value is a visible signal that the
 * committee must decide (FSD 7.6 criterion 4).
 */
function assignRanks<T>(
  sorted: T[],
  compare: (a: T, b: T) => StandingsTiebreak,
): (T & { rank: number; isTied: boolean; decidedBy: StandingsTiebreak })[] {
  const out: (T & { rank: number; isTied: boolean; decidedBy: StandingsTiebreak })[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i]!;
    const previous = i > 0 ? sorted[i - 1]! : null;

    const decidedBy = previous ? compare(previous, current) : 'POINTS';
    const tiedWithPrevious = previous !== null && decidedBy === 'UNRESOLVED';
    const rank = tiedWithPrevious ? out[i - 1]!.rank : i + 1;

    out.push({ ...current, rank, isTied: tiedWithPrevious, decidedBy });
  }

  // Mark the earlier member of each tied pair as tied too — the loop above only
  // sees the relationship from the second row onwards.
  for (let i = 0; i < out.length - 1; i += 1) {
    if (out[i + 1]!.isTied) out[i]!.isTied = true;
  }

  return out;
}

async function minItemsForChampion(eventId: string): Promise<number> {
  const config = await db
    .selectFrom('scoring_config')
    .select('min_items_for_champion')
    .where('event_id', '=', eventId)
    .executeTakeFirst();
  // FSD 18.2 default, and Q14's recommended answer.
  return config?.min_items_for_champion ?? 2;
}
