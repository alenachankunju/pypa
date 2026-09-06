/**
 * Results and publication routes (FSD 5.12, 9.2).
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { requireLiveSession } from '../../middleware/authenticate.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { actorFromRequest } from '../../services/audit.js';
import { computeItemResult, getItemResult } from '../../services/results/itemResults.js';
import {
  markProvisional,
  publicationSummary,
  publishAllReady,
  publishItem,
  resolveTie,
  unpublishItem,
  withholdItem,
} from '../../services/results/publication.js';
import {
  recentRecomputeRuns,
  recomputeEvent,
  recomputeItem,
} from '../../services/results/recompute.js';
import {
  categoryChampions,
  churchLeaderboard,
  individualStandings,
  provisionalChurchLeaderboard,
} from '../../services/results/standings.js';
import { asyncHandler, ok } from '../../utils/http.js';

export function resultRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());

  /**
   * ADM-12-09: "Every result screen shows the count of items still unpublished,
   * so nobody announces a champion while items remain outstanding."
   */
  router.get(
    '/summary',
    requireCapability(Capability.VIEW_PROVISIONAL_RESULTS),
    asyncHandler(async (req, res) => ok(res, await publicationSummary(req.eventId!))),
  );

  /** Item readiness overview, for the results index screen (A14). */
  router.get(
    '/items',
    requireCapability(Capability.VIEW_PROVISIONAL_RESULTS),
    asyncHandler(async (req, res) => {
      const rows = await db
        .selectFrom('v_item_readiness as r')
        .leftJoin('categories as c', 'c.id', 'r.category_id')
        .select([
          'r.item_id',
          'r.item_name',
          'r.item_code',
          'r.item_status',
          'r.publication_state',
          'r.has_unresolved_tie',
          'r.published_at',
          'r.performance_count',
          'r.complete_count',
          'r.absent_count',
          'r.void_count',
          'r.pending_count',
          'r.is_ready',
          'c.name as category_name',
        ])
        .where('r.event_id', '=', req.eventId!)
        .orderBy('c.name')
        .orderBy('r.item_name')
        .execute();

      // ADM-12-09: every result screen shows the count of items still unpublished.
      const summary = await publicationSummary(req.eventId!);

      return ok(
        res,
        rows.map((r) => ({
          itemId: r.item_id,
          itemName: r.item_name,
          itemCode: r.item_code,
          categoryName: r.category_name,
          itemStatus: r.item_status,
          publicationState: r.publication_state,
          hasUnresolvedTie: r.has_unresolved_tie ?? false,
          publishedAt: r.published_at,
          performanceCount: Number(r.performance_count),
          completeCount: Number(r.complete_count),
          absentCount: Number(r.absent_count),
          voidCount: Number(r.void_count),
          pendingCount: Number(r.pending_count),
          isReady: r.is_ready,
        })),
        { unpublishedItemCount: summary.unpublished },
      );
    }),
  );

  /**
   * FSD 9.2: GET /api/results/items/{id} — item result with judge breakdown.
   * ADM-12-01, ADM-12-02.
   */
  router.get(
    '/items/:id',
    requireCapability(Capability.VIEW_PROVISIONAL_RESULTS),
    validate({
      params: z.object({ id: z.string().uuid() }),
      query: z.object({ recompute: z.enum(['true', 'false']).optional() }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      if ((req.query as { recompute?: string }).recompute === 'true') {
        await computeItemResult(id, req.eventId!, { actorId: req.auth!.userId });
      }

      const result = await getItemResult(id);

      // ADM-12-02: an unresolved tie is "clearly flagged" and blocks progress.
      // The tied groups are returned so the console can present the judges' marks
      // side by side for the administrator's decision (FSD 4.5).
      const tiedGroups = result.publication.hasUnresolvedTie
        ? groupUnresolvedTies(result.rows)
        : [];

      // ADM-12-09: every result screen shows the count of items still unpublished.
      const summary = await publicationSummary(req.eventId!);

      return ok(res, { ...result, tiedGroups }, { unpublishedItemCount: summary.unpublished });
    }),
  );

  /** Move an item to PROVISIONAL after review (FSD 4.8). */
  router.post(
    '/items/:id/provisional',
    requireCapability(Capability.VIEW_PROVISIONAL_RESULTS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      return ok(res, await markProvisional(id, req.eventId!, actorFromRequest(req)));
    }),
  );

  /**
   * FSD 9.2: POST /api/results/items/{id}/publish.
   * ADM-12-03: Super Admin only. Publication timestamps the result and locks it.
   */
  router.post(
    '/items/:id/publish',
    requireLiveSession(),
    requireCapability(Capability.PUBLISH_RESULTS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const change = await publishItem(id, req.eventId!, actorFromRequest(req));
      return ok(res, { ...change, summary: await publicationSummary(req.eventId!) });
    }),
  );

  /**
   * ADM-12-04: "Bulk publish all Ready items, with a summary confirmation listing
   * what will be published."
   *
   * Call with dryRun=true first to render the confirmation, then again to commit.
   */
  router.post(
    '/publish-all',
    requireLiveSession(),
    requireCapability(Capability.PUBLISH_RESULTS),
    validate({ body: z.object({ dryRun: z.boolean().optional() }).optional() }),
    asyncHandler(async (req, res) => {
      const dryRun = (req.body as { dryRun?: boolean } | undefined)?.dryRun ?? false;
      const result = await publishAllReady(req.eventId!, actorFromRequest(req), { dryRun });

      return ok(res, {
        ...result,
        dryRun,
        summary: await publicationSummary(req.eventId!),
      });
    }),
  );

  /**
   * FSD 9.2: POST /api/results/items/{id}/unpublish — with a mandatory reason.
   * ADM-12-05, FSD 4.8 "unpublish and correct".
   */
  router.post(
    '/items/:id/unpublish',
    requireLiveSession(),
    requireCapability(Capability.PUBLISH_RESULTS),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().min(15).max(1000) }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };

      const change = await unpublishItem(id, req.eventId!, reason, actorFromRequest(req));

      // FSD 7.7: unpublishing "forces recomputation of all downstream totals",
      // and the change report lists every position that moved.
      const recompute = await recomputeItem(
        id,
        req.eventId!,
        'RESULT_UNPUBLISHED',
        actorFromRequest(req),
        reason,
      );

      return ok(res, {
        ...change,
        positionChanges: recompute.changes,
        warning:
          'Church totals and the championship have been recalculated. This item no longer contributes points until it is republished.',
        summary: await publicationSummary(req.eventId!),
      });
    }),
  );

  /** FSD 4.8 WITHHELD — freeze a result pending a dispute. */
  router.post(
    '/items/:id/withhold',
    requireCapability(Capability.PUBLISH_RESULTS),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().min(15).max(1000) }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };
      return ok(res, await withholdItem(id, req.eventId!, reason, actorFromRequest(req)));
    }),
  );

  /**
   * FSD 9.2: POST /api/results/items/{id}/resolve-tie — record a manual decision.
   * FSD 4.5.5: "the system does not guess ... requires the administrator to
   * either declare a shared position or break the tie manually with a recorded
   * justification."
   */
  router.post(
    '/items/:id/resolve-tie',
    requireCapability(Capability.VIEW_PROVISIONAL_RESULTS),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({
        reason: z.string().min(15).max(1000),
        decisions: z
          .array(
            z.object({
              performanceId: z.string().uuid(),
              assignedPosition: z.coerce.number().int().positive(),
              declaredShared: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(50),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const body = req.body as {
        reason: string;
        decisions: { performanceId: string; assignedPosition: number; declaredShared?: boolean }[];
      };

      const result = await resolveTie(
        id,
        req.eventId!,
        body.decisions.map((d) => ({
          performanceId: d.performanceId,
          assignedPosition: d.assignedPosition,
          declaredShared: d.declaredShared ?? false,
        })),
        body.reason,
        actorFromRequest(req),
      );

      return ok(res, { ...result, result: await getItemResult(id) });
    }),
  );

  /**
   * FSD 9.2: GET /api/results/churches — the church leaderboard (ADM-12-06).
   *
   * ADM-12-08 "what-if" preview: pass provisional=true to include unpublished
   * READY items. The response meta carries provisional:true so the interface can
   * watermark it, as the FSD requires ("clearly watermarked as provisional").
   */
  router.get(
    '/churches',
    requireCapability(Capability.VIEW_PROVISIONAL_RESULTS),
    validate({ query: z.object({ provisional: z.enum(['true', 'false']).optional() }) }),
    asyncHandler(async (req, res) => {
      const provisional = (req.query as { provisional?: string }).provisional === 'true';

      const standings = provisional
        ? await provisionalChurchLeaderboard(req.eventId!)
        : await churchLeaderboard(req.eventId!);

      const summary = await publicationSummary(req.eventId!);

      return ok(res, standings, {
        provisional,
        // ADM-12-09
        unpublishedItemCount: summary.unpublished,
        ...(provisional
          ? {
              watermark:
                'PROVISIONAL — includes items that have not been published. Not for announcement.',
            }
          : {}),
      });
    }),
  );

  /**
   * FSD 9.2: GET /api/results/champions — individual and category champions.
   * ADM-12-07, FSD 4.7.6, 4.7.7.
   */
  router.get(
    '/champions',
    requireCapability(Capability.VIEW_PROVISIONAL_RESULTS),
    validate({ query: z.object({ limit: z.coerce.number().int().positive().max(200).optional() }) }),
    asyncHandler(async (req, res) => {
      const limit = (req.query as { limit?: number }).limit ?? 50;

      const [individual, categories, summary] = await Promise.all([
        individualStandings(req.eventId!, { limit }),
        categoryChampions(req.eventId!),
        publicationSummary(req.eventId!),
      ]);

      return ok(
        res,
        {
          individual: {
            champion: individual.find((m) => m.isChampion) ?? null,
            standings: individual,
          },
          categories,
        },
        { unpublishedItemCount: summary.unpublished },
      );
    }),
  );

  /**
   * FSD 7.7: "A manual 'recalculate everything' action is available to Super
   * Admin and is logged." The response is the change report.
   */
  router.post(
    '/recompute',
    requireLiveSession(),
    requireCapability(Capability.CONFIGURE_SCORING),
    validate({
      body: z
        .object({ itemId: z.string().uuid().optional(), reason: z.string().max(500).optional() })
        .optional(),
    }),
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { itemId?: string; reason?: string };

      const result = body.itemId
        ? await recomputeItem(body.itemId, req.eventId!, 'MANUAL', actorFromRequest(req), body.reason)
        : await recomputeEvent(req.eventId!, 'MANUAL', actorFromRequest(req), body.reason);

      return ok(res, result);
    }),
  );

  /** Recomputation history and its change reports (FSD 7.7). */
  router.get(
    '/recompute-runs',
    requireCapability(Capability.VIEW_PROVISIONAL_RESULTS),
    asyncHandler(async (req, res) => ok(res, await recentRecomputeRuns(req.eventId!))),
  );

  return router;
}

/**
 * Group the rows of an item that share a position with an unresolved tie, so the
 * console can present "all judge marks side by side" as FSD 4.5 requires.
 */
function groupUnresolvedTies(
  rows: Awaited<ReturnType<typeof getItemResult>>['rows'],
): { position: number; aggregate: number | null; rows: typeof rows }[] {
  const byPosition = new Map<number, typeof rows>();

  for (const row of rows) {
    if (row.position === null || row.manuallyResolved) continue;
    const list = byPosition.get(row.position) ?? [];
    list.push(row);
    byPosition.set(row.position, list);
  }

  return [...byPosition.entries()]
    .filter(([, group]) => group.length > 1 && !group[0]!.isSharedPosition)
    .map(([position, group]) => ({
      position,
      aggregate: group[0]!.aggregate,
      rows: group,
    }))
    .sort((a, b) => a.position - b.position);
}
