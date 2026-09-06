/**
 * Member management (FSD 5.5).
 *
 * ADM-05-09: "A member cannot be deleted once they have any submitted score.
 * Deactivation is used instead." Combined with 4.2.2 — the chest number "cannot
 * be reused, even after a member is deleted" — soft deletion is the only removal
 * path, and the retained row is what keeps the number reserved.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { AuditAction, actorFromRequest, writeAudit } from '../../services/audit.js';
import {
  ageAtCutoff,
  checkItemEligibility,
  deriveCategory,
  type CategoryBand,
} from '../../services/eligibility.js';
import { errors } from '../../utils/errors.js';
import { auditedUpdate, crudContext } from '../../utils/crud.js';
import { asyncHandler, created, ok, pageParams, paginated } from '../../utils/http.js';
import { createRegistration } from '../registrations/registrations.service.js';

/** ADM-05-02 field set. */
const memberSchema = z.object({
  chestNumber: z.string().min(1).max(30),
  fullName: z.string().min(2).max(200),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
    .optional()
    .nullable(),
  gender: z.enum(['MALE', 'FEMALE']).optional().nullable(),
  churchId: z.string().uuid(),
  /** 4.2.3: overriding the derived category requires a recorded reason. */
  categoryId: z.string().uuid().optional().nullable(),
  categoryOverrideReason: z.string().min(10).max(500).optional().nullable(),
  photoPath: z.string().max(500).optional().nullable(),
  mobile: z.string().max(40).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  /** ADM-05-03: selecting items here creates registrations. */
  itemIds: z.array(z.string().uuid()).max(50).optional(),
  /** ADM-05-04: registering an ineligible item requires a recorded reason. */
  eligibilityOverrideReason: z.string().min(10).max(500).optional(),
  /** ADM-05-05: proceed despite a possible duplicate. */
  confirmPossibleDuplicate: z.boolean().optional(),
});

const updateMemberSchema = memberSchema
  .partial()
  .omit({ itemIds: true })
  .extend({ isActive: z.boolean().optional(), confirmCategoryChange: z.boolean().optional() });

export function memberRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());

  /**
   * ADM-05-06: "The member list supports search by chest number, name or church,
   * filter by category, item and active status, and sorting by chest number or
   * name."
   */
  router.get(
    '/',
    requireCapability(Capability.MANAGE_MEMBERS),
    validate({
      query: z.object({
        search: z.string().max(200).optional(),
        churchId: z.string().uuid().optional(),
        categoryId: z.string().uuid().optional(),
        itemId: z.string().uuid().optional(),
        isActive: z.enum(['true', 'false']).optional(),
        sort: z.enum(['chest', 'name', 'church']).optional(),
        page: z.coerce.number().int().positive().optional(),
        pageSize: z.coerce.number().int().positive().max(200).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const { page, pageSize, offset } = pageParams(req.query as Record<string, unknown>);

      let base = db
        .selectFrom('members as m')
        .innerJoin('churches as c', 'c.id', 'm.church_id')
        .leftJoin('categories as cat', 'cat.id', 'm.category_id')
        .where('m.event_id', '=', req.eventId!);

      if (q.search) {
        base = base.where((eb) =>
          eb.or([
            eb('m.chest_number', 'ilike', `%${q.search}%`),
            eb('m.full_name', 'ilike', `%${q.search}%`),
            eb('c.name', 'ilike', `%${q.search}%`),
          ]),
        );
      }
      if (q.churchId) base = base.where('m.church_id', '=', q.churchId);
      if (q.categoryId) base = base.where('m.category_id', '=', q.categoryId);
      if (q.isActive) base = base.where('m.is_active', '=', q.isActive === 'true');
      if (q.itemId) {
        const itemId = q.itemId;
        base = base.where((eb) =>
          eb.exists(
            eb
              .selectFrom('registrations as r')
              .select('r.id')
              .whereRef('r.member_id', '=', 'm.id')
              .where('r.item_id', '=', itemId)
              .where('r.status', '=', 'REGISTERED'),
          ),
        );
      }

      const sorted =
        q.sort === 'name'
          ? base.orderBy('m.full_name')
          : q.sort === 'church'
            ? base.orderBy('c.name').orderBy('m.chest_number_numeric')
            : // Default: chest number, numerically where possible so 9 sorts
              // before 10 rather than after it.
              base.orderBy('m.chest_number_numeric').orderBy('m.chest_number');

      const [rows, total] = await Promise.all([
        sorted
          .select((eb) => [
            'm.id',
            'm.chest_number',
            'm.full_name',
            'm.date_of_birth',
            'm.gender',
            'm.church_id',
            'm.category_id',
            'm.derived_category_id',
            'm.category_override_reason',
            'm.photo_path',
            'm.mobile',
            'm.is_active',
            'c.name as church_name',
            'c.short_code as church_short_code',
            'cat.name as category_name',
            eb
              .selectFrom('registrations as r')
              .select((s) => s.fn.countAll<number>().as('n'))
              .whereRef('r.member_id', '=', 'm.id')
              .where('r.status', '=', 'REGISTERED')
              .as('item_count'),
          ])
          .limit(pageSize)
          .offset(offset)
          .execute(),
        base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
      ]);

      return paginated(
        res,
        rows.map((r) => ({
          id: r.id,
          chestNumber: r.chest_number,
          fullName: r.full_name,
          dateOfBirth: r.date_of_birth,
          gender: r.gender,
          churchId: r.church_id,
          churchName: r.church_name,
          churchShortCode: r.church_short_code,
          categoryId: r.category_id,
          categoryName: r.category_name,
          isCategoryOverridden: r.category_id !== r.derived_category_id,
          categoryOverrideReason: r.category_override_reason,
          photoPath: r.photo_path,
          mobile: r.mobile,
          isActive: r.is_active,
          itemCount: Number(r.item_count ?? 0),
        })),
        page,
        pageSize,
        Number(total.count),
      );
    }),
  );

  /**
   * FSD 9.2: GET /api/members/by-chest/{number} — chest number lookup.
   *
   * This is the ADMIN lookup, across the whole event. The judge equivalent is
   * scoped to the judge's open session (JDG-03-05) and lives in the judge module.
   */
  router.get(
    '/by-chest/:chestNumber',
    requireCapability(Capability.MANAGE_MEMBERS),
    validate({ params: z.object({ chestNumber: z.string().min(1).max(30) }) }),
    asyncHandler(async (req, res) => {
      const { chestNumber } = req.params as { chestNumber: string };

      const member = await db
        .selectFrom('members as m')
        .innerJoin('churches as c', 'c.id', 'm.church_id')
        .leftJoin('categories as cat', 'cat.id', 'm.category_id')
        .select([
          'm.id',
          'm.chest_number',
          'm.full_name',
          'm.gender',
          'm.photo_path',
          'm.is_active',
          'c.name as church_name',
          'cat.name as category_name',
        ])
        .where('m.event_id', '=', req.eventId!)
        .where('m.chest_number', '=', chestNumber)
        .executeTakeFirst();

      if (!member) throw errors.notFound('Participant with chest number', chestNumber);
      return ok(res, member);
    }),
  );

  router.get(
    '/:id',
    requireCapability(Capability.MANAGE_MEMBERS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      const member = await db
        .selectFrom('members as m')
        .innerJoin('churches as c', 'c.id', 'm.church_id')
        .leftJoin('categories as cat', 'cat.id', 'm.category_id')
        .selectAll('m')
        .select(['c.name as church_name', 'cat.name as category_name'])
        .where('m.id', '=', id)
        .where('m.event_id', '=', req.eventId!)
        .executeTakeFirst();
      if (!member) throw errors.notFound('Member', id);

      const registrations = await db
        .selectFrom('registrations as r')
        .innerJoin('items as i', 'i.id', 'r.item_id')
        .select([
          'r.id',
          'r.status',
          'r.is_late_entry',
          'r.eligibility_override_reason',
          'i.id as item_id',
          'i.name as item_name',
          'i.code as item_code',
          'i.type as item_type',
        ])
        .where('r.member_id', '=', id)
        .orderBy('i.name')
        .execute();

      const event = await db
        .selectFrom('events')
        .select('age_cutoff_date')
        .where('id', '=', req.eventId!)
        .executeTakeFirst();

      return ok(res, {
        ...member,
        ageAtCutoff:
          member.date_of_birth && event
            ? ageAtCutoff(String(member.date_of_birth), String(event.age_cutoff_date))
            : null,
        isCategoryOverridden: member.category_id !== member.derived_category_id,
        registrations,
      });
    }),
  );

  /**
   * Create a member, deriving their category and optionally registering them for
   * items in the same request (ADM-05-03).
   */
  router.post(
    '/',
    requireCapability(Capability.MANAGE_MEMBERS),
    validate({ body: memberSchema }),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof memberSchema>;
      const eventId = req.eventId!;
      const actor = actorFromRequest(req);

      // FSD 9.4 DUPLICATE_CHEST_NUMBER, checked ahead of the insert so the
      // message can name the existing holder (FSD 12.2: "Rejected at save with
      // the name of the existing holder shown").
      const clash = await db
        .selectFrom('members')
        .select(['full_name', 'chest_number'])
        .where('event_id', '=', eventId)
        .where('chest_number', '=', input.chestNumber)
        .executeTakeFirst();
      if (clash) throw errors.duplicateChestNumber(input.chestNumber, clash.full_name);

      // ADM-05-05: "on save, the system warns if a member with the same name and
      // date of birth already exists in the same church."
      if (!input.confirmPossibleDuplicate && input.dateOfBirth) {
        const duplicate = await db
          .selectFrom('members')
          .select(['id', 'chest_number', 'full_name'])
          .where('event_id', '=', eventId)
          .where('church_id', '=', input.churchId)
          .where('full_name', 'ilike', input.fullName.trim())
          .where('date_of_birth', '=', input.dateOfBirth)
          .executeTakeFirst();

        if (duplicate) {
          throw errors.conflict(
            `${duplicate.full_name} (chest ${duplicate.chest_number}) already exists in this church with the same name and date of birth. Confirm to add anyway (FSD ADM-05-05).`,
            { requiresConfirmation: 'confirmPossibleDuplicate', existing: duplicate },
          );
        }
      }

      const { categoryId, derivedCategoryId, overrideReason } = await resolveCategory(
        eventId,
        input.dateOfBirth ?? null,
        input.gender ?? null,
        input.categoryId ?? undefined,
        input.categoryOverrideReason ?? undefined,
      );

      const member = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('members')
          .values({
            event_id: eventId,
            chest_number: input.chestNumber.trim(),
            full_name: input.fullName.trim(),
            date_of_birth: input.dateOfBirth ?? null,
            gender: input.gender ?? null,
            church_id: input.churchId,
            category_id: categoryId,
            derived_category_id: derivedCategoryId,
            category_override_reason: overrideReason,
            photo_path: input.photoPath ?? null,
            mobile: input.mobile ?? null,
            notes: input.notes ?? null,
            created_by: req.auth!.userId,
            updated_by: req.auth!.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          {
            eventId,
            actor,
            action: AuditAction.CREATED,
            entityType: 'member',
            entityId: row.id,
            newValue: { chestNumber: row.chest_number, fullName: row.full_name, churchId: row.church_id },
          },
          trx,
        );

        // 4.2.3: an override is audited separately, with its reason, because it
        // is a decision rather than a data entry.
        if (overrideReason) {
          await writeAudit(
            {
              eventId,
              actor,
              action: AuditAction.CATEGORY_OVERRIDDEN,
              entityType: 'member',
              entityId: row.id,
              oldValue: { categoryId: derivedCategoryId },
              newValue: { categoryId },
              reason: overrideReason,
            },
            trx,
          );
        }

        return row;
      });

      // ADM-05-03: item multi-select creates registrations.
      const registrations = [];
      for (const itemId of input.itemIds ?? []) {
        registrations.push(
          await createRegistration(
            {
              eventId,
              itemId,
              memberId: member.id,
              churchId: member.church_id,
              eligibilityOverrideReason: input.eligibilityOverrideReason,
            },
            actor,
            req.auth!.userId,
          ),
        );
      }

      return created(res, { ...member, registrations });
    }),
  );

  /**
   * Update a member.
   *
   * FSD 12.2 covers two changes that need special handling:
   *
   *   "A member changes church after registration — Permitted only before any
   *   score exists. Afterwards it is blocked, because points already earned are
   *   attributed to the original church."
   *
   *   "A member's date of birth is corrected, changing their category — The
   *   system lists every registration that becomes ineligible and requires the
   *   administrator to resolve each one before saving."
   */
  router.patch(
    '/:id',
    requireCapability(Capability.MANAGE_MEMBERS),
    validate({ params: z.object({ id: z.string().uuid() }), body: updateMemberSchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const input = req.body as z.infer<typeof updateMemberSchema>;
      const eventId = req.eventId!;

      const existing = await db
        .selectFrom('members')
        .selectAll()
        .where('id', '=', id)
        .where('event_id', '=', eventId)
        .executeTakeFirst();
      if (!existing) throw errors.notFound('Member', id);

      const scoreCount = await countScoresFor(id);

      // 12.2: church change blocked once a score exists.
      if (input.churchId && input.churchId !== existing.church_id && scoreCount > 0) {
        throw errors.conflict(
          `${existing.full_name} already has ${scoreCount} submitted mark(s), so their church cannot be changed. Points already earned are attributed to the original church (FSD 12.2).`,
          { scoreCount },
        );
      }

      // Re-derive the category whenever an input to the derivation changes.
      const dobChanged = input.dateOfBirth !== undefined && input.dateOfBirth !== existing.date_of_birth;
      const genderChanged = input.gender !== undefined && input.gender !== existing.gender;
      const categoryExplicit = input.categoryId !== undefined;

      let categoryId = existing.category_id;
      let derivedCategoryId = existing.derived_category_id;
      let overrideReason = existing.category_override_reason;

      if (dobChanged || genderChanged || categoryExplicit) {
        const resolved = await resolveCategory(
          eventId,
          (input.dateOfBirth ?? existing.date_of_birth) as string | null,
          (input.gender ?? existing.gender) as 'MALE' | 'FEMALE' | null,
          categoryExplicit ? (input.categoryId ?? undefined) : undefined,
          input.categoryOverrideReason ?? undefined,
        );
        categoryId = resolved.categoryId;
        derivedCategoryId = resolved.derivedCategoryId;
        overrideReason = resolved.overrideReason;
      }

      // 12.2: list registrations that the new category would invalidate.
      if (categoryId !== existing.category_id) {
        const ineligible = await findIneligibleRegistrations(id, categoryId, existing.gender);

        if (ineligible.length > 0 && !input.confirmCategoryChange) {
          throw errors.conflict(
            `Changing this member's category would make ${ineligible.length} of their registrations ineligible. Review and confirm (FSD 12.2).`,
            { requiresConfirmation: 'confirmCategoryChange', ineligible },
          );
        }
      }

      const row = await auditedUpdate(
        'members',
        id,
        {
          ...(input.chestNumber !== undefined ? { chest_number: input.chestNumber.trim() } : {}),
          ...(input.fullName !== undefined ? { full_name: input.fullName.trim() } : {}),
          ...(input.dateOfBirth !== undefined ? { date_of_birth: input.dateOfBirth } : {}),
          ...(input.gender !== undefined ? { gender: input.gender } : {}),
          ...(input.churchId !== undefined ? { church_id: input.churchId } : {}),
          ...(input.photoPath !== undefined ? { photo_path: input.photoPath } : {}),
          ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.isActive !== undefined
            ? { is_active: input.isActive, deactivated_at: input.isActive ? null : new Date() }
            : {}),
          category_id: categoryId,
          derived_category_id: derivedCategoryId,
          category_override_reason: overrideReason,
          updated_by: req.auth!.userId,
        },
        crudContext(req, 'member', actorFromRequest(req)),
        categoryId !== existing.category_id
          ? { action: AuditAction.CATEGORY_OVERRIDDEN, reason: overrideReason ?? 'Category re-derived after a change to date of birth or gender.' }
          : {},
      );

      return ok(res, row);
    }),
  );

  /**
   * ADM-05-09: a member with any submitted score cannot be deleted.
   * The database trigger members_delete_guard is the guarantee; this route makes
   * the refusal explicit and names the rule.
   */
  router.delete(
    '/:id',
    requireCapability(Capability.MANAGE_MEMBERS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      const member = await db
        .selectFrom('members')
        .select(['id', 'full_name', 'chest_number'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!member) throw errors.notFound('Member', id);

      const scoreCount = await countScoresFor(id);
      if (scoreCount > 0) {
        throw errors.inUse(
          `${member.full_name} has ${scoreCount} submitted mark(s) and cannot be deleted (FSD ADM-05-09). Deactivate them instead — chest number ${member.chest_number} stays reserved either way (FSD 4.2.2).`,
          { scoreCount },
        );
      }

      // Deactivation rather than deletion, so the chest number stays reserved.
      const row = await auditedUpdate(
        'members',
        id,
        { is_active: false, deactivated_at: new Date(), updated_by: req.auth!.userId },
        crudContext(req, 'member', actorFromRequest(req)),
        { reason: 'Member removed. Deactivated rather than deleted so the chest number remains reserved (FSD 4.2.2).' },
      );

      return ok(res, {
        deactivated: true,
        chestNumberReserved: member.chest_number,
        member: row,
      });
    }),
  );

  /**
   * ADM-05-04: the eligible-item list for a member, used by the multi-select.
   *
   * "The multi-select only offers items the member is eligible for, based on
   * category and gender, unless the administrator switches on 'show ineligible
   * items'."
   *
   * INDIVIDUAL items only: this drives a single member's own registration, and
   * createRegistration() (registrations.service.ts) refuses a GROUP item
   * outright regardless of category/gender fit — ADM-06-04 registers those as
   * a team instead, with its own member roster. A GROUP item like "open to all
   * categories" would otherwise pass this endpoint's category/gender check for
   * nearly every member and show up as "eligible" here despite never actually
   * being addable this way.
   */
  router.get(
    '/:id/eligible-items',
    requireCapability(Capability.MANAGE_MEMBERS),
    validate({
      params: z.object({ id: z.string().uuid() }),
      query: z.object({ includeIneligible: z.enum(['true', 'false']).optional() }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const includeIneligible = (req.query as { includeIneligible?: string }).includeIneligible === 'true';

      const member = await db
        .selectFrom('members')
        .select(['id', 'full_name', 'category_id', 'gender', 'is_active'])
        .where('id', '=', id)
        .where('event_id', '=', req.eventId!)
        .executeTakeFirst();
      if (!member) throw errors.notFound('Member', id);

      const [items, registered] = await Promise.all([
        db
          .selectFrom('items as i')
          .leftJoin('categories as c', 'c.id', 'i.category_id')
          .select([
            'i.id',
            'i.name',
            'i.code',
            'i.type',
            'i.category_id',
            'i.open_to_all_categories',
            'i.gender_restriction',
            'i.is_active',
            'i.stage',
            'c.name as category_name',
          ])
          .where('i.event_id', '=', req.eventId!)
          .where('i.status', '=', 'ACTIVE')
          .where('i.is_active', '=', true)
          .where('i.type', '=', 'INDIVIDUAL')
          .orderBy('i.display_order')
          .orderBy('i.name')
          .execute(),
        db
          .selectFrom('registrations')
          .select(['item_id', 'status'])
          .where('member_id', '=', id)
          .execute(),
      ]);

      const registeredItemIds = new Set(
        registered.filter((r) => r.status === 'REGISTERED').map((r) => r.item_id),
      );

      const evaluated = items.map((item) => {
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

        return {
          id: item.id,
          name: item.name,
          code: item.code,
          type: item.type,
          stage: item.stage,
          categoryName: item.category_name,
          eligible: problems.length === 0,
          problems,
          alreadyRegistered: registeredItemIds.has(item.id),
        };
      });

      return ok(res, includeIneligible ? evaluated : evaluated.filter((i) => i.eligible));
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * FSD 4.2.3: derive the category from date of birth, and treat any explicit
 * choice that differs from the derivation as an override requiring a reason.
 */
async function resolveCategory(
  eventId: string,
  dateOfBirth: string | null,
  gender: 'MALE' | 'FEMALE' | null,
  explicitCategoryId: string | null | undefined,
  overrideReason: string | undefined,
): Promise<{ categoryId: string | null; derivedCategoryId: string | null; overrideReason: string | null }> {
  const [event, categories] = await Promise.all([
    db.selectFrom('events').select('age_cutoff_date').where('id', '=', eventId).executeTakeFirstOrThrow(),
    db
      .selectFrom('categories')
      .select(['id', 'name', 'min_age', 'max_age', 'gender_restriction'])
      .where('event_id', '=', eventId)
      .where('is_active', '=', true)
      .execute(),
  ]);

  const bands: CategoryBand[] = categories.map((c) => ({
    id: c.id,
    name: c.name,
    minAge: c.min_age,
    maxAge: c.max_age,
    genderRestriction: c.gender_restriction,
  }));

  const derived = deriveCategory(
    dateOfBirth ? String(dateOfBirth) : null,
    gender,
    String(event.age_cutoff_date),
    bands,
  );
  const derivedCategoryId = derived.category?.id ?? null;

  if (explicitCategoryId === undefined) {
    return { categoryId: derivedCategoryId, derivedCategoryId, overrideReason: null };
  }

  if (explicitCategoryId === derivedCategoryId) {
    return { categoryId: derivedCategoryId, derivedCategoryId, overrideReason: null };
  }

  // The override is a deliberate deviation from the rules, so 4.2.3 requires it
  // to be justified: "the override is recorded in the audit log with a reason".
  if (!overrideReason) {
    throw errors.validation(
      derived.category
        ? `This member's date of birth places them in "${derived.category.name}". Choosing a different category is an override and requires a recorded reason (FSD 4.2.3).`
        : 'No category could be derived from this date of birth, so choosing one is an override and requires a recorded reason (FSD 4.2.3).',
      { derivedCategoryId, derivedCategoryName: derived.category?.name ?? null, derivationNote: derived.reason },
    );
  }

  return { categoryId: explicitCategoryId, derivedCategoryId, overrideReason };
}

async function countScoresFor(memberId: string): Promise<number> {
  const { count } = await db
    .selectFrom('scores as s')
    .innerJoin('performances as p', 'p.id', 's.performance_id')
    .innerJoin('registrations as r', 'r.id', 'p.registration_id')
    .leftJoin('registration_members as rm', 'rm.registration_id', 'r.id')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where((eb) => eb.or([eb('r.member_id', '=', memberId), eb('rm.member_id', '=', memberId)]))
    .executeTakeFirstOrThrow();

  return Number(count);
}

/** FSD 12.2: which of this member's registrations a new category would invalidate. */
async function findIneligibleRegistrations(
  memberId: string,
  newCategoryId: string | null,
  gender: 'MALE' | 'FEMALE' | null,
): Promise<{ registrationId: string; itemName: string; reason: string }[]> {
  const registrations = await db
    .selectFrom('registrations as r')
    .innerJoin('items as i', 'i.id', 'r.item_id')
    .leftJoin('categories as c', 'c.id', 'i.category_id')
    .select([
      'r.id',
      'i.name as item_name',
      'i.category_id',
      'i.open_to_all_categories',
      'i.gender_restriction',
      'c.name as category_name',
    ])
    .where('r.member_id', '=', memberId)
    .where('r.status', '=', 'REGISTERED')
    .execute();

  return registrations
    .filter((r) => {
      if (r.open_to_all_categories || r.category_id === null) {
        return r.gender_restriction !== 'ANY' && gender !== r.gender_restriction;
      }
      return r.category_id !== newCategoryId;
    })
    .map((r) => ({
      registrationId: r.id,
      itemName: r.item_name,
      reason: `"${r.item_name}" is restricted to the ${r.category_name ?? 'assigned'} category.`,
    }));
}
