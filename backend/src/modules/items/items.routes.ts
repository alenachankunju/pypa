/**
 * Item (programme) management (FSD 5.4).
 *
 * An "item" is one competition event — "Solo Song — Junior Boys", "Bible Quiz —
 * Senior". The FSD glossary uses "Item" rather than the brief's "Program" to
 * avoid confusion with the overall event programme.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { AuditAction, actorFromRequest, writeAudit } from '../../services/audit.js';
import { errors } from '../../utils/errors.js';
import { auditedDelete, auditedInsert, auditedUpdate, crudContext } from '../../utils/crud.js';
import { asyncHandler, created, ok } from '../../utils/http.js';
import { itemImportRoutes } from './itemImport.routes.js';

/** ADM-04-02 field set. */
const itemSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  categoryId: z.string().uuid().optional().nullable(),
  openToAllCategories: z.boolean().optional(),
  type: z.enum(['INDIVIDUAL', 'GROUP']).default('INDIVIDUAL'),
  genderRestriction: z.enum(['ANY', 'MALE', 'FEMALE']).default('ANY'),
  /** Overrides the event maximum; null inherits it. */
  maxMark: z.coerce.number().positive().max(1000).optional().nullable(),
  stage: z.string().max(120).optional().nullable(),
  scheduledAt: z.coerce.date().optional().nullable(),
  maxPerChurch: z.coerce.number().int().positive().optional().nullable(),
  minTeamSize: z.coerce.number().int().positive().optional().nullable(),
  maxTeamSize: z.coerce.number().int().positive().optional().nullable(),
  /** 4.7.2 — Q9 recommends 2.0 for group items. */
  weightMultiplier: z.coerce.number().positive().max(100).optional(),
  displayOrder: z.coerce.number().int().min(0).optional(),
});

const updateItemSchema = itemSchema.partial().extend({
  isActive: z.boolean().optional(),
  /** ADM-04-04: explicit acknowledgement that registrations will be affected. */
  confirmCategoryChange: z.boolean().optional(),
});

/** ADM-04-06 criteria set. */
const criteriaSchema = z.object({
  criteria: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        maxMark: z.coerce.number().positive().max(1000),
        displayOrder: z.coerce.number().int().min(0).optional(),
      }),
    )
    .max(20),
});

export function itemRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());

  /**
   * ADM-04-03: "Items are grouped in the list by category and by stage, with
   * counts of registered participants and current scoring status."
   */
  router.get(
    '/',
    requireCapability(Capability.MANAGE_ITEMS),
    validate({
      query: z.object({
        search: z.string().max(200).optional(),
        categoryId: z.string().uuid().optional(),
        stage: z.string().max(120).optional(),
        type: z.enum(['INDIVIDUAL', 'GROUP']).optional(),
        state: z.enum(['IN_PROGRESS', 'READY', 'PROVISIONAL', 'PUBLISHED', 'WITHHELD']).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const q = req.query as Record<string, string | undefined>;

      let query = db
        .selectFrom('items as i')
        .leftJoin('categories as cat', 'cat.id', 'i.category_id')
        .leftJoin('v_item_readiness as r', 'r.item_id', 'i.id')
        .select((eb) => [
          'i.id',
          'i.name',
          'i.code',
          'i.category_id',
          'i.open_to_all_categories',
          'i.type',
          'i.gender_restriction',
          'i.max_mark',
          'i.stage',
          'i.scheduled_at',
          'i.max_per_church',
          'i.min_team_size',
          'i.max_team_size',
          'i.weight_multiplier',
          'i.display_order',
          'i.status',
          'i.cancelled_reason',
          'i.is_active',
          'cat.name as category_name',
          'r.publication_state',
          'r.has_unresolved_tie',
          'r.performance_count',
          'r.complete_count',
          'r.pending_count',
          'r.is_ready',
          eb
            .selectFrom('registrations as rg')
            .select((s) => s.fn.countAll<number>().as('n'))
            .whereRef('rg.item_id', '=', 'i.id')
            .where('rg.status', '=', 'REGISTERED')
            .as('registration_count'),
          eb
            .selectFrom('item_criteria as ic')
            .select((s) => s.fn.countAll<number>().as('n'))
            .whereRef('ic.item_id', '=', 'i.id')
            .as('criteria_count'),
        ])
        .where('i.event_id', '=', req.eventId!);

      if (q.search) {
        query = query.where((eb) =>
          eb.or([eb('i.name', 'ilike', `%${q.search}%`), eb('i.code', 'ilike', `%${q.search}%`)]),
        );
      }
      if (q.categoryId) query = query.where('i.category_id', '=', q.categoryId);
      if (q.stage) query = query.where('i.stage', '=', q.stage);
      if (q.type) query = query.where('i.type', '=', q.type as 'INDIVIDUAL' | 'GROUP');
      if (q.state) query = query.where('r.publication_state', '=', q.state as never);

      const rows = await query
        .orderBy('cat.display_order')
        .orderBy('i.stage')
        .orderBy('i.display_order')
        .orderBy('i.name')
        .execute();

      return ok(
        res,
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          code: r.code,
          categoryId: r.category_id,
          categoryName: r.category_name,
          openToAllCategories: r.open_to_all_categories,
          type: r.type,
          genderRestriction: r.gender_restriction,
          maxMark: r.max_mark === null ? null : Number(r.max_mark),
          stage: r.stage,
          scheduledAt: r.scheduled_at,
          maxPerChurch: r.max_per_church,
          minTeamSize: r.min_team_size,
          maxTeamSize: r.max_team_size,
          weightMultiplier: Number(r.weight_multiplier),
          displayOrder: r.display_order,
          status: r.status,
          cancelledReason: r.cancelled_reason,
          isActive: r.is_active,
          registrationCount: Number(r.registration_count ?? 0),
          criteriaCount: Number(r.criteria_count ?? 0),
          publicationState: r.publication_state ?? 'IN_PROGRESS',
          hasUnresolvedTie: r.has_unresolved_tie ?? false,
          performanceCount: Number(r.performance_count ?? 0),
          completeCount: Number(r.complete_count ?? 0),
          pendingCount: Number(r.pending_count ?? 0),
          isReady: r.is_ready ?? false,
        })),
      );
    }),
  );

  router.use('/import', itemImportRoutes());

  router.get(
    '/:id',
    requireCapability(Capability.MANAGE_ITEMS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      const item = await db
        .selectFrom('items')
        .selectAll()
        .where('id', '=', id)
        .where('event_id', '=', req.eventId!)
        .executeTakeFirst();
      if (!item) throw errors.notFound('Item', id);

      const criteria = await db
        .selectFrom('item_criteria')
        .select(['id', 'name', 'max_mark', 'display_order'])
        .where('item_id', '=', id)
        .orderBy('display_order')
        .execute();

      return ok(res, {
        ...item,
        max_mark: item.max_mark === null ? null : Number(item.max_mark),
        weight_multiplier: Number(item.weight_multiplier),
        criteria: criteria.map((c) => ({
          id: c.id,
          name: c.name,
          maxMark: Number(c.max_mark),
          displayOrder: c.display_order,
        })),
      });
    }),
  );

  router.post(
    '/',
    requireCapability(Capability.MANAGE_ITEMS),
    validate({ body: itemSchema }),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof itemSchema>;
      assertTeamSizeCoherent(input);

      const row = await auditedInsert(
        'items',
        {
          event_id: req.eventId!,
          name: input.name.trim(),
          code: input.code.trim().toUpperCase(),
          category_id: input.categoryId ?? null,
          open_to_all_categories: input.openToAllCategories ?? false,
          type: input.type,
          gender_restriction: input.genderRestriction,
          max_mark: input.maxMark ?? null,
          stage: input.stage ?? null,
          scheduled_at: input.scheduledAt ?? null,
          max_per_church: input.maxPerChurch ?? null,
          min_team_size: input.type === 'GROUP' ? (input.minTeamSize ?? null) : null,
          max_team_size: input.type === 'GROUP' ? (input.maxTeamSize ?? null) : null,
          // Q9: group items default to a 2.0 multiplier.
          weight_multiplier: input.weightMultiplier ?? (input.type === 'GROUP' ? 2.0 : 1.0),
          display_order: input.displayOrder ?? 0,
          created_by: req.auth!.userId,
          updated_by: req.auth!.userId,
        },
        crudContext(req, 'item', actorFromRequest(req)),
      );

      return created(res, row);
    }),
  );

  /**
   * ADM-04-04: "An item with registrations cannot have its category changed
   * without an explicit confirmation that lists every registration that would
   * become ineligible."
   *
   * The first request returns 409 with the affected list; the client shows it and
   * resends with confirmCategoryChange, which is the "explicit confirmation".
   */
  router.patch(
    '/:id',
    requireCapability(Capability.MANAGE_ITEMS),
    validate({ params: z.object({ id: z.string().uuid() }), body: updateItemSchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const input = req.body as z.infer<typeof updateItemSchema>;

      const existing = await db
        .selectFrom('items')
        .selectAll()
        .where('id', '=', id)
        .where('event_id', '=', req.eventId!)
        .executeTakeFirst();
      if (!existing) throw errors.notFound('Item', id);

      if (input.categoryId !== undefined && input.categoryId !== existing.category_id) {
        // Hoisted so the narrowing survives into the query-builder closure.
        const nextCategoryId: string | null = input.categoryId;

        const affected = await db
          .selectFrom('registrations as r')
          .innerJoin('members as m', 'm.id', 'r.member_id')
          .leftJoin('categories as c', 'c.id', 'm.category_id')
          .select(['r.id', 'm.chest_number', 'm.full_name', 'c.name as category_name'])
          .where('r.item_id', '=', id)
          .where('r.status', '=', 'REGISTERED')
          .where((eb) =>
            nextCategoryId === null
              ? eb.val(false)
              : eb.or([eb('m.category_id', 'is', null), eb('m.category_id', '!=', nextCategoryId)]),
          )
          .execute();

        if (affected.length > 0 && !input.confirmCategoryChange) {
          throw errors.conflict(
            `Changing the category of "${existing.name}" would make ${affected.length} existing registration(s) ineligible. Confirm to proceed (FSD ADM-04-04).`,
            {
              requiresConfirmation: 'confirmCategoryChange',
              affected: affected.map((a) => ({
                registrationId: a.id,
                chestNumber: a.chest_number,
                memberName: a.full_name,
                currentCategory: a.category_name,
              })),
            },
          );
        }
      }

      assertTeamSizeCoherent({ ...existing, ...input } as never);

      const row = await auditedUpdate(
        'items',
        id,
        {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.code !== undefined ? { code: input.code.trim().toUpperCase() } : {}),
          ...(input.categoryId !== undefined ? { category_id: input.categoryId } : {}),
          ...(input.openToAllCategories !== undefined
            ? { open_to_all_categories: input.openToAllCategories }
            : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.genderRestriction !== undefined
            ? { gender_restriction: input.genderRestriction }
            : {}),
          ...(input.maxMark !== undefined ? { max_mark: input.maxMark } : {}),
          ...(input.stage !== undefined ? { stage: input.stage } : {}),
          ...(input.scheduledAt !== undefined ? { scheduled_at: input.scheduledAt } : {}),
          ...(input.maxPerChurch !== undefined ? { max_per_church: input.maxPerChurch } : {}),
          ...(input.minTeamSize !== undefined ? { min_team_size: input.minTeamSize } : {}),
          ...(input.maxTeamSize !== undefined ? { max_team_size: input.maxTeamSize } : {}),
          ...(input.weightMultiplier !== undefined
            ? { weight_multiplier: input.weightMultiplier }
            : {}),
          ...(input.displayOrder !== undefined ? { display_order: input.displayOrder } : {}),
          ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
          updated_by: req.auth!.userId,
        },
        crudContext(req, 'item', actorFromRequest(req)),
        input.confirmCategoryChange
          ? { reason: 'Category changed with explicit confirmation of affected registrations (FSD ADM-04-04).' }
          : {},
      );

      return ok(res, row);
    }),
  );

  /**
   * ADM-04-05: "An item cannot be deleted once any performance exists against
   * it; it may only be cancelled, which excludes it from results with a recorded
   * reason."
   */
  router.post(
    '/:id/cancel',
    requireCapability(Capability.MANAGE_ITEMS),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().min(10).max(500) }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };

      const row = await auditedUpdate(
        'items',
        id,
        { status: 'CANCELLED', cancelled_reason: reason, updated_by: req.auth!.userId },
        crudContext(req, 'item', actorFromRequest(req)),
        { reason },
      );

      return ok(res, row);
    }),
  );

  router.delete(
    '/:id',
    requireCapability(Capability.MANAGE_ITEMS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      const item = await db
        .selectFrom('items')
        .select(['id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!item) throw errors.notFound('Item', id);

      const { count } = await db
        .selectFrom('performances')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('item_id', '=', id)
        .executeTakeFirstOrThrow();

      if (Number(count) > 0) {
        throw errors.inUse(
          `"${item.name}" has ${count} performance(s) and cannot be deleted (FSD ADM-04-05). Cancel it with a reason instead.`,
          { performanceCount: Number(count) },
        );
      }

      await auditedDelete('items', id, crudContext(req, 'item', actorFromRequest(req)));
      return ok(res, { deleted: true });
    }),
  );

  /**
   * ADM-04-06: define the item's scoring criteria.
   *
   * "for each item the administrator may define named criteria with individual
   * maximum marks that sum to the item maximum. When defined, judges score each
   * criterion rather than entering a single figure."
   *
   * The set is replaced wholesale inside one transaction; the deferred
   * constraint trigger from migration 0009 validates the total at commit, so a
   * criteria set can be rewritten row by row without tripping mid-edit.
   */
  router.put(
    '/:id/criteria',
    requireCapability(Capability.MANAGE_ITEMS),
    validate({ params: z.object({ id: z.string().uuid() }), body: criteriaSchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const { criteria } = req.body as z.infer<typeof criteriaSchema>;

      const item = await db
        .selectFrom('items as i')
        .leftJoin('scoring_config as sc', 'sc.event_id', 'i.event_id')
        .select(['i.id', 'i.name', 'i.max_mark', 'sc.max_mark as config_max_mark'])
        .where('i.id', '=', id)
        .where('i.event_id', '=', req.eventId!)
        .executeTakeFirst();
      if (!item) throw errors.notFound('Item', id);

      // Scoring against criteria is only meaningful once a mark already exists
      // against them, so a set defined after judging has begun would silently
      // change what every prior mark meant.
      const { count: scored } = await db
        .selectFrom('scores as s')
        .innerJoin('performances as p', 'p.id', 's.performance_id')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('p.item_id', '=', id)
        .executeTakeFirstOrThrow();

      if (Number(scored) > 0) {
        throw errors.conflict(
          `"${item.name}" already has ${scored} submitted mark(s). Its scoring criteria can no longer be changed, because existing marks were awarded against the current definition.`,
        );
      }

      const itemMax = Number(item.max_mark ?? item.config_max_mark ?? 10);
      const total = criteria.reduce((sum, c) => sum + c.maxMark, 0);

      if (criteria.length > 0 && Math.abs(total - itemMax) > 1e-9) {
        throw errors.validation(
          `The criteria total ${total} but the item maximum is ${itemMax}. They must be equal (FSD ADM-04-06).`,
          { criteriaTotal: total, itemMaximum: itemMax },
        );
      }

      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('item_criteria').where('item_id', '=', id).execute();

        if (criteria.length > 0) {
          await trx
            .insertInto('item_criteria')
            .values(
              criteria.map((c, index) => ({
                item_id: id,
                name: c.name.trim(),
                max_mark: c.maxMark,
                display_order: c.displayOrder ?? index,
                created_by: req.auth!.userId,
                updated_by: req.auth!.userId,
              })),
            )
            .execute();
        }

        await writeAudit(
          {
            eventId: req.eventId,
            actor: actorFromRequest(req),
            action: AuditAction.UPDATED,
            entityType: 'item_criteria',
            entityId: id,
            newValue: { criteria },
          },
          trx,
        );
      });

      return ok(res, { itemId: id, criteria, total });
    }),
  );

  return router;
}

/** ADM-04-02: a group item's team size range must be coherent. */
function assertTeamSizeCoherent(input: {
  type?: string;
  minTeamSize?: number | null;
  maxTeamSize?: number | null;
  min_team_size?: number | null;
  max_team_size?: number | null;
}): void {
  const min = input.minTeamSize ?? input.min_team_size ?? null;
  const max = input.maxTeamSize ?? input.max_team_size ?? null;

  if (min !== null && max !== null && max < min) {
    throw errors.validation(
      `The maximum team size (${max}) cannot be smaller than the minimum (${min}).`,
    );
  }
}
