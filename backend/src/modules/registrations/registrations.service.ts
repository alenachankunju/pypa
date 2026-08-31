/**
 * Registration service (FSD 5.6).
 *
 * "Registrations can be maintained from the member record (one member, many
 * items) or from the item record (one item, many members). Both views operate on
 * the same underlying data." — which is why this logic lives in a service both
 * the members and registrations routers call, rather than in either router.
 */
import { db, type Executor } from '../../db/pool.js';
import { AuditAction, writeAudit, type AuditActor } from '../../services/audit.js';
import {
  assertEntryCaps,
  assertTeamValid,
  checkItemEligibility,
} from '../../services/eligibility.js';
import { errors } from '../../utils/errors.js';

export interface CreateRegistrationInput {
  eventId: string;
  itemId: string;
  memberId: string;
  churchId: string;
  /** ADM-05-04: required where the member is not eligible for the item. */
  eligibilityOverrideReason?: string;
  callOrder?: number | null;
}

export interface RegistrationSummary {
  id: string;
  itemId: string;
  itemName: string;
  memberId: string | null;
  status: string;
  isLateEntry: boolean;
  eligibilityOverrideReason: string | null;
}

/**
 * Register one member for one item.
 *
 * Order of checks matters. Eligibility (4.2.6) is evaluated before the entry caps
 * (4.2.7, 4.2.8) so an ineligible entry is refused on the substantive ground
 * rather than on a cap it happens to also breach — ADM-06-03 requires the
 * message to name the rule that was actually broken.
 */
export async function createRegistration(
  input: CreateRegistrationInput,
  actor: AuditActor,
  userId: string,
  executor?: Executor,
): Promise<RegistrationSummary> {
  const run = async (trx: Executor): Promise<RegistrationSummary> => {
    const [member, item] = await Promise.all([
      trx
        .selectFrom('members')
        .select(['id', 'full_name', 'chest_number', 'category_id', 'gender', 'is_active', 'church_id'])
        .where('id', '=', input.memberId)
        .executeTakeFirst(),
      trx
        .selectFrom('items as i')
        .leftJoin('categories as c', 'c.id', 'i.category_id')
        .select([
          'i.id',
          'i.name',
          'i.type',
          'i.category_id',
          'i.open_to_all_categories',
          'i.gender_restriction',
          'i.is_active',
          'i.status',
          'c.name as category_name',
        ])
        .where('i.id', '=', input.itemId)
        .executeTakeFirst(),
    ]);

    if (!member) throw errors.notFound('Member', input.memberId);
    if (!item) throw errors.notFound('Item', input.itemId);

    if (item.type === 'GROUP') {
      throw errors.validation(
        `"${item.name}" is a group item. Register a team rather than an individual member (FSD ADM-06-04).`,
      );
    }
    if (item.status === 'CANCELLED') {
      throw errors.conflict(`"${item.name}" has been cancelled and is not accepting entries.`);
    }

    // FSD 9.4 INELIGIBLE_ITEM (4.2.6).
    const problems = checkItemEligibility(
      {
        categoryId: member.category_id,
        gender: member.gender,
        isActive: member.is_active,
        fullName: member.full_name,
      },
      {
        categoryId: item.category_id,
        openToAllCategories: item.open_to_all_categories,
        genderRestriction: item.gender_restriction,
        isActive: item.is_active,
        name: item.name,
        categoryName: item.category_name,
      },
    );

    if (problems.length > 0 && !input.eligibilityOverrideReason) {
      throw errors.ineligibleItem(
        `${member.full_name} (chest ${member.chest_number}) is not eligible for "${item.name}". ${problems
          .map((p) => p.message)
          .join(' ')}`,
        { problems, requiresOverride: 'eligibilityOverrideReason' },
      );
    }

    // FSD 9.4 ENTRY_LIMIT_EXCEEDED (4.2.7, 4.2.8, ADM-06-03).
    await assertEntryCaps(
      {
        eventId: input.eventId,
        itemId: input.itemId,
        memberId: input.memberId,
        churchId: input.churchId,
      },
      trx,
    );

    // FSD 12.2: "A registration is added after the item has started — Permitted
    // only while the session is open, and flagged as a late entry in the audit
    // log and on the result sheet."
    const isLateEntry = await itemHasStarted(input.itemId, trx);

    const row = await trx
      .insertInto('registrations')
      .values({
        event_id: input.eventId,
        item_id: input.itemId,
        member_id: input.memberId,
        church_id: input.churchId,
        is_late_entry: isLateEntry,
        eligibility_override_reason: input.eligibilityOverrideReason ?? null,
        call_order: input.callOrder ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(
      {
        eventId: input.eventId,
        actor,
        action: input.eligibilityOverrideReason
          ? AuditAction.ELIGIBILITY_OVERRIDDEN
          : AuditAction.CREATED,
        entityType: 'registration',
        entityId: row.id,
        newValue: {
          itemId: input.itemId,
          itemName: item.name,
          memberId: input.memberId,
          chestNumber: member.chest_number,
          isLateEntry,
        },
        reason:
          input.eligibilityOverrideReason ??
          (isLateEntry ? 'Late entry: added after judging for this item had begun (FSD 12.2).' : null),
      },
      trx,
    );

    return {
      id: row.id,
      itemId: row.item_id,
      itemName: item.name,
      memberId: row.member_id,
      status: row.status,
      isLateEntry: row.is_late_entry,
      eligibilityOverrideReason: row.eligibility_override_reason,
    };
  };

  return executor ? run(executor) : db.transaction().execute(run);
}

/**
 * ADM-06-04: register a TEAM for a group item.
 *
 * "a registration represents a team: it has a team name, an owning church, and a
 * list of member chest numbers within the configured size range. All team
 * members must belong to the owning church."
 */
export async function createTeamRegistration(
  input: {
    eventId: string;
    itemId: string;
    teamName: string;
    churchId: string;
    memberIds: string[];
    teamLeaderId?: string;
    callOrder?: number | null;
  },
  actor: AuditActor,
  userId: string,
): Promise<RegistrationSummary> {
  return db.transaction().execute(async (trx) => {
    const item = await trx
      .selectFrom('items')
      .select(['id', 'name', 'type', 'status'])
      .where('id', '=', input.itemId)
      .executeTakeFirst();
    if (!item) throw errors.notFound('Item', input.itemId);
    if (item.status === 'CANCELLED') {
      throw errors.conflict(`"${item.name}" has been cancelled and is not accepting entries.`);
    }

    await assertTeamValid(
      { itemId: input.itemId, churchId: input.churchId, memberIds: input.memberIds },
      trx,
    );

    await assertEntryCaps(
      { eventId: input.eventId, itemId: input.itemId, memberId: null, churchId: input.churchId },
      trx,
    );

    const isLateEntry = await itemHasStarted(input.itemId, trx);

    const registration = await trx
      .insertInto('registrations')
      .values({
        event_id: input.eventId,
        item_id: input.itemId,
        member_id: null,
        team_name: input.teamName.trim(),
        church_id: input.churchId,
        is_late_entry: isLateEntry,
        call_order: input.callOrder ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // item_id is denormalised onto registration_members so the unique index
    // enforces FSD 4.2.5 across individual and team entries alike.
    await trx
      .insertInto('registration_members')
      .values(
        input.memberIds.map((memberId) => ({
          registration_id: registration.id,
          member_id: memberId,
          item_id: input.itemId,
          is_team_leader: memberId === input.teamLeaderId,
          created_by: userId,
          updated_by: userId,
        })),
      )
      .execute();

    await writeAudit(
      {
        eventId: input.eventId,
        actor,
        action: AuditAction.CREATED,
        entityType: 'registration',
        entityId: registration.id,
        newValue: {
          itemId: input.itemId,
          itemName: item.name,
          teamName: input.teamName,
          memberIds: input.memberIds,
          isLateEntry,
        },
        reason: isLateEntry ? 'Late entry: added after judging for this item had begun (FSD 12.2).' : null,
      },
      trx,
    );

    return {
      id: registration.id,
      itemId: registration.item_id,
      itemName: item.name,
      memberId: null,
      status: registration.status,
      isLateEntry: registration.is_late_entry,
      eligibilityOverrideReason: null,
    };
  });
}

/**
 * ADM-06-05: "A registration can be withdrawn before scoring begins. Withdrawal
 * is a state change, not a deletion."
 * ADM-06-06: "A registration cannot be removed once a score exists against its
 * performance."
 */
export async function withdrawRegistration(
  registrationId: string,
  reason: string | null,
  actor: AuditActor,
  userId: string,
): Promise<{ id: string; status: string }> {
  return db.transaction().execute(async (trx) => {
    const registration = await trx
      .selectFrom('registrations as r')
      .innerJoin('items as i', 'i.id', 'r.item_id')
      .leftJoin('members as m', 'm.id', 'r.member_id')
      .select([
        'r.id',
        'r.event_id',
        'r.status',
        'r.item_id',
        'i.name as item_name',
        'm.full_name as member_name',
        'r.team_name',
      ])
      .where('r.id', '=', registrationId)
      .executeTakeFirst();

    if (!registration) throw errors.notFound('Registration', registrationId);
    if (registration.status === 'WITHDRAWN') {
      throw errors.conflict('This registration has already been withdrawn.');
    }

    const { count } = await trx
      .selectFrom('scores as s')
      .innerJoin('performances as p', 'p.id', 's.performance_id')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('p.registration_id', '=', registrationId)
      .where('s.revoked', '=', false)
      .executeTakeFirstOrThrow();

    if (Number(count) > 0) {
      throw errors.inUse(
        `This entry already has ${count} submitted mark(s) and cannot be withdrawn (FSD ADM-06-06). Void the performance instead, with a reason.`,
        { scoreCount: Number(count) },
      );
    }

    await trx
      .updateTable('registrations')
      .set({
        status: 'WITHDRAWN',
        withdrawn_at: new Date(),
        withdrawn_reason: reason,
        updated_by: userId,
      })
      .where('id', '=', registrationId)
      .execute();

    // 7.1: a scheduled performance for a withdrawn registration becomes
    // WITHDRAWN too, so the result sheet accounts for the empty slot.
    await trx
      .updateTable('performances')
      .set({ status: 'WITHDRAWN', updated_by: userId })
      .where('registration_id', '=', registrationId)
      .where('status', 'in', ['SCHEDULED', 'ON_STAGE'])
      .execute();

    await writeAudit(
      {
        eventId: registration.event_id,
        actor,
        action: AuditAction.UPDATED,
        entityType: 'registration',
        entityId: registrationId,
        oldValue: { status: 'REGISTERED' },
        newValue: { status: 'WITHDRAWN' },
        reason:
          reason ??
          `Withdrawn from "${registration.item_name}" (${registration.member_name ?? registration.team_name}).`,
      },
      trx,
    );

    return { id: registrationId, status: 'WITHDRAWN' };
  });
}

/**
 * Whether judging has begun for an item, which makes a new entry a late entry
 * (FSD 12.2).
 */
async function itemHasStarted(itemId: string, executor: Executor): Promise<boolean> {
  const { count } = await executor
    .selectFrom('performances')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('item_id', '=', itemId)
    .where('status', 'in', ['ON_STAGE', 'IN_PROGRESS', 'COMPLETE'])
    .executeTakeFirstOrThrow();

  return Number(count) > 0;
}
