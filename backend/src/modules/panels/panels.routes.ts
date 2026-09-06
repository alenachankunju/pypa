/**
 * Panel management (FSD 5.8).
 *
 * ADM-08-02: "Panel size is not fixed. Any number of judges from one upwards is
 * supported; the system uses the actual assigned count as the completion target."
 * Nothing in this module assumes three (FSD 2.5).
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { AuditAction, actorFromRequest, writeAudit } from '../../services/audit.js';
import { publishPanelChanged } from '../../services/realtime.js';
import { errors } from '../../utils/errors.js';
import { auditedDelete, auditedInsert, auditedUpdate, crudContext } from '../../utils/crud.js';
import { asyncHandler, created, ok } from '../../utils/http.js';

const panelSchema = z.object({
  name: z.string().min(1).max(200),
  chiefJudgeId: z.string().uuid().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

const judgeAssignmentSchema = z.object({
  userId: z.string().uuid(),
  /** 4.4 WEIGHTED_AVERAGE. Default 1.0 leaves every judge equal. */
  weight: z.coerce.number().positive().max(100).optional(),
  /** ADM-07-03: required to override a conflict-of-interest warning. */
  conflictOverrideReason: z.string().min(10).max(500).optional(),
});

export function panelRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());
  router.use(requireCapability(Capability.MANAGE_PANELS));

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const panels = await db
        .selectFrom('panels as p')
        .leftJoin('users as chief', 'chief.id', 'p.chief_judge_id')
        .select(['p.id', 'p.name', 'p.notes', 'p.is_active', 'p.chief_judge_id', 'chief.full_name as chief_judge_name'])
        .where('p.event_id', '=', req.eventId!)
        .orderBy('p.name')
        .execute();

      const judges = await db
        .selectFrom('panel_judges as pj')
        .innerJoin('users as u', 'u.id', 'pj.user_id')
        .leftJoin('churches as c', 'c.id', 'u.affiliated_church_id')
        .select([
          'pj.panel_id',
          'pj.user_id',
          'pj.weight',
          'pj.conflict_override_reason',
          'u.full_name',
          'u.username',
          'u.is_active',
          'c.name as affiliated_church_name',
        ])
        .where('pj.removed_at', 'is', null)
        .execute();

      const byPanel = new Map<string, typeof judges>();
      for (const j of judges) {
        const list = byPanel.get(j.panel_id) ?? [];
        list.push(j);
        byPanel.set(j.panel_id, list);
      }

      return ok(
        res,
        panels.map((p) => {
          const members = byPanel.get(p.id) ?? [];
          return {
            id: p.id,
            name: p.name,
            notes: p.notes,
            isActive: p.is_active,
            chiefJudgeId: p.chief_judge_id,
            chiefJudgeName: p.chief_judge_name,
            // ADM-08-02: the completion target is whatever is actually assigned.
            panelSize: members.length,
            judges: members.map((j) => ({
              userId: j.user_id,
              fullName: j.full_name,
              username: j.username,
              weight: Number(j.weight),
              isActive: j.is_active,
              isChief: j.user_id === p.chief_judge_id,
              affiliatedChurchName: j.affiliated_church_name,
              conflictOverrideReason: j.conflict_override_reason,
            })),
          };
        }),
      );
    }),
  );

  router.post(
    '/',
    validate({ body: panelSchema }),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof panelSchema>;
      const row = await auditedInsert(
        'panels',
        {
          event_id: req.eventId!,
          name: input.name.trim(),
          chief_judge_id: input.chiefJudgeId ?? null,
          notes: input.notes ?? null,
          created_by: req.auth!.userId,
          updated_by: req.auth!.userId,
        },
        crudContext(req, 'panel', actorFromRequest(req)),
      );
      return created(res, row);
    }),
  );

  router.patch(
    '/:id',
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: panelSchema.partial().extend({ isActive: z.boolean().optional() }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const input = req.body as Partial<z.infer<typeof panelSchema>> & { isActive?: boolean };

      const row = await auditedUpdate(
        'panels',
        id,
        {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.chiefJudgeId !== undefined ? { chief_judge_id: input.chiefJudgeId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
          updated_by: req.auth!.userId,
        },
        crudContext(req, 'panel', actorFromRequest(req)),
      );
      return ok(res, row);
    }),
  );

  /**
   * A panel may only be deleted while no session references it (sessions.panel_id
   * is ON DELETE RESTRICT — the database is the actual guarantee; this route just
   * gives the refusal a clear message, same principle as ADM-02-03 for churches).
   * Removing a never-used panel also cascades its (empty) judge assignments.
   */
  router.delete(
    '/:id',
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      const panel = await db.selectFrom('panels').select(['id', 'name']).where('id', '=', id).executeTakeFirst();
      if (!panel) throw errors.notFound('Panel', id);

      const { count } = await db
        .selectFrom('sessions')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('panel_id', '=', id)
        .executeTakeFirstOrThrow();

      if (Number(count) > 0) {
        throw errors.inUse(
          `"${panel.name}" is used by ${count} session(s) and cannot be deleted. Deactivate it instead.`,
          { sessionCount: Number(count) },
        );
      }

      await auditedDelete('panels', id, crudContext(req, 'panel', actorFromRequest(req)));
      return ok(res, { deleted: true });
    }),
  );

  /**
   * Assign a judge to a panel (ADM-08-01, ADM-07-02).
   *
   * ADM-07-03: "Conflict-of-interest flag: a judge may be linked to a church, and
   * the system then warns when that judge is assigned to a panel scoring members
   * of that church. The warning can be overridden with a recorded reason."
   *
   * The check runs against the churches actually entered in the panel's sessions,
   * not merely against the judge's affiliation — a warning that fires when the
   * affiliated church has no entrant would train operators to click through it.
   */
  router.post(
    '/:id/judges',
    validate({ params: z.object({ id: z.string().uuid() }), body: judgeAssignmentSchema }),
    asyncHandler(async (req, res) => {
      const { id: panelId } = req.params as { id: string };
      const input = req.body as z.infer<typeof judgeAssignmentSchema>;

      const [panel, judge] = await Promise.all([
        db.selectFrom('panels').select(['id', 'name']).where('id', '=', panelId).executeTakeFirst(),
        db
          .selectFrom('users')
          .select(['id', 'full_name', 'role', 'is_active', 'affiliated_church_id'])
          .where('id', '=', input.userId)
          .executeTakeFirst(),
      ]);

      if (!panel) throw errors.notFound('Panel', panelId);
      if (!judge) throw errors.notFound('Judge', input.userId);
      if (judge.role !== 'JUDGE') {
        throw errors.validation(`${judge.full_name} is not a judge account and cannot be put on a panel.`);
      }
      if (!judge.is_active) {
        throw errors.validation(`${judge.full_name}'s account is deactivated.`);
      }

      // ADM-07-03 conflict check.
      if (judge.affiliated_church_id && !input.conflictOverrideReason) {
        const conflict = await db
          .selectFrom('registrations as r')
          .innerJoin('session_items as si', 'si.item_id', 'r.item_id')
          .innerJoin('sessions as s', 's.id', 'si.session_id')
          .innerJoin('churches as c', 'c.id', 'r.church_id')
          .select((eb) => ['c.name as church_name', eb.fn.countAll<number>().as('entrants')])
          .where('s.panel_id', '=', panelId)
          .where('r.church_id', '=', judge.affiliated_church_id)
          .where('r.status', '=', 'REGISTERED')
          .groupBy('c.name')
          .executeTakeFirst();

        if (conflict) {
          throw errors.conflict(
            `${judge.full_name} is linked to ${conflict.church_name}, which has ${conflict.entrants} entrant(s) in this panel's sessions. Assigning them anyway requires a recorded reason (FSD ADM-07-03).`,
            {
              requiresOverride: 'conflictOverrideReason',
              churchName: conflict.church_name,
              entrants: Number(conflict.entrants),
            },
          );
        }
      }

      await db.transaction().execute(async (trx) => {
        // A previously removed judge is re-added as a NEW row; the old one keeps
        // its removed_at so the composition history stays reconstructible
        // (ADM-08-06).
        await trx
          .insertInto('panel_judges')
          .values({
            panel_id: panelId,
            user_id: input.userId,
            weight: input.weight ?? 1.0,
            conflict_override_reason: input.conflictOverrideReason ?? null,
            created_by: req.auth!.userId,
            updated_by: req.auth!.userId,
          })
          .execute();

        await writeAudit(
          {
            eventId: req.eventId,
            actor: actorFromRequest(req),
            action: AuditAction.PANEL_JUDGE_ADDED,
            entityType: 'panel',
            entityId: panelId,
            newValue: { judgeId: input.userId, judgeName: judge.full_name, weight: input.weight ?? 1.0 },
            reason: input.conflictOverrideReason ?? null,
          },
          trx,
        );
      });

      await notifySessions(panelId);
      return created(res, { panelId, judgeId: input.userId });
    }),
  );

  /**
   * ADM-08-06: "Mid-session panel change: if a judge must be replaced, the
   * administrator removes them and adds a replacement. Performances already
   * COMPLETE are unaffected; the completion target for pending performances is
   * recalculated."
   *
   * That recalculation is what this route does beyond the soft removal: pending
   * performances lose the departing judge from their expected panel and have
   * panel_size reduced to match. Performances already COMPLETE keep the target
   * they started with (FSD 7.2), so the result sheet stays explainable.
   */
  router.delete(
    '/:id/judges/:userId',
    validate({
      params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }),
      body: z.object({ reason: z.string().min(5).max(500) }).optional(),
    }),
    asyncHandler(async (req, res) => {
      const { id: panelId, userId } = req.params as { id: string; userId: string };
      const reason = (req.body as { reason?: string } | undefined)?.reason ?? 'Judge removed from panel';

      const result = await db.transaction().execute(async (trx) => {
        const assignment = await trx
          .selectFrom('panel_judges')
          .select(['id'])
          .where('panel_id', '=', panelId)
          .where('user_id', '=', userId)
          .where('removed_at', 'is', null)
          .executeTakeFirst();

        if (!assignment) throw errors.notFound('Panel assignment');

        await trx
          .updateTable('panel_judges')
          .set({
            removed_at: new Date(),
            removed_by: req.auth!.userId,
            removed_reason: reason,
            updated_by: req.auth!.userId,
          })
          .where('id', '=', assignment.id)
          .execute();

        // Pending performances in this panel's sessions: drop the judge from the
        // expected panel and lower the completion target.
        const pending = await trx
          .selectFrom('performances as p')
          .innerJoin('sessions as s', 's.id', 'p.session_id')
          .innerJoin('performance_judges as pj', 'pj.performance_id', 'p.id')
          .select(['p.id', 'p.panel_size'])
          .where('s.panel_id', '=', panelId)
          .where('p.status', 'in', ['SCHEDULED', 'ON_STAGE', 'IN_PROGRESS'])
          .where('pj.judge_id', '=', userId)
          .execute();

        for (const performance of pending) {
          await trx
            .deleteFrom('performance_judges')
            .where('performance_id', '=', performance.id)
            .where('judge_id', '=', userId)
            .execute();

          await trx
            .updateTable('performances')
            .set({ panel_size: Math.max(1, performance.panel_size - 1), updated_by: req.auth!.userId })
            .where('id', '=', performance.id)
            .execute();
        }

        await writeAudit(
          {
            eventId: req.eventId,
            actor: actorFromRequest(req),
            action: AuditAction.PANEL_JUDGE_REMOVED,
            entityType: 'panel',
            entityId: panelId,
            oldValue: { judgeId: userId },
            newValue: { pendingPerformancesRetargeted: pending.length },
            reason,
          },
          trx,
        );

        return { pendingRetargeted: pending.length };
      });

      await notifySessions(panelId);

      return ok(res, {
        removed: true,
        ...result,
        note:
          result.pendingRetargeted > 0
            ? `${result.pendingRetargeted} pending performance(s) had their completion target reduced. Performances already complete are unaffected (FSD ADM-08-06).`
            : 'No pending performances were affected.',
      });
    }),
  );

  return router;
}

/** Tell devices in this panel's open sessions to re-read their assignment. */
async function notifySessions(panelId: string): Promise<void> {
  const sessions = await db
    .selectFrom('sessions')
    .select('id')
    .where('panel_id', '=', panelId)
    .where('status', '=', 'OPEN')
    .execute();

  for (const session of sessions) publishPanelChanged(session.id, panelId);
}
