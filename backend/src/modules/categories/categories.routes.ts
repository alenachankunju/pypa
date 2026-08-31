/**
 * Category management (FSD 5.3).
 *
 * Categories are the age and eligibility bands (Sub-Junior, Junior, Senior,
 * Super-Senior). They are event-scoped: the exact bands and the cut-off date are
 * a per-event committee decision (FSD 17, Q1).
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { actorFromRequest } from '../../services/audit.js';
import { checkCategoryBands, type CategoryBand } from '../../services/eligibility.js';
import { errors } from '../../utils/errors.js';
import { auditedDelete, auditedInsert, auditedUpdate, crudContext } from '../../utils/crud.js';
import { asyncHandler, created, ok } from '../../utils/http.js';

/** ADM-03-02 field set. */
const categorySchema = z.object({
  name: z.string().min(1).max(100),
  minAge: z.coerce.number().int().min(0).max(120),
  maxAge: z.coerce.number().int().min(0).max(120),
  genderRestriction: z.enum(['ANY', 'MALE', 'FEMALE']).default('ANY'),
  displayOrder: z.coerce.number().int().min(0).optional(),
});

const updateCategorySchema = categorySchema.partial().extend({ isActive: z.boolean().optional() });

export function categoryRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());

  /**
   * List categories with their member counts, plus the ADM-03-04 band warnings.
   *
   * The warnings ship with the list rather than only on save, so an
   * administrator reviewing the setup checklist (FSD 13, step 2) sees a gap or
   * overlap without having to edit anything.
   */
  router.get(
    '/',
    requireCapability(Capability.MANAGE_CATEGORIES),
    asyncHandler(async (req, res) => {
      const eventId = req.eventId!;

      const rows = await db
        .selectFrom('categories as c')
        .select((eb) => [
          'c.id',
          'c.name',
          'c.min_age',
          'c.max_age',
          'c.gender_restriction',
          'c.display_order',
          'c.is_active',
          eb
            .selectFrom('members as m')
            .select((i) => i.fn.countAll<number>().as('n'))
            .whereRef('m.category_id', '=', 'c.id')
            .where('m.is_active', '=', true)
            .as('member_count'),
          eb
            .selectFrom('items as it')
            .select((i) => i.fn.countAll<number>().as('n'))
            .whereRef('it.category_id', '=', 'c.id')
            .where('it.is_active', '=', true)
            .as('item_count'),
        ])
        .where('c.event_id', '=', eventId)
        .orderBy('c.display_order')
        .orderBy('c.min_age')
        .execute();

      const bands: CategoryBand[] = rows
        .filter((r) => r.is_active)
        .map((r) => ({
          id: r.id,
          name: r.name,
          minAge: r.min_age,
          maxAge: r.max_age,
          genderRestriction: r.gender_restriction,
        }));

      const event = await db
        .selectFrom('events')
        .select('age_cutoff_date')
        .where('id', '=', eventId)
        .executeTakeFirst();

      return ok(
        res,
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          minAge: r.min_age,
          maxAge: r.max_age,
          genderRestriction: r.gender_restriction,
          displayOrder: r.display_order,
          isActive: r.is_active,
          memberCount: Number(r.member_count ?? 0),
          itemCount: Number(r.item_count ?? 0),
        })),
        {
          // ADM-03-04
          bandWarnings: checkCategoryBands(bands),
          ageCutoffDate: event?.age_cutoff_date ?? null,
        },
      );
    }),
  );

  router.post(
    '/',
    requireCapability(Capability.MANAGE_CATEGORIES),
    validate({ body: categorySchema }),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof categorySchema>;
      if (input.maxAge < input.minAge) {
        throw errors.validation('The maximum age must not be lower than the minimum age.');
      }

      const row = await auditedInsert(
        'categories',
        {
          event_id: req.eventId!,
          name: input.name.trim(),
          min_age: input.minAge,
          max_age: input.maxAge,
          gender_restriction: input.genderRestriction,
          display_order: input.displayOrder ?? 0,
          created_by: req.auth!.userId,
          updated_by: req.auth!.userId,
        },
        crudContext(req, 'category', actorFromRequest(req)),
      );

      return created(res, row, { bandWarnings: await bandWarningsFor(req.eventId!) });
    }),
  );

  /**
   * FSD 12.2: "A member's date of birth is corrected, changing their category —
   * The system lists every registration that becomes ineligible and requires the
   * administrator to resolve each one before saving."
   *
   * Changing a category's BANDS has the same effect at scale, so the same
   * courtesy applies: the response reports how many members would be re-derived
   * into a different category.
   */
  router.patch(
    '/:id',
    requireCapability(Capability.MANAGE_CATEGORIES),
    validate({ params: z.object({ id: z.string().uuid() }), body: updateCategorySchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const input = req.body as z.infer<typeof updateCategorySchema>;

      const existing = await db
        .selectFrom('categories')
        .selectAll()
        .where('id', '=', id)
        .where('event_id', '=', req.eventId!)
        .executeTakeFirst();
      if (!existing) throw errors.notFound('Category', id);

      const minAge = input.minAge ?? existing.min_age;
      const maxAge = input.maxAge ?? existing.max_age;
      if (maxAge < minAge) {
        throw errors.validation('The maximum age must not be lower than the minimum age.');
      }

      const row = await auditedUpdate(
        'categories',
        id,
        {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.minAge !== undefined ? { min_age: input.minAge } : {}),
          ...(input.maxAge !== undefined ? { max_age: input.maxAge } : {}),
          ...(input.genderRestriction !== undefined
            ? { gender_restriction: input.genderRestriction }
            : {}),
          ...(input.displayOrder !== undefined ? { display_order: input.displayOrder } : {}),
          ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
          updated_by: req.auth!.userId,
        },
        crudContext(req, 'category', actorFromRequest(req)),
      );

      return ok(res, row, { bandWarnings: await bandWarningsFor(req.eventId!) });
    }),
  );

  /**
   * A category may only be deleted while nothing depends on it. Once members or
   * items reference it, deactivation is the route — the same principle as
   * ADM-02-03 for churches.
   */
  router.delete(
    '/:id',
    requireCapability(Capability.MANAGE_CATEGORIES),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      const [members, items] = await Promise.all([
        db
          .selectFrom('members')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('category_id', '=', id)
          .executeTakeFirstOrThrow(),
        db
          .selectFrom('items')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('category_id', '=', id)
          .executeTakeFirstOrThrow(),
      ]);

      if (Number(members.count) > 0 || Number(items.count) > 0) {
        throw errors.inUse(
          `This category is used by ${members.count} member(s) and ${items.count} item(s) and cannot be deleted. Deactivate it instead.`,
          { memberCount: Number(members.count), itemCount: Number(items.count) },
        );
      }

      await auditedDelete('categories', id, crudContext(req, 'category', actorFromRequest(req)));

      return ok(res, { deleted: true });
    }),
  );

  return router;
}

async function bandWarningsFor(eventId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('categories')
    .select(['id', 'name', 'min_age', 'max_age', 'gender_restriction'])
    .where('event_id', '=', eventId)
    .where('is_active', '=', true)
    .execute();

  return checkCategoryBands(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      minAge: r.min_age,
      maxAge: r.max_age,
      genderRestriction: r.gender_restriction,
    })),
  );
}
