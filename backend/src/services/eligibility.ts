/**
 * Identity and eligibility rules (FSD 4.2).
 *
 * These are the rules that decide who may enter what. They are enforced here,
 * server-side, and mirrored in the interface as a convenience — FSD 11.2 is
 * explicit that "interface-level hiding is a convenience, never a control".
 */
import type { Executor } from '../db/pool.js';
import { db } from '../db/pool.js';
import type { Gender, GenderRestriction } from '../db/schema.js';
import { AppError, ErrorCode, errors } from '../utils/errors.js';

/**
 * Age as at the event cut-off date.
 *
 * ADM-03-03: "A single event-wide age cut-off date is configured in system
 * settings. Age is computed as at that date, not as at today, so a participant's
 * category does not change mid-event."
 *
 * Both dates are handled as plain calendar dates (YYYY-MM-DD strings), never as
 * timestamps. Converting either to a JS Date would apply a timezone offset, and
 * a date of birth that shifts by one day can move a participant across an age
 * band boundary — which would change their category and invalidate their
 * registrations.
 */
export function ageAtCutoff(dateOfBirth: string, cutoffDate: string): number {
  const [by, bm, bd] = dateOfBirth.slice(0, 10).split('-').map(Number) as [number, number, number];
  const [cy, cm, cd] = cutoffDate.slice(0, 10).split('-').map(Number) as [number, number, number];

  let age = cy - by;
  // Not yet had their birthday by the cut-off.
  if (cm < bm || (cm === bm && cd < bd)) age -= 1;
  return age;
}

export interface CategoryBand {
  id: string;
  name: string;
  minAge: number;
  maxAge: number;
  genderRestriction: GenderRestriction;
}

/**
 * FSD 4.2.3: "A member's category is derived automatically from their date of
 * birth against the category age bands, using a configurable cut-off date."
 *
 * Returns null where no band matches — the administrator is then told which age
 * fell outside every band, rather than the member being silently uncategorised.
 */
export function deriveCategory(
  dateOfBirth: string | null,
  gender: Gender | null,
  cutoffDate: string,
  categories: CategoryBand[],
): { category: CategoryBand | null; age: number | null; reason?: string } {
  if (!dateOfBirth) {
    return { category: null, age: null, reason: 'No date of birth recorded, so no category could be derived.' };
  }

  const age = ageAtCutoff(dateOfBirth, cutoffDate);

  const matches = categories.filter((c) => {
    if (age < c.minAge || age > c.maxAge) return false;
    if (c.genderRestriction === 'ANY') return true;
    return gender !== null && c.genderRestriction === gender;
  });

  if (matches.length === 0) {
    return {
      category: null,
      age,
      reason: `Age ${age} at the cut-off date falls outside every configured category band.`,
    };
  }

  // ADM-03-04 warns about overlapping bands but does not forbid them, so a
  // deliberate overlap is possible. The narrowest band wins: a specific band is
  // a more considered statement than a broad one that also happens to contain
  // the age.
  const narrowest = matches.reduce((best, c) =>
    c.maxAge - c.minAge < best.maxAge - best.minAge ? c : best,
  );

  return { category: narrowest, age };
}

/**
 * ADM-03-04: "The system warns if configured age bands overlap or leave gaps."
 * A warning, not an error — the committee may intend an overlap.
 */
export function checkCategoryBands(categories: CategoryBand[]): string[] {
  const warnings: string[] = [];
  const sorted = [...categories].sort((a, b) => a.minAge - b.minAge);

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i]!;
    const next = sorted[i + 1]!;

    // Only compare bands that could apply to the same person.
    const sameAudience =
      current.genderRestriction === 'ANY' ||
      next.genderRestriction === 'ANY' ||
      current.genderRestriction === next.genderRestriction;
    if (!sameAudience) continue;

    if (next.minAge <= current.maxAge) {
      warnings.push(
        `"${current.name}" (${current.minAge}–${current.maxAge}) overlaps "${next.name}" (${next.minAge}–${next.maxAge}). A member in the overlap will be placed in the narrower band.`,
      );
    } else if (next.minAge > current.maxAge + 1) {
      warnings.push(
        `There is a gap between "${current.name}" (ends at ${current.maxAge}) and "${next.name}" (starts at ${next.minAge}). Members aged ${current.maxAge + 1}–${next.minAge - 1} will have no category.`,
      );
    }
  }

  return warnings;
}

export interface EligibilityProblem {
  code: 'CATEGORY_MISMATCH' | 'GENDER_MISMATCH' | 'ITEM_INACTIVE' | 'MEMBER_INACTIVE';
  message: string;
}

/**
 * FSD 4.2.6: "A member may only register for items whose category matches the
 * member's category, unless the item is marked 'open to all categories'."
 * Plus the item's gender restriction (ADM-04-02).
 */
export function checkItemEligibility(
  member: { categoryId: string | null; gender: Gender | null; isActive: boolean; fullName: string },
  item: {
    categoryId: string | null;
    openToAllCategories: boolean;
    genderRestriction: GenderRestriction;
    isActive: boolean;
    name: string;
    categoryName?: string | null;
  },
): EligibilityProblem[] {
  const problems: EligibilityProblem[] = [];

  if (!member.isActive) {
    problems.push({
      code: 'MEMBER_INACTIVE',
      message: `${member.fullName} is deactivated and cannot be registered.`,
    });
  }
  if (!item.isActive) {
    problems.push({ code: 'ITEM_INACTIVE', message: `"${item.name}" is not active.` });
  }

  if (!item.openToAllCategories && item.categoryId !== null) {
    if (member.categoryId !== item.categoryId) {
      problems.push({
        code: 'CATEGORY_MISMATCH',
        message: `"${item.name}" is restricted to the ${item.categoryName ?? 'assigned'} category, which is not ${member.fullName}'s category.`,
      });
    }
  }

  if (item.genderRestriction !== 'ANY') {
    if (member.gender === null) {
      problems.push({
        code: 'GENDER_MISMATCH',
        message: `"${item.name}" is restricted to ${item.genderRestriction.toLowerCase()} participants, but no gender is recorded for ${member.fullName}.`,
      });
    } else if (member.gender !== item.genderRestriction) {
      problems.push({
        code: 'GENDER_MISMATCH',
        message: `"${item.name}" is restricted to ${item.genderRestriction.toLowerCase()} participants.`,
      });
    }
  }

  return problems;
}

/**
 * Entry caps (FSD 4.2.7, 4.2.8, ADM-06-03).
 *
 * "The system enforces a configurable maximum number of items per member" and
 * "An item may enforce a maximum number of entries per church".
 *
 * ADM-06-03 requires the message to NAME the rule that was breached, which is
 * why each branch spells out the configured limit rather than saying "limit
 * exceeded".
 */
export async function assertEntryCaps(
  input: {
    eventId: string;
    itemId: string;
    memberId: string | null;
    churchId: string;
    /** Set when re-checking an existing registration, to exclude it from counts. */
    excludeRegistrationId?: string;
  },
  executor: Executor = db,
): Promise<void> {
  const [item, config] = await Promise.all([
    executor
      .selectFrom('items')
      .select(['name', 'max_per_church'])
      .where('id', '=', input.itemId)
      .executeTakeFirst(),
    executor
      .selectFrom('scoring_config')
      .select('max_items_per_member')
      .where('event_id', '=', input.eventId)
      .executeTakeFirst(),
  ]);

  if (!item) throw errors.notFound('Item', input.itemId);

  // 4.2.8 / Q11: per-church cap on this item.
  if (item.max_per_church !== null) {
    let query = executor
      .selectFrom('registrations')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('item_id', '=', input.itemId)
      .where('church_id', '=', input.churchId)
      .where('status', '=', 'REGISTERED');

    if (input.excludeRegistrationId) {
      query = query.where('id', '!=', input.excludeRegistrationId);
    }

    const { count } = await query.executeTakeFirstOrThrow();

    if (Number(count) >= item.max_per_church) {
      throw errors.entryLimitExceeded(
        `"${item.name}" allows a maximum of ${item.max_per_church} ${
          item.max_per_church === 1 ? 'entry' : 'entries'
        } per church, and this church already has ${count}.`,
        { rule: 'MAX_PER_CHURCH', limit: item.max_per_church, current: Number(count) },
      );
    }
  }

  // 4.2.7 / Q10: per-member item cap. Null means unlimited.
  if (input.memberId && config?.max_items_per_member) {
    let query = executor
      .selectFrom('registrations')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('member_id', '=', input.memberId)
      .where('status', '=', 'REGISTERED');

    if (input.excludeRegistrationId) {
      query = query.where('id', '!=', input.excludeRegistrationId);
    }

    const { count } = await query.executeTakeFirstOrThrow();

    if (Number(count) >= config.max_items_per_member) {
      throw errors.entryLimitExceeded(
        `A member may enter at most ${config.max_items_per_member} items, and this member already has ${count}.`,
        { rule: 'MAX_ITEMS_PER_MEMBER', limit: config.max_items_per_member, current: Number(count) },
      );
    }
  }
}

/**
 * ADM-06-04: "For group items, a registration represents a team ... with a list
 * of member chest numbers within the configured size range. All team members
 * must belong to the owning church."
 *
 * FSD 12.2: a team with fewer members than the minimum is blocked "with an
 * explicit message naming the configured range".
 */
export async function assertTeamValid(
  input: { itemId: string; churchId: string; memberIds: string[] },
  executor: Executor = db,
): Promise<void> {
  const item = await executor
    .selectFrom('items')
    .select(['name', 'type', 'min_team_size', 'max_team_size'])
    .where('id', '=', input.itemId)
    .executeTakeFirst();

  if (!item) throw errors.notFound('Item', input.itemId);

  if (item.type !== 'GROUP') {
    throw errors.validation(`"${item.name}" is an individual item and does not take a team.`);
  }

  const min = item.min_team_size ?? 1;
  const max = item.max_team_size ?? Number.MAX_SAFE_INTEGER;
  const size = input.memberIds.length;

  if (size < min || size > max) {
    throw new AppError(
      ErrorCode.TEAM_SIZE_INVALID,
      `"${item.name}" requires a team of ${
        item.max_team_size === null ? `at least ${min}` : `${min} to ${item.max_team_size}`
      } members. This team has ${size}.`,
      { details: { min, max: item.max_team_size, provided: size } },
    );
  }

  if (new Set(input.memberIds).size !== size) {
    throw errors.validation('The same member is listed more than once in this team.');
  }

  // "All team members must belong to the owning church."
  const members = await executor
    .selectFrom('members')
    .select(['id', 'full_name', 'chest_number', 'church_id'])
    .where('id', 'in', input.memberIds)
    .execute();

  if (members.length !== size) {
    throw errors.validation('One or more of the listed team members could not be found.');
  }

  const outsiders = members.filter((m) => m.church_id !== input.churchId);
  if (outsiders.length > 0) {
    throw errors.validation(
      `All team members must belong to the owning church. ${outsiders
        .map((m) => `${m.full_name} (${m.chest_number})`)
        .join(', ')} ${outsiders.length === 1 ? 'does' : 'do'} not (FSD ADM-06-04).`,
      { outsiders: outsiders.map((m) => ({ id: m.id, name: m.full_name })) },
    );
  }
}
