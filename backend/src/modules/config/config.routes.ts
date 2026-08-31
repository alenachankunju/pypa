/**
 * Scoring configuration (FSD 5.11).
 *
 * ADM-11-09 is the rule that shapes this module: "Scoring configuration is locked
 * once the first result is published. Changing it afterwards requires a Super
 * Admin action that unpublishes every result and forces full recomputation, with
 * a confirmation dialog that states exactly this."
 */
import { Router } from 'express';
import { z } from 'zod';
import { db, parsePgTextArray } from '../../db/pool.js';
import { requireLiveSession } from '../../middleware/authenticate.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { AuditAction, actorFromRequest, writeAudit } from '../../services/audit.js';
import { validateGradeBands } from '../../services/scoring/grades.js';
import { recomputeEvent } from '../../services/results/recompute.js';
import { errors } from '../../utils/errors.js';
import { asyncHandler, ok } from '../../utils/http.js';

const TIEBREAK = ['JUDGE_TOP_MARK_COUNT', 'HIGHEST_SINGLE_MARK', 'LOWEST_SPREAD', 'CHIEF_JUDGE_MARK'] as const;

const configSchema = z.object({
  // ADM-11-01
  maxMark: z.coerce.number().positive().max(1000).optional(),
  decimalPlaces: z.coerce.number().int().min(0).max(3).optional(),
  // ADM-11-02
  aggregationMethod: z.enum(['AVERAGE', 'SUM', 'TRIMMED_MEAN', 'WEIGHTED_AVERAGE']).optional(),
  // ADM-11-05
  allowSharedPositions: z.boolean().optional(),
  // ADM-11-06 — order is significant.
  tiebreakOrder: z.array(z.enum(TIEBREAK)).min(1).max(4).optional(),
  // ADM-11-07
  gradePointsEnabled: z.boolean().optional(),
  gradeBands: z
    .array(
      z.object({
        grade: z.string().min(1).max(10),
        minPercentage: z.coerce.number().min(0).max(100),
        points: z.coerce.number().min(0).optional(),
      }),
    )
    .max(10)
    .optional(),
  // ADM-11-03 — any number of positions.
  positionPoints: z
    .array(z.object({ position: z.coerce.number().int().positive(), points: z.coerce.number().min(0) }))
    .max(50)
    .optional(),
  // ADM-11-08
  minItemsForChampion: z.coerce.number().int().min(0).max(50).optional(),
  computeCategoryChampions: z.boolean().optional(),
  maxItemsPerMember: z.coerce.number().int().positive().max(100).nullable().optional(),
  walkoverMinAggregate: z.coerce.number().min(0).nullable().optional(),
  showOutOfSessionItems: z.boolean().optional(),
});

export function configRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());

  /**
   * FSD 9.2: GET /api/config/scoring.
   *
   * Readable by anyone who can see results: the tie-break policy is printed on
   * every result sheet (FSD 14.3 risk mitigation), so the console needs it.
   */
  router.get(
    '/scoring',
    requireCapability(Capability.VIEW_PROVISIONAL_RESULTS),
    asyncHandler(async (req, res) => {
      const eventId = req.eventId!;

      const [config, positionPoints, gradeBands, publishedCount] = await Promise.all([
        db.selectFrom('scoring_config').selectAll().where('event_id', '=', eventId).executeTakeFirst(),
        db
          .selectFrom('position_points')
          .select(['position', 'points', 'item_id'])
          .where('event_id', '=', eventId)
          .where('item_id', 'is', null)
          .orderBy('position')
          .execute(),
        db
          .selectFrom('grade_bands')
          .select(['grade', 'min_percentage', 'points', 'display_order'])
          .where('event_id', '=', eventId)
          .orderBy('min_percentage', 'desc')
          .execute(),
        db
          .selectFrom('item_publications')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('event_id', '=', eventId)
          .where('state', '=', 'PUBLISHED')
          .executeTakeFirstOrThrow(),
      ]);

      return ok(res, {
        maxMark: Number(config?.max_mark ?? 10),
        decimalPlaces: config?.decimal_places ?? 1,
        aggregationMethod: config?.aggregation_method ?? 'AVERAGE',
        allowSharedPositions: config?.allow_shared_positions ?? false,
        tiebreakOrder: config?.tiebreak_order ? parsePgTextArray(config.tiebreak_order) : TIEBREAK,
        gradePointsEnabled: config?.grade_points_enabled ?? false,
        minItemsForChampion: config?.min_items_for_champion ?? 2,
        computeCategoryChampions: config?.compute_category_champions ?? true,
        maxItemsPerMember: config?.max_items_per_member ?? null,
        walkoverMinAggregate:
          config?.walkover_min_aggregate === null || config?.walkover_min_aggregate === undefined
            ? null
            : Number(config.walkover_min_aggregate),
        showOutOfSessionItems: config?.show_out_of_session_items ?? true,
        positionPoints: positionPoints.map((p) => ({
          position: p.position,
          points: Number(p.points),
        })),
        gradeBands: gradeBands.map((g) => ({
          grade: g.grade,
          minPercentage: Number(g.min_percentage),
          points: Number(g.points),
        })),
        // ADM-11-09
        locked: config?.locked ?? false,
        lockedAt: config?.locked_at ?? null,
        publishedItemCount: Number(publishedCount.count),
      });
    }),
  );

  /**
   * FSD 9.2: PUT /api/config/scoring. ADM-11-01 to ADM-11-08.
   *
   * Refused with CONFIG_LOCKED once anything is published (ADM-11-09, FSD 9.4,
   * FSD 12.3), unless the caller has first unpublished everything via
   * POST /unlock below.
   */
  router.put(
    '/scoring',
    requireLiveSession(),
    requireCapability(Capability.CONFIGURE_SCORING),
    validate({ body: configSchema }),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof configSchema>;
      const eventId = req.eventId!;

      const existing = await db
        .selectFrom('scoring_config')
        .selectAll()
        .where('event_id', '=', eventId)
        .executeTakeFirst();

      if (existing?.locked) throw errors.configLocked();

      if (input.gradeBands) {
        const problems = validateGradeBands(
          input.gradeBands.map((b) => ({
            grade: b.grade,
            minPercentage: b.minPercentage,
            points: b.points ?? 0,
          })),
        );
        if (problems.length > 0) {
          throw errors.validation(`The grade bands are not valid. ${problems.join(' ')}`, { problems });
        }
      }

      // FSD 4.4: trimmed mean "Requires at least four judges". Refusing the
      // combination up front is better than falling back silently at scoring
      // time, which is what the aggregation module would otherwise have to do.
      if (input.aggregationMethod === 'TRIMMED_MEAN') {
        const smallest = await db
          .selectFrom('panels as p')
          .select((eb) => [
            'p.name',
            eb
              .selectFrom('panel_judges as pj')
              .select((i) => i.fn.countAll<number>().as('n'))
              .whereRef('pj.panel_id', '=', 'p.id')
              .where('pj.removed_at', 'is', null)
              .as('judge_count'),
          ])
          .where('p.event_id', '=', eventId)
          .where('p.is_active', '=', true)
          .execute();

        const tooSmall = smallest.filter((p) => Number(p.judge_count ?? 0) < 4);
        if (tooSmall.length > 0) {
          throw errors.validation(
            `Trimmed mean requires at least 4 judges per panel (FSD 4.4). These panels have fewer: ${tooSmall
              .map((p) => `${p.name} (${p.judge_count})`)
              .join(', ')}.`,
            { panels: tooSmall.map((p) => ({ name: p.name, judgeCount: Number(p.judge_count ?? 0) })) },
          );
        }
      }

      const updated = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('scoring_config')
          .values({
            event_id: eventId,
            ...(input.maxMark !== undefined ? { max_mark: input.maxMark } : {}),
            ...(input.decimalPlaces !== undefined ? { decimal_places: input.decimalPlaces } : {}),
            ...(input.aggregationMethod !== undefined
              ? { aggregation_method: input.aggregationMethod }
              : {}),
            ...(input.allowSharedPositions !== undefined
              ? { allow_shared_positions: input.allowSharedPositions }
              : {}),
            ...(input.tiebreakOrder !== undefined ? { tiebreak_order: input.tiebreakOrder } : {}),
            ...(input.gradePointsEnabled !== undefined
              ? { grade_points_enabled: input.gradePointsEnabled }
              : {}),
            ...(input.minItemsForChampion !== undefined
              ? { min_items_for_champion: input.minItemsForChampion }
              : {}),
            ...(input.computeCategoryChampions !== undefined
              ? { compute_category_champions: input.computeCategoryChampions }
              : {}),
            ...(input.maxItemsPerMember !== undefined
              ? { max_items_per_member: input.maxItemsPerMember }
              : {}),
            ...(input.walkoverMinAggregate !== undefined
              ? { walkover_min_aggregate: input.walkoverMinAggregate }
              : {}),
            ...(input.showOutOfSessionItems !== undefined
              ? { show_out_of_session_items: input.showOutOfSessionItems }
              : {}),
            created_by: req.auth!.userId,
            updated_by: req.auth!.userId,
          })
          .onConflict((oc) =>
            oc.column('event_id').doUpdateSet({
              ...(input.maxMark !== undefined ? { max_mark: input.maxMark } : {}),
              ...(input.decimalPlaces !== undefined ? { decimal_places: input.decimalPlaces } : {}),
              ...(input.aggregationMethod !== undefined
                ? { aggregation_method: input.aggregationMethod }
                : {}),
              ...(input.allowSharedPositions !== undefined
                ? { allow_shared_positions: input.allowSharedPositions }
                : {}),
              ...(input.tiebreakOrder !== undefined ? { tiebreak_order: input.tiebreakOrder } : {}),
              ...(input.gradePointsEnabled !== undefined
                ? { grade_points_enabled: input.gradePointsEnabled }
                : {}),
              ...(input.minItemsForChampion !== undefined
                ? { min_items_for_champion: input.minItemsForChampion }
                : {}),
              ...(input.computeCategoryChampions !== undefined
                ? { compute_category_champions: input.computeCategoryChampions }
                : {}),
              ...(input.maxItemsPerMember !== undefined
                ? { max_items_per_member: input.maxItemsPerMember }
                : {}),
              ...(input.walkoverMinAggregate !== undefined
                ? { walkover_min_aggregate: input.walkoverMinAggregate }
                : {}),
              ...(input.showOutOfSessionItems !== undefined
                ? { show_out_of_session_items: input.showOutOfSessionItems }
                : {}),
              updated_by: req.auth!.userId,
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();

        // ADM-11-03: position points are replaced wholesale, so removing the
        // third place is expressed by simply omitting it.
        if (input.positionPoints) {
          await trx
            .deleteFrom('position_points')
            .where('event_id', '=', eventId)
            .where('item_id', 'is', null)
            .execute();

          if (input.positionPoints.length > 0) {
            await trx
              .insertInto('position_points')
              .values(
                input.positionPoints.map((p) => ({
                  event_id: eventId,
                  item_id: null,
                  position: p.position,
                  points: p.points,
                  created_by: req.auth!.userId,
                  updated_by: req.auth!.userId,
                })),
              )
              .execute();
          }
        }

        if (input.gradeBands) {
          await trx.deleteFrom('grade_bands').where('event_id', '=', eventId).execute();

          if (input.gradeBands.length > 0) {
            await trx
              .insertInto('grade_bands')
              .values(
                input.gradeBands.map((b, index) => ({
                  event_id: eventId,
                  grade: b.grade.toUpperCase(),
                  min_percentage: b.minPercentage,
                  points: b.points ?? 0,
                  display_order: index,
                  created_by: req.auth!.userId,
                  updated_by: req.auth!.userId,
                })),
              )
              .execute();
          }
        }

        await writeAudit(
          {
            eventId,
            actor: actorFromRequest(req),
            action: AuditAction.CONFIG_UPDATED,
            entityType: 'scoring_config',
            entityId: row.id,
            newValue: input,
          },
          trx,
        );

        return row;
      });

      // FSD 7.7: a configuration change is a named trigger for recomputation.
      const recompute = await recomputeEvent(
        eventId,
        'CONFIG_CHANGED',
        actorFromRequest(req),
        'Scoring configuration changed.',
      );

      return ok(res, {
        config: updated,
        positionChanges: recompute.changes,
        recomputedItems: recompute.itemsProcessed,
      });
    }),
  );

  /**
   * ADM-11-09 unlock: unpublish EVERY result so the configuration can change.
   *
   * "Changing it afterwards requires a Super Admin action that unpublishes every
   * result and forces full recomputation, with a confirmation dialog that states
   * exactly this."
   *
   * The dryRun response is that confirmation: it names every item that will be
   * unpublished, so the dialog can state exactly what is about to happen rather
   * than paraphrasing it.
   */
  router.post(
    '/scoring/unlock',
    requireLiveSession(),
    requireCapability(Capability.CONFIGURE_SCORING, Capability.PUBLISH_RESULTS),
    validate({
      body: z.object({
        reason: z.string().min(15).max(1000),
        dryRun: z.boolean().optional(),
        confirmUnpublishAll: z.boolean().optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { reason, dryRun, confirmUnpublishAll } = req.body as {
        reason: string;
        dryRun?: boolean;
        confirmUnpublishAll?: boolean;
      };
      const eventId = req.eventId!;

      const published = await db
        .selectFrom('item_publications as ip')
        .innerJoin('items as i', 'i.id', 'ip.item_id')
        .select(['ip.item_id', 'i.name as item_name'])
        .where('ip.event_id', '=', eventId)
        .where('ip.state', '=', 'PUBLISHED')
        .orderBy('i.name')
        .execute();

      if (dryRun || !confirmUnpublishAll) {
        return ok(res, {
          dryRun: true,
          willUnpublish: published.map((p) => ({ itemId: p.item_id, itemName: p.item_name })),
          confirmationRequired: 'confirmUnpublishAll',
          warning:
            `Unlocking the scoring configuration will UNPUBLISH all ${published.length} published result(s) ` +
            'and recompute every item, church total and championship standing. ' +
            'Any result already announced will need to be republished and may change.',
        });
      }

      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('item_publications')
          .set({
            state: 'PROVISIONAL',
            unpublished_by: req.auth!.userId,
            unpublished_at: new Date(),
            unpublish_reason: reason,
            updated_by: req.auth!.userId,
          })
          .where('event_id', '=', eventId)
          .where('state', '=', 'PUBLISHED')
          .execute();

        await trx
          .updateTable('scoring_config')
          .set({ locked: false, locked_at: null, locked_by: null, updated_by: req.auth!.userId })
          .where('event_id', '=', eventId)
          .execute();

        await writeAudit(
          {
            eventId,
            actor: actorFromRequest(req),
            action: AuditAction.CONFIG_UNLOCKED,
            entityType: 'scoring_config',
            entityId: eventId,
            newValue: { unpublishedItems: published.length },
            reason,
          },
          trx,
        );
      });

      const recompute = await recomputeEvent(eventId, 'CONFIG_CHANGED', actorFromRequest(req), reason);

      return ok(res, {
        unlocked: true,
        unpublishedItems: published.length,
        positionChanges: recompute.changes,
      });
    }),
  );

  /** ADM-11-04: per-item point overrides and weight multipliers. */
  router.put(
    '/scoring/items/:itemId/points',
    requireCapability(Capability.CONFIGURE_SCORING),
    validate({
      params: z.object({ itemId: z.string().uuid() }),
      body: z.object({
        positionPoints: z
          .array(z.object({ position: z.coerce.number().int().positive(), points: z.coerce.number().min(0) }))
          .max(50),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { itemId } = req.params as { itemId: string };
      const { positionPoints } = req.body as {
        positionPoints: { position: number; points: number }[];
      };
      const eventId = req.eventId!;

      const config = await db
        .selectFrom('scoring_config')
        .select('locked')
        .where('event_id', '=', eventId)
        .executeTakeFirst();
      if (config?.locked) throw errors.configLocked();

      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('position_points').where('item_id', '=', itemId).execute();

        if (positionPoints.length > 0) {
          await trx
            .insertInto('position_points')
            .values(
              positionPoints.map((p) => ({
                event_id: eventId,
                item_id: itemId,
                position: p.position,
                points: p.points,
                created_by: req.auth!.userId,
                updated_by: req.auth!.userId,
              })),
            )
            .execute();
        }

        await writeAudit(
          {
            eventId,
            actor: actorFromRequest(req),
            action: AuditAction.CONFIG_UPDATED,
            entityType: 'position_points',
            entityId: itemId,
            newValue: { positionPoints },
            reason: 'Per-item position point override (FSD ADM-11-04).',
          },
          trx,
        );
      });

      return ok(res, { itemId, positionPoints });
    }),
  );

  return router;
}
