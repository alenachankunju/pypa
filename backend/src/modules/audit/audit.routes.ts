/**
 * Audit log search (FSD 5.14, 9.2 GET /api/audit).
 *
 * ADM-14-03: "The audit log is append-only. No user interface exists to edit or
 * delete an entry." This router is read-only by construction: it exposes GET and
 * nothing else, and the database refuses UPDATE and DELETE regardless
 * (migration 0009).
 *
 * ADM-14-04: "The log is searchable by date range, user, action type and entity."
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { AuditAction } from '../../services/audit.js';
import { asyncHandler, ok, pageParams, paginated } from '../../utils/http.js';

export function auditRoutes(): Router {
  const router = Router();
  router.use(requireCapability(Capability.VIEW_AUDIT_LOG));

  router.get(
    '/',
    validate({
      query: z.object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        actorId: z.string().uuid().optional(),
        action: z.string().max(100).optional(),
        entityType: z.string().max(60).optional(),
        entityId: z.string().max(100).optional(),
        search: z.string().max(200).optional(),
        page: z.coerce.number().int().positive().optional(),
        pageSize: z.coerce.number().int().positive().max(200).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as {
        from?: Date;
        to?: Date;
        actorId?: string;
        action?: string;
        entityType?: string;
        entityId?: string;
        search?: string;
      };
      const { page, pageSize, offset } = pageParams(req.query as Record<string, unknown>, 100);

      let base = db.selectFrom('audit_logs as a');

      if (req.eventId) {
        // Entries with a null event_id are system-wide (user management, login)
        // and belong in the trail for whichever event is active.
        base = base.where((eb) =>
          eb.or([eb('a.event_id', '=', req.eventId!), eb('a.event_id', 'is', null)]),
        );
      }
      if (q.from) base = base.where('a.occurred_at', '>=', q.from);
      if (q.to) base = base.where('a.occurred_at', '<=', q.to);
      if (q.actorId) base = base.where('a.actor_id', '=', q.actorId);
      if (q.action) base = base.where('a.action', '=', q.action);
      if (q.entityType) base = base.where('a.entity_type', '=', q.entityType);
      if (q.entityId) base = base.where('a.entity_id', '=', q.entityId);
      if (q.search) {
        base = base.where((eb) =>
          eb.or([
            eb('a.actor_name', 'ilike', `%${q.search}%`),
            eb('a.reason', 'ilike', `%${q.search}%`),
            eb('a.action', 'ilike', `%${q.search}%`),
          ]),
        );
      }

      const [rows, total] = await Promise.all([
        base
          .select([
            'a.id',
            'a.occurred_at',
            'a.actor_id',
            'a.actor_name',
            'a.actor_role',
            'a.ip_address',
            'a.action',
            'a.entity_type',
            'a.entity_id',
            'a.old_value',
            'a.new_value',
            'a.reason',
            'a.device_id',
            'a.request_id',
          ])
          .orderBy('a.occurred_at', 'desc')
          .orderBy('a.id', 'desc')
          .limit(pageSize)
          .offset(offset)
          .execute(),
        base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
      ]);

      return paginated(
        res,
        rows.map((r) => ({
          id: Number(r.id),
          occurredAt: r.occurred_at,
          actorId: r.actor_id,
          actorName: r.actor_name,
          actorRole: r.actor_role,
          ipAddress: r.ip_address,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          oldValue: r.old_value,
          newValue: r.new_value,
          reason: r.reason,
          deviceId: r.device_id,
          requestId: r.request_id,
        })),
        page,
        pageSize,
        Number(total.count),
        { appendOnly: true },
      );
    }),
  );

  /** Filter options for the audit screen (A18), drawn from what is actually present. */
  router.get(
    '/filters',
    asyncHandler(async (req, res) => {
      const [actions, entityTypes, actors] = await Promise.all([
        db.selectFrom('audit_logs').select('action').distinct().orderBy('action').limit(200).execute(),
        db
          .selectFrom('audit_logs')
          .select('entity_type')
          .distinct()
          .orderBy('entity_type')
          .limit(100)
          .execute(),
        db
          .selectFrom('audit_logs')
          .select(['actor_id', 'actor_name'])
          .distinct()
          .where('actor_id', 'is not', null)
          .orderBy('actor_name')
          .limit(300)
          .execute(),
      ]);

      return ok(res, {
        actions: actions.map((a) => a.action),
        entityTypes: entityTypes.map((e) => e.entity_type),
        actors: actors.map((a) => ({ id: a.actor_id, name: a.actor_name })),
        knownActions: Object.values(AuditAction),
      });
    }),
  );

  /**
   * ADM-10-04 exceptions report data.
   *
   * "Every revocation appears in a dedicated exceptions report, which is printed
   * alongside the final results so the committee can see exactly what was
   * corrected and why."
   *
   * FSD 5.13 widens that to the full set: "Voided performances, absentees,
   * revoked scores, forced session closures, manual tie decisions, category
   * overrides — each with reason and actor."
   */
  router.get(
    '/exceptions',
    asyncHandler(async (req, res) => {
      const eventId = req.eventId;

      const [revokedScores, voidedPerformances, absentees, forcedClosures, tieDecisions, overrides, lateEntries, backEntries] =
        await Promise.all([
          db
            .selectFrom('scores as s')
            .innerJoin('performances as p', 'p.id', 's.performance_id')
            .innerJoin('items as i', 'i.id', 'p.item_id')
            .innerJoin('users as j', 'j.id', 's.judge_id')
            .leftJoin('users as rb', 'rb.id', 's.revoked_by')
            .leftJoin('registrations as r', 'r.id', 'p.registration_id')
            .leftJoin('members as m', 'm.id', 'r.member_id')
            .select([
              's.id',
              's.mark',
              's.revoked_at',
              's.revoked_reason',
              'i.name as item_name',
              'j.full_name as judge_name',
              'rb.full_name as revoked_by_name',
              'm.chest_number',
              'm.full_name as member_name',
            ])
            .where('s.revoked', '=', true)
            .$if(Boolean(eventId), (qb) => qb.where('p.event_id', '=', eventId!))
            .orderBy('s.revoked_at', 'desc')
            .execute(),

          db
            .selectFrom('performances as p')
            .innerJoin('items as i', 'i.id', 'p.item_id')
            .leftJoin('users as u', 'u.id', 'p.voided_by')
            .leftJoin('registrations as r', 'r.id', 'p.registration_id')
            .leftJoin('members as m', 'm.id', 'r.member_id')
            .select([
              'p.id',
              'p.attempt_no',
              'p.void_reason',
              'p.voided_at',
              'i.name as item_name',
              'u.full_name as voided_by_name',
              'm.chest_number',
              'm.full_name as member_name',
            ])
            .where('p.status', '=', 'VOID')
            .$if(Boolean(eventId), (qb) => qb.where('p.event_id', '=', eventId!))
            .orderBy('p.voided_at', 'desc')
            .execute(),

          db
            .selectFrom('performances as p')
            .innerJoin('items as i', 'i.id', 'p.item_id')
            .leftJoin('registrations as r', 'r.id', 'p.registration_id')
            .leftJoin('members as m', 'm.id', 'r.member_id')
            .select(['p.id', 'p.absent_note', 'i.name as item_name', 'm.chest_number', 'm.full_name as member_name'])
            .where('p.status', '=', 'ABSENT')
            .$if(Boolean(eventId), (qb) => qb.where('p.event_id', '=', eventId!))
            .execute(),

          db
            .selectFrom('sessions as s')
            .leftJoin('users as u', 'u.id', 's.closed_by')
            .select(['s.id', 's.name', 's.force_closed_reason', 's.closed_at', 'u.full_name as closed_by_name'])
            .where('s.status', '=', 'FORCE_CLOSED')
            .$if(Boolean(eventId), (qb) => qb.where('s.event_id', '=', eventId!))
            .execute(),

          db
            .selectFrom('manual_tie_decisions as d')
            .innerJoin('items as i', 'i.id', 'd.item_id')
            .innerJoin('users as u', 'u.id', 'd.decided_by')
            .select([
              'd.id',
              'd.assigned_position',
              'd.declared_shared',
              'd.reason',
              'd.decided_at',
              'i.name as item_name',
              'u.full_name as decided_by_name',
            ])
            .where('d.superseded_at', 'is', null)
            .$if(Boolean(eventId), (qb) => qb.where('d.event_id', '=', eventId!))
            .execute(),

          db
            .selectFrom('members as m')
            .innerJoin('churches as c', 'c.id', 'm.church_id')
            .select(['m.id', 'm.chest_number', 'm.full_name', 'm.category_override_reason', 'c.name as church_name'])
            .where('m.category_override_reason', 'is not', null)
            .$if(Boolean(eventId), (qb) => qb.where('m.event_id', '=', eventId!))
            .execute(),

          db
            .selectFrom('registrations as r')
            .innerJoin('items as i', 'i.id', 'r.item_id')
            .leftJoin('members as m', 'm.id', 'r.member_id')
            .select(['r.id', 'i.name as item_name', 'm.chest_number', 'm.full_name as member_name', 'r.eligibility_override_reason'])
            .where('r.is_late_entry', '=', true)
            .$if(Boolean(eventId), (qb) => qb.where('r.event_id', '=', eventId!))
            .execute(),

          db
            .selectFrom('scores as s')
            .innerJoin('performances as p', 'p.id', 's.performance_id')
            .innerJoin('items as i', 'i.id', 'p.item_id')
            .innerJoin('users as j', 'j.id', 's.judge_id')
            .leftJoin('users as e', 'e.id', 's.entered_by')
            .select([
              's.id',
              's.mark',
              's.back_entry_reason',
              's.submitted_at',
              'i.name as item_name',
              'j.full_name as judge_name',
              'e.full_name as entered_by_name',
            ])
            .where('s.entry_mode', '=', 'ADMIN_BACK_ENTRY')
            .$if(Boolean(eventId), (qb) => qb.where('p.event_id', '=', eventId!))
            .execute(),
        ]);

      return ok(res, {
        revokedScores,
        voidedPerformances,
        absentees,
        forcedSessionClosures: forcedClosures,
        manualTieDecisions: tieDecisions,
        categoryOverrides: overrides,
        lateEntries,
        paperBackEntries: backEntries,
        totals: {
          revokedScores: revokedScores.length,
          voidedPerformances: voidedPerformances.length,
          absentees: absentees.length,
          forcedSessionClosures: forcedClosures.length,
          manualTieDecisions: tieDecisions.length,
          categoryOverrides: overrides.length,
          lateEntries: lateEntries.length,
          paperBackEntries: backEntries.length,
        },
      });
    }),
  );

  return router;
}
