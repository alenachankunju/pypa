/**
 * Performance control — the live judging console's actions (FSD 5.9).
 *
 * Every route here changes what is happening on stage right now, so each one
 * pushes to the judge devices on the panel (FSD 3.3) and records why (FSD 5.14).
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { AuditAction, actorFromRequest, writeAudit } from '../../services/audit.js';
import {
  publishCurrentPerformance,
  publishPerformanceStatus,
} from '../../services/realtime.js';
import { recomputeItem } from '../../services/results/recompute.js';
import { errors } from '../../utils/errors.js';
import { asyncHandler, created, ok } from '../../utils/http.js';

export function performanceRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());

  /**
   * FSD 9.2: POST /api/performances — create a performance.
   *
   * Most performances are materialised when a session opens. This route covers
   * the cases that arise afterwards: a late entry (FSD 12.2) added to an
   * already-open session, and the re-run created by a void (ADM-09-07).
   */
  router.post(
    '/',
    requireCapability(Capability.CONTROL_STAGE),
    validate({
      body: z.object({
        registrationId: z.string().uuid(),
        sessionId: z.string().uuid(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const input = req.body as { registrationId: string; sessionId: string };
      const performance = await createPerformanceForRegistration(
        input.registrationId,
        input.sessionId,
        req.eventId!,
        req.auth!.userId,
        actorFromRequest(req),
      );
      return created(res, performance);
    }),
  );

  /**
   * ADM-09-02: "Set the current performance on stage. This pushes to every judge
   * device on the panel, which then opens directly on that participant."
   *
   * The partial unique index performances_one_current_per_session, together with
   * the trigger that stands the previous one down, makes this atomic — two
   * coordinators cannot leave two participants on stage at once.
   */
  router.post(
    '/:id/set-current',
    requireCapability(Capability.CONTROL_STAGE),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      const performance = await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('performances as p')
          .innerJoin('sessions as s', 's.id', 'p.session_id')
          .select(['p.id', 'p.status', 'p.session_id', 'p.item_id', 's.status as session_status', 's.name as session_name'])
          .where('p.id', '=', id)
          .where('p.event_id', '=', req.eventId!)
          .executeTakeFirst();

        if (!row) throw errors.notFound('Performance', id);
        if (row.session_status !== 'OPEN') throw errors.sessionNotOpen(row.session_name);

        if (!['SCHEDULED', 'ON_STAGE', 'IN_PROGRESS'].includes(row.status)) {
          throw errors.performanceLocked(row.status);
        }

        await trx
          .updateTable('performances')
          .set({
            is_current: true,
            // A performance mid-scoring stays IN_PROGRESS; the state machine
            // (migration 0009) has no IN_PROGRESS -> ON_STAGE transition, and
            // moving backwards would misreport what has already happened.
            ...(row.status === 'SCHEDULED' ? { status: 'ON_STAGE' as const } : {}),
            on_stage_at: new Date(),
            updated_by: req.auth!.userId,
          })
          .where('id', '=', id)
          .execute();

        await writeAudit(
          {
            eventId: req.eventId,
            actor: actorFromRequest(req),
            action: AuditAction.PERFORMANCE_SET_CURRENT,
            entityType: 'performance',
            entityId: id,
            sessionId: row.session_id,
          },
          trx,
        );

        return row;
      });

      await pushCurrentPerformance(performance.session_id!, id);
      return ok(res, { performanceId: id, isCurrent: true });
    }),
  );

  /**
   * ADM-09-05: "Advance to the next participant with a single action, which
   * closes the current performance and opens the next in call order."
   */
  router.post(
    '/advance',
    requireCapability(Capability.CONTROL_STAGE),
    validate({ body: z.object({ sessionId: z.string().uuid(), itemId: z.string().uuid().optional() }) }),
    asyncHandler(async (req, res) => {
      const { sessionId, itemId } = req.body as { sessionId: string; itemId?: string };

      const current = await db
        .selectFrom('performances')
        .select(['id', 'item_id', 'call_order'])
        .where('session_id', '=', sessionId)
        .where('is_current', '=', true)
        .executeTakeFirst();

      let query = db
        .selectFrom('performances')
        .select(['id', 'item_id', 'call_order'])
        .where('session_id', '=', sessionId)
        .where('status', '=', 'SCHEDULED')
        .orderBy('call_order')
        .orderBy('created_at');

      if (itemId ?? current?.item_id) {
        query = query.where('item_id', '=', (itemId ?? current!.item_id) as string);
      }
      if (current?.call_order != null) {
        query = query.where('call_order', '>', current.call_order);
      }

      const next = await query.executeTakeFirst();

      if (!next) {
        // Nothing left in this item: stand the current performance down so no
        // judge device is left pointing at someone who has finished.
        if (current) {
          await db
            .updateTable('performances')
            .set({ is_current: false, updated_by: req.auth!.userId })
            .where('id', '=', current.id)
            .execute();
          publishCurrentPerformance(sessionId, null);
        }
        return ok(res, { advanced: false, message: 'No further participants are scheduled in this item.' });
      }

      await db
        .updateTable('performances')
        .set({ is_current: true, status: 'ON_STAGE', on_stage_at: new Date(), updated_by: req.auth!.userId })
        .where('id', '=', next.id)
        .execute();

      await writeAudit({
        eventId: req.eventId,
        actor: actorFromRequest(req),
        action: AuditAction.PERFORMANCE_SET_CURRENT,
        entityType: 'performance',
        entityId: next.id,
        sessionId,
        reason: 'Advanced to the next participant in call order (FSD ADM-09-05).',
      });

      await pushCurrentPerformance(sessionId, next.id);
      return ok(res, { advanced: true, performanceId: next.id });
    }),
  );

  /**
   * ADM-09-06 / FSD 9.2: mark a participant absent.
   *
   * FSD 12.1: "Marked ABSENT. Excluded from ranking, shown on the result sheet
   * with status, counted as resolved for session closure." That last clause is
   * what stops an absentee blocking ADM-08-05's close check — the participant is
   * accounted for rather than merely missing.
   */
  router.post(
    '/:id/absent',
    requireCapability(Capability.MARK_ABSENT),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ note: z.string().max(500).optional() }).optional(),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const note = (req.body as { note?: string } | undefined)?.note ?? null;

      const performance = await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('performances')
          .select(['id', 'status', 'session_id', 'item_id'])
          .where('id', '=', id)
          .where('event_id', '=', req.eventId!)
          .forUpdate()
          .executeTakeFirst();

        if (!row) throw errors.notFound('Performance', id);
        if (!['SCHEDULED', 'ON_STAGE'].includes(row.status)) {
          throw errors.performanceLocked(
            row.status === 'IN_PROGRESS'
              ? 'already being scored — void it instead if the participant did not appear'
              : row.status,
          );
        }

        await trx
          .updateTable('performances')
          .set({ status: 'ABSENT', absent_note: note, is_current: false, updated_by: req.auth!.userId })
          .where('id', '=', id)
          .execute();

        await writeAudit(
          {
            eventId: req.eventId,
            actor: actorFromRequest(req),
            action: AuditAction.PERFORMANCE_ABSENT,
            entityType: 'performance',
            entityId: id,
            oldValue: { status: row.status },
            newValue: { status: 'ABSENT' },
            reason: note,
            sessionId: row.session_id,
          },
          trx,
        );

        return row;
      });

      if (performance.session_id) publishPerformanceStatus(performance.session_id, id, 'ABSENT');

      // An absence can complete an item, so the result is recomputed.
      await recomputeItem(
        performance.item_id,
        req.eventId!,
        'PERFORMANCE_ABSENT',
        actorFromRequest(req),
      );

      return ok(res, { performanceId: id, status: 'ABSENT' });
    }),
  );

  /**
   * ADM-09-07 / FSD 9.2: void a performance and create the re-run.
   *
   * "Void a performance with a mandatory reason (for example equipment failure)
   * and create a re-performance. Both records are retained."
   *
   * FSD 4.1: "The first Performance is voided with a reason; a second Performance
   * is created. Both are retained in the audit trail. No score is silently
   * overwritten." The voided attempt keeps its scores; they simply stop counting,
   * because only COMPLETE performances are ranked (FSD 7.1).
   */
  router.post(
    '/:id/void',
    requireCapability(Capability.CONTROL_STAGE),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({
        reason: z.string().min(15).max(500),
        createReplacement: z.boolean().optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const { reason, createReplacement = true } = req.body as {
        reason: string;
        createReplacement?: boolean;
      };

      const result = await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('performances')
          .select(['id', 'status', 'session_id', 'item_id', 'registration_id', 'attempt_no', 'panel_size', 'call_order'])
          .where('id', '=', id)
          .where('event_id', '=', req.eventId!)
          .forUpdate()
          .executeTakeFirst();

        if (!row) throw errors.notFound('Performance', id);
        if (row.status === 'VOID') throw errors.conflict('This performance has already been voided.');

        await trx
          .updateTable('performances')
          .set({
            status: 'VOID',
            void_reason: reason,
            voided_by: req.auth!.userId,
            voided_at: new Date(),
            is_current: false,
            // The aggregate is cleared: a voided attempt must not be ranked, and
            // leaving the number behind invites it being read as a result.
            aggregate_score: null,
            updated_by: req.auth!.userId,
          })
          .where('id', '=', id)
          .execute();

        await writeAudit(
          {
            eventId: req.eventId,
            actor: actorFromRequest(req),
            action: AuditAction.PERFORMANCE_VOIDED,
            entityType: 'performance',
            entityId: id,
            oldValue: { status: row.status, attemptNo: row.attempt_no },
            newValue: { status: 'VOID' },
            reason,
            sessionId: row.session_id,
          },
          trx,
        );

        let replacementId: string | null = null;

        if (createReplacement) {
          // The re-run copies the ORIGINAL panel snapshot, so the second attempt
          // is judged to the same target as the first (FSD 7.2).
          const judges = await trx
            .selectFrom('performance_judges')
            .select(['judge_id', 'weight', 'is_chief'])
            .where('performance_id', '=', id)
            .execute();

          const replacement = await trx
            .insertInto('performances')
            .values({
              event_id: req.eventId!,
              registration_id: row.registration_id,
              item_id: row.item_id,
              session_id: row.session_id,
              attempt_no: row.attempt_no + 1,
              panel_size: row.panel_size,
              status: 'SCHEDULED',
              call_order: row.call_order,
              created_by: req.auth!.userId,
              updated_by: req.auth!.userId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();

          if (judges.length > 0) {
            await trx
              .insertInto('performance_judges')
              .values(
                judges.map((j) => ({
                  performance_id: replacement.id,
                  judge_id: j.judge_id,
                  weight: Number(j.weight),
                  is_chief: j.is_chief,
                })),
              )
              .execute();
          }

          replacementId = replacement.id;

          await writeAudit(
            {
              eventId: req.eventId,
              actor: actorFromRequest(req),
              action: AuditAction.PERFORMANCE_CREATED,
              entityType: 'performance',
              entityId: replacement.id,
              newValue: { attemptNo: row.attempt_no + 1, replaces: id },
              reason: `Re-performance created after attempt ${row.attempt_no} was voided: ${reason}`,
              sessionId: row.session_id,
            },
            trx,
          );
        }

        return { sessionId: row.session_id, itemId: row.item_id, replacementId };
      });

      if (result.sessionId) publishPerformanceStatus(result.sessionId, id, 'VOID');

      await recomputeItem(result.itemId, req.eventId!, 'PERFORMANCE_VOIDED', actorFromRequest(req), reason);

      return ok(res, {
        performanceId: id,
        status: 'VOID',
        replacementPerformanceId: result.replacementId,
      });
    }),
  );

  /**
   * FSD 7.1: "ABSENT -> SCHEDULED (only if reinstated by admin)".
   * Used when a participant thought to be absent turns up after all.
   */
  router.post(
    '/:id/reinstate',
    requireCapability(Capability.MARK_ABSENT),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().min(5).max(500) }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };

      const row = await db
        .selectFrom('performances')
        .select(['id', 'status', 'session_id', 'item_id'])
        .where('id', '=', id)
        .where('event_id', '=', req.eventId!)
        .executeTakeFirst();

      if (!row) throw errors.notFound('Performance', id);
      if (row.status !== 'ABSENT') {
        throw errors.conflict('Only a performance marked ABSENT can be reinstated (FSD 7.1).');
      }

      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('performances')
          .set({ status: 'SCHEDULED', absent_note: null, updated_by: req.auth!.userId })
          .where('id', '=', id)
          .execute();

        await writeAudit(
          {
            eventId: req.eventId,
            actor: actorFromRequest(req),
            action: AuditAction.PERFORMANCE_REINSTATED,
            entityType: 'performance',
            entityId: id,
            oldValue: { status: 'ABSENT' },
            newValue: { status: 'SCHEDULED' },
            reason,
            sessionId: row.session_id,
          },
          trx,
        );
      });

      if (row.session_id) publishPerformanceStatus(row.session_id, id, 'SCHEDULED');
      await recomputeItem(row.item_id, req.eventId!, 'MANUAL', actorFromRequest(req), reason);

      return ok(res, { performanceId: id, status: 'SCHEDULED' });
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------

/** Create a performance with its panel snapshot (FSD 7.2). */
async function createPerformanceForRegistration(
  registrationId: string,
  sessionId: string,
  eventId: string,
  userId: string,
  actor: ReturnType<typeof actorFromRequest>,
): Promise<{ performanceId: string; attemptNo: number; panelSize: number }> {
  return db.transaction().execute(async (trx) => {
    const [registration, session] = await Promise.all([
      trx
        .selectFrom('registrations')
        .select(['id', 'item_id', 'status', 'call_order'])
        .where('id', '=', registrationId)
        .executeTakeFirst(),
      trx
        .selectFrom('sessions')
        .select(['id', 'status', 'panel_id', 'name'])
        .where('id', '=', sessionId)
        .executeTakeFirst(),
    ]);

    if (!registration) throw errors.notFound('Registration', registrationId);
    if (!session) throw errors.notFound('Session', sessionId);
    if (registration.status !== 'REGISTERED') {
      throw errors.conflict('This registration has been withdrawn.');
    }

    const judges = await trx
      .selectFrom('panel_judges as pj')
      .innerJoin('users as u', 'u.id', 'pj.user_id')
      .innerJoin('panels as p', 'p.id', 'pj.panel_id')
      .select(['pj.user_id', 'pj.weight', 'p.chief_judge_id'])
      .where('pj.panel_id', '=', session.panel_id)
      .where('pj.removed_at', 'is', null)
      .where('u.is_active', '=', true)
      .execute();

    if (judges.length === 0) {
      throw errors.conflict(`The panel for "${session.name}" has no active judges.`);
    }

    const previous = await trx
      .selectFrom('performances')
      .select(['attempt_no'])
      .where('registration_id', '=', registrationId)
      .orderBy('attempt_no', 'desc')
      .executeTakeFirst();

    const attemptNo = (previous?.attempt_no ?? 0) + 1;

    const performance = await trx
      .insertInto('performances')
      .values({
        event_id: eventId,
        registration_id: registrationId,
        item_id: registration.item_id,
        session_id: sessionId,
        attempt_no: attemptNo,
        panel_size: judges.length,
        status: 'SCHEDULED',
        call_order: registration.call_order,
        created_by: userId,
        updated_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('performance_judges')
      .values(
        judges.map((j) => ({
          performance_id: performance.id,
          judge_id: j.user_id,
          weight: Number(j.weight),
          is_chief: j.user_id === j.chief_judge_id,
        })),
      )
      .execute();

    await writeAudit(
      {
        eventId,
        actor,
        action: AuditAction.PERFORMANCE_CREATED,
        entityType: 'performance',
        entityId: performance.id,
        newValue: { registrationId, attemptNo, panelSize: judges.length },
        sessionId,
      },
      trx,
    );

    return { performanceId: performance.id, attemptNo, panelSize: judges.length };
  });
}

/** Push the on-stage participant to every judge device in the session. */
async function pushCurrentPerformance(sessionId: string, performanceId: string): Promise<void> {
  const row = await db
    .selectFrom('performances as p')
    .innerJoin('items as i', 'i.id', 'p.item_id')
    .innerJoin('registrations as r', 'r.id', 'p.registration_id')
    .innerJoin('churches as c', 'c.id', 'r.church_id')
    .leftJoin('members as m', 'm.id', 'r.member_id')
    .select([
      'p.id',
      'p.item_id',
      'p.call_order',
      'i.name as item_name',
      'r.id as registration_id',
      'r.team_name',
      'm.chest_number',
      'm.full_name as member_name',
      'm.photo_path',
      'c.name as church_name',
    ])
    .where('p.id', '=', performanceId)
    .executeTakeFirst();

  if (!row) return;

  // JDG-02-04: "A progress strip shows position in the item, for example
  // 'Participant 7 of 21'."
  const siblings = await db
    .selectFrom('performances')
    .select(['id', 'call_order'])
    .where('item_id', '=', row.item_id)
    .where('session_id', '=', sessionId)
    .where('status', '!=', 'VOID')
    .orderBy('call_order')
    .orderBy('created_at')
    .execute();

  const position = siblings.findIndex((s) => s.id === performanceId) + 1;

  publishCurrentPerformance(sessionId, {
    performanceId: row.id,
    itemId: row.item_id,
    itemName: row.item_name,
    registrationId: row.registration_id,
    chestNumber: row.chest_number,
    memberName: row.member_name ?? row.team_name,
    churchName: row.church_name,
    photoPath: row.photo_path,
    position: position > 0 ? position : 1,
    total: siblings.length,
  });
}
