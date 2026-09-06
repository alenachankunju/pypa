/**
 * Session routes (FSD 5.8) and the live judging console (FSD 5.9).
 *
 * The live console is the administrator's event-day screen and "the operational
 * centre of the system. It answers one question continuously: is anything stuck?"
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { actorFromRequest } from '../../services/audit.js';
import { errors } from '../../utils/errors.js';
import { auditedDelete, auditedInsert, auditedUpdate, crudContext } from '../../utils/crud.js';
import { asyncHandler, created, ok } from '../../utils/http.js';
import {
  closeSession,
  findOverlappingAssignments,
  listIncompletePerformances,
  openSession,
  parseMissingJudges,
} from './sessions.service.js';

/** ADM-08-03 field set. */
const sessionSchema = z.object({
  name: z.string().min(1).max(200),
  stage: z.string().max(120).optional().nullable(),
  panelId: z.string().uuid(),
  scheduledStart: z.coerce.date().optional().nullable(),
  scheduledEnd: z.coerce.date().optional().nullable(),
  itemIds: z.array(z.string().uuid()).min(1).max(200),
});

export function sessionRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());

  router.get(
    '/',
    requireCapability(Capability.MANAGE_SESSIONS),
    validate({ query: z.object({ status: z.enum(['DRAFT', 'OPEN', 'CLOSED', 'FORCE_CLOSED']).optional() }) }),
    asyncHandler(async (req, res) => {
      const status = (req.query as { status?: string }).status;

      let query = db
        .selectFrom('sessions as s')
        .innerJoin('panels as p', 'p.id', 's.panel_id')
        .select((eb) => [
          's.id',
          's.name',
          's.stage',
          's.status',
          's.scheduled_start',
          's.scheduled_end',
          's.opened_at',
          's.closed_at',
          's.force_closed_reason',
          'p.id as panel_id',
          'p.name as panel_name',
          eb
            .selectFrom('panel_judges as pj')
            .select((i) => i.fn.countAll<number>().as('n'))
            .whereRef('pj.panel_id', '=', 'p.id')
            .where('pj.removed_at', 'is', null)
            .as('panel_size'),
          eb
            .selectFrom('session_items as si')
            .select((i) => i.fn.countAll<number>().as('n'))
            .whereRef('si.session_id', '=', 's.id')
            .as('item_count'),
          eb
            .selectFrom('performances as pf')
            .select((i) => i.fn.countAll<number>().as('n'))
            .whereRef('pf.session_id', '=', 's.id')
            .as('performance_count'),
          eb
            .selectFrom('performances as pf')
            .select((i) => i.fn.countAll<number>().as('n'))
            .whereRef('pf.session_id', '=', 's.id')
            .where('pf.status', '=', 'COMPLETE')
            .as('complete_count'),
        ])
        .where('s.event_id', '=', req.eventId!);

      if (status) query = query.where('s.status', '=', status as never);

      const rows = await query.orderBy('s.scheduled_start').orderBy('s.name').execute();

      return ok(
        res,
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          stage: r.stage,
          status: r.status,
          scheduledStart: r.scheduled_start,
          scheduledEnd: r.scheduled_end,
          openedAt: r.opened_at,
          closedAt: r.closed_at,
          forceClosedReason: r.force_closed_reason,
          panelId: r.panel_id,
          panelName: r.panel_name,
          panelSize: Number(r.panel_size ?? 0),
          itemCount: Number(r.item_count ?? 0),
          performanceCount: Number(r.performance_count ?? 0),
          completeCount: Number(r.complete_count ?? 0),
        })),
      );
    }),
  );

  router.post(
    '/',
    requireCapability(Capability.MANAGE_SESSIONS),
    validate({ body: sessionSchema }),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof sessionSchema>;

      if (input.scheduledStart && input.scheduledEnd && input.scheduledEnd < input.scheduledStart) {
        throw errors.validation('The end time must be after the start time.');
      }

      const session = await auditedInsert(
        'sessions',
        {
          event_id: req.eventId!,
          name: input.name.trim(),
          stage: input.stage ?? null,
          panel_id: input.panelId,
          scheduled_start: input.scheduledStart ?? null,
          scheduled_end: input.scheduledEnd ?? null,
          created_by: req.auth!.userId,
          updated_by: req.auth!.userId,
        },
        crudContext(req, 'session', actorFromRequest(req)),
      );

      await db
        .insertInto('session_items')
        .values(
          input.itemIds.map((itemId, index) => ({
            session_id: String(session.id),
            item_id: itemId,
            display_order: index,
            created_by: req.auth!.userId,
            updated_by: req.auth!.userId,
          })),
        )
        .execute();

      // ADM-08-07: a warning, not a refusal (FSD 12.3 supports parallel stages).
      const overlaps = await findOverlappingAssignments(String(session.id), req.eventId!);

      return created(res, session, {
        ...(overlaps.length > 0
          ? {
              overlapWarnings: overlaps.map(
                (o) =>
                  `${o.judgeName} is also on the panel for "${o.otherSessionName}", which overlaps this session in time (FSD ADM-08-07).`,
              ),
            }
          : {}),
      });
    }),
  );

  router.patch(
    '/:id',
    requireCapability(Capability.MANAGE_SESSIONS),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: sessionSchema.partial().omit({ itemIds: true }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const input = req.body as Partial<z.infer<typeof sessionSchema>>;

      const existing = await db
        .selectFrom('sessions')
        .select(['status', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!existing) throw errors.notFound('Session', id);

      if (existing.status === 'CLOSED' || existing.status === 'FORCE_CLOSED') {
        throw errors.conflict(`Session "${existing.name}" is closed and can no longer be edited.`);
      }

      const row = await auditedUpdate(
        'sessions',
        id,
        {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.stage !== undefined ? { stage: input.stage } : {}),
          ...(input.panelId !== undefined ? { panel_id: input.panelId } : {}),
          ...(input.scheduledStart !== undefined ? { scheduled_start: input.scheduledStart } : {}),
          ...(input.scheduledEnd !== undefined ? { scheduled_end: input.scheduledEnd } : {}),
          updated_by: req.auth!.userId,
        },
        crudContext(req, 'session', actorFromRequest(req)),
      );

      return ok(res, row);
    }),
  );

  /**
   * A session may only be deleted before it has ever been opened — once open,
   * it's part of the official event-day record even if force-closed with
   * nothing judged, and force-closure (not deletion) is the correction path for
   * that. performances.session_id is ON DELETE RESTRICT regardless, so a
   * session that somehow does have performances is refused by the database
   * either way; the opened_at check just gives the common case a clear message
   * before the query even runs.
   */
  router.delete(
    '/:id',
    requireCapability(Capability.MANAGE_SESSIONS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      const session = await db
        .selectFrom('sessions')
        .select(['id', 'name', 'opened_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!session) throw errors.notFound('Session', id);

      if (session.opened_at !== null) {
        throw errors.inUse(
          `"${session.name}" has been opened and is part of the event record. Close or force-close it instead of deleting.`,
        );
      }

      await auditedDelete('sessions', id, crudContext(req, 'session', actorFromRequest(req)));
      return ok(res, { deleted: true });
    }),
  );

  /** FSD 9.2: POST /api/sessions/{id}/open */
  router.post(
    '/:id/open',
    requireCapability(Capability.MANAGE_SESSIONS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      const result = await openSession(id, req.eventId!, actorFromRequest(req), req.auth!.userId);
      const overlaps = await findOverlappingAssignments(id, req.eventId!);

      return ok(res, result, {
        ...(overlaps.length > 0
          ? {
              overlapWarnings: overlaps.map(
                (o) => `${o.judgeName} is also assigned to the overlapping session "${o.otherSessionName}".`,
              ),
            }
          : {}),
      });
    }),
  );

  /** FSD 9.2: POST /api/sessions/{id}/close — validates completeness (ADM-08-05). */
  router.post(
    '/:id/close',
    requireCapability(Capability.MANAGE_SESSIONS),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z
        .object({ force: z.boolean().optional(), reason: z.string().max(500).optional() })
        .optional(),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { force?: boolean; reason?: string };

      const result = await closeSession(
        id,
        req.eventId!,
        { force: body.force, reason: body.reason },
        actorFromRequest(req),
        req.auth!.userId,
      );

      return ok(res, result);
    }),
  );

  /**
   * FSD 9.2: GET /api/sessions/{id}/progress — live scoring progress.
   *
   * This one response drives the whole live console (ADM-09-01 to ADM-09-09).
   *
   * ADM-09-03 governs what it may contain: "For the current performance, display
   * a live tile per judge showing Submitted or Waiting. MARKS THEMSELVES ARE
   * NEVER DISPLAYED HERE UNTIL THE PERFORMANCE IS COMPLETE, so that a coordinator
   * cannot relay one judge's mark to another." Individual marks are therefore
   * attached only to COMPLETE performances, and only for roles holding
   * VIEW_ALL_SCORES — a coordinator sees counts alone (FSD 3.2).
   */
  router.get(
    '/:id/progress',
    requireCapability(Capability.VIEW_SCORE_PROGRESS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const canSeeMarks = req.auth!.role === 'SUPER_ADMIN' || req.auth!.role === 'ADMIN';

      const session = await db
        .selectFrom('sessions as s')
        .innerJoin('panels as p', 'p.id', 's.panel_id')
        .select(['s.id', 's.name', 's.stage', 's.status', 'p.name as panel_name', 'p.id as panel_id'])
        .where('s.id', '=', id)
        .where('s.event_id', '=', req.eventId!)
        .executeTakeFirst();
      if (!session) throw errors.notFound('Session', id);

      const performances = await db
        .selectFrom('v_performance_progress as pp')
        .innerJoin('items as i', 'i.id', 'pp.item_id')
        .innerJoin('registrations as r', 'r.id', 'pp.registration_id')
        .innerJoin('churches as c', 'c.id', 'r.church_id')
        .leftJoin('members as m', 'm.id', 'r.member_id')
        .select([
          'pp.performance_id',
          'pp.item_id',
          'pp.status',
          'pp.panel_size',
          'pp.submitted_count',
          'pp.outstanding_count',
          'pp.missing_judges',
          'pp.submitted_judge_ids',
          'pp.is_current',
          'pp.call_order',
          'pp.attempt_no',
          'pp.aggregate_score',
          'i.name as item_name',
          'i.code as item_code',
          'm.chest_number',
          'm.full_name as member_name',
          'm.photo_path',
          'r.team_name',
          'c.name as church_name',
          'c.short_code as church_short_code',
        ])
        .where('pp.session_id', '=', id)
        .orderBy('i.name')
        .orderBy('pp.call_order')
        .execute();

      // ADM-09-04: "Once COMPLETE, the individual marks and the aggregate become
      // visible to the administrator." Fetched only for complete performances,
      // and only for roles permitted to see them.
      const completeIds = performances.filter((p) => p.status === 'COMPLETE').map((p) => p.performance_id);
      const marks =
        canSeeMarks && completeIds.length > 0
          ? await db
              .selectFrom('scores as s')
              .innerJoin('users as u', 'u.id', 's.judge_id')
              .select(['s.performance_id', 's.judge_id', 's.mark', 's.remarks', 'u.full_name as judge_name'])
              .where('s.performance_id', 'in', completeIds)
              .where('s.revoked', '=', false)
              .orderBy('u.full_name')
              .execute()
          : [];

      const marksByPerformance = new Map<string, typeof marks>();
      for (const m of marks) {
        const list = marksByPerformance.get(m.performance_id) ?? [];
        list.push(m);
        marksByPerformance.set(m.performance_id, list);
      }

      // JDG-08-07: attach each missing judge's self-reported offline-queue
      // depth from their most recently active device session, so "Waiting"
      // can be told apart from "already scored, not yet synced."
      const missingJudgeIds = new Set<string>();
      for (const p of performances) {
        for (const j of parseMissingJudges(p.missing_judges)) missingJudgeIds.add(j.judgeId);
      }
      const queueByJudge = new Map<string, number>();
      if (missingJudgeIds.size > 0) {
        const sessions = await db
          .selectFrom('user_sessions')
          .select(['user_id', 'queued_marks'])
          .where('user_id', 'in', [...missingJudgeIds])
          .where('revoked_at', 'is', null)
          .where('queued_marks', '>', 0)
          .orderBy('last_seen_at', 'desc')
          .execute();
        // Keep the highest-recency row per judge (first one seen, given the order above).
        for (const s of sessions) {
          if (!queueByJudge.has(s.user_id)) queueByJudge.set(s.user_id, s.queued_marks);
        }
      }

      const mapped = performances.map((p) => ({
        performanceId: p.performance_id,
        itemId: p.item_id,
        itemName: p.item_name,
        itemCode: p.item_code,
        status: p.status,
        panelSize: p.panel_size,
        submittedCount: Number(p.submitted_count),
        outstandingCount: Number(p.outstanding_count),
        // ADM-09-08: name the judges who have not submitted.
        // JDG-08-07: and whether they're actually behind, or just unsynced.
        missingJudges: parseMissingJudges(p.missing_judges).map((j) => ({
          ...j,
          queuedMarks: queueByJudge.get(j.judgeId) ?? 0,
        })),
        submittedJudgeIds: p.submitted_judge_ids ?? [],
        isCurrent: p.is_current,
        callOrder: p.call_order,
        attemptNo: p.attempt_no,
        chestNumber: p.chest_number,
        participantName: p.member_name ?? p.team_name ?? 'Unknown',
        photoPath: p.photo_path,
        churchName: p.church_name,
        churchShortCode: p.church_short_code,
        // Only ever populated for COMPLETE performances (ADM-09-03).
        aggregate:
          p.status === 'COMPLETE' && canSeeMarks && p.aggregate_score !== null
            ? Number(p.aggregate_score)
            : null,
        judgeMarks:
          p.status === 'COMPLETE' && canSeeMarks
            ? (marksByPerformance.get(p.performance_id) ?? []).map((m) => ({
                judgeId: m.judge_id,
                judgeName: m.judge_name,
                mark: Number(m.mark),
                remarks: m.remarks,
              }))
            : [],
      }));

      const outstanding = await listIncompletePerformances(id);

      // ADM-09-09: session progress, per item.
      const byItem = new Map<string, { itemId: string; itemName: string; total: number; complete: number }>();
      for (const p of mapped) {
        const entry = byItem.get(p.itemId) ?? {
          itemId: p.itemId,
          itemName: p.itemName,
          total: 0,
          complete: 0,
        };
        entry.total += 1;
        if (p.status === 'COMPLETE' || p.status === 'ABSENT' || p.status === 'VOID') entry.complete += 1;
        byItem.set(p.itemId, entry);
      }

      return ok(res, {
        session: {
          id: session.id,
          name: session.name,
          stage: session.stage,
          status: session.status,
          panelId: session.panel_id,
          panelName: session.panel_name,
        },
        current: mapped.find((p) => p.isCurrent) ?? null,
        performances: mapped,
        // ADM-09-08: "the single most important operational feature in the system"
        outstanding,
        itemProgress: [...byItem.values()],
        totals: {
          performances: mapped.length,
          complete: mapped.filter((p) => p.status === 'COMPLETE').length,
          absent: mapped.filter((p) => p.status === 'ABSENT').length,
          void: mapped.filter((p) => p.status === 'VOID').length,
          pending: outstanding.length,
        },
        canSeeMarks,
      });
    }),
  );

  return router;
}
