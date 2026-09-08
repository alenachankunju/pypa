/**
 * Registration routes (FSD 5.6).
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { AuditAction, actorFromRequest, writeAudit } from '../../services/audit.js';
import { errors } from '../../utils/errors.js';
import { asyncHandler, created, ok } from '../../utils/http.js';
import {
  createRegistration,
  createTeamRegistration,
  deleteRegistration,
  withdrawRegistration,
} from './registrations.service.js';

export function registrationRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());
  router.use(requireCapability(Capability.MANAGE_REGISTRATIONS));

  /**
   * ADM-06-01: "From an item, the administrator can add participants by
   * searching chest number or name, and can see the current entry list with
   * church names."
   */
  router.get(
    '/',
    validate({
      query: z.object({
        itemId: z.string().uuid().optional(),
        memberId: z.string().uuid().optional(),
        churchId: z.string().uuid().optional(),
        status: z.enum(['REGISTERED', 'WITHDRAWN']).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const q = req.query as Record<string, string | undefined>;

      let query = db
        .selectFrom('registrations as r')
        .innerJoin('items as i', 'i.id', 'r.item_id')
        .innerJoin('churches as c', 'c.id', 'r.church_id')
        .leftJoin('members as m', 'm.id', 'r.member_id')
        .leftJoin('categories as cat', 'cat.id', 'm.category_id')
        .select([
          'r.id',
          'r.status',
          'r.team_name',
          'r.is_late_entry',
          'r.eligibility_override_reason',
          'r.call_order',
          'r.withdrawn_reason',
          'i.id as item_id',
          'i.name as item_name',
          'i.code as item_code',
          'i.type as item_type',
          'm.id as member_id',
          'm.chest_number',
          'm.full_name as member_name',
          'm.photo_path',
          'c.id as church_id',
          'c.name as church_name',
          'c.short_code as church_short_code',
          'cat.name as category_name',
        ])
        .where('r.event_id', '=', req.eventId!);

      if (q.itemId) query = query.where('r.item_id', '=', q.itemId);
      if (q.memberId) query = query.where('r.member_id', '=', q.memberId);
      if (q.churchId) query = query.where('r.church_id', '=', q.churchId);
      query = query.where('r.status', '=', (q.status ?? 'REGISTERED') as 'REGISTERED' | 'WITHDRAWN');

      const rows = await query
        .orderBy('r.call_order')
        .orderBy('m.chest_number_numeric')
        .orderBy('r.team_name')
        .execute();

      // Team members for the group entries on this page.
      const teamRegistrationIds = rows.filter((r) => r.member_id === null).map((r) => r.id);
      const teamMembers =
        teamRegistrationIds.length > 0
          ? await db
              .selectFrom('registration_members as rm')
              .innerJoin('members as m', 'm.id', 'rm.member_id')
              .select([
                'rm.registration_id',
                'rm.is_team_leader',
                'm.id',
                'm.chest_number',
                'm.full_name',
              ])
              .where('rm.registration_id', 'in', teamRegistrationIds)
              .orderBy('rm.is_team_leader', 'desc')
              .orderBy('m.chest_number_numeric')
              .execute()
          : [];

      const teamsByRegistration = new Map<string, typeof teamMembers>();
      for (const tm of teamMembers) {
        const list = teamsByRegistration.get(tm.registration_id) ?? [];
        list.push(tm);
        teamsByRegistration.set(tm.registration_id, list);
      }

      return ok(
        res,
        rows.map((r) => ({
          id: r.id,
          status: r.status,
          itemId: r.item_id,
          itemName: r.item_name,
          itemCode: r.item_code,
          itemType: r.item_type,
          memberId: r.member_id,
          chestNumber: r.chest_number,
          participantName: r.member_name ?? r.team_name,
          teamName: r.team_name,
          teamMembers: teamsByRegistration.get(r.id)?.map((t) => ({
            id: t.id,
            chestNumber: t.chest_number,
            fullName: t.full_name,
            isTeamLeader: t.is_team_leader,
          })) ?? null,
          photoPath: r.photo_path,
          churchId: r.church_id,
          churchName: r.church_name,
          churchShortCode: r.church_short_code,
          categoryName: r.category_name,
          callOrder: r.call_order,
          isLateEntry: r.is_late_entry,
          eligibilityOverrideReason: r.eligibility_override_reason,
          withdrawnReason: r.withdrawn_reason,
        })),
      );
    }),
  );

  /** Register an individual member for an item. */
  router.post(
    '/',
    validate({
      body: z.object({
        itemId: z.string().uuid(),
        memberId: z.string().uuid(),
        eligibilityOverrideReason: z.string().min(10).max(500).optional(),
        callOrder: z.coerce.number().int().min(0).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const input = req.body as {
        itemId: string;
        memberId: string;
        eligibilityOverrideReason?: string;
        callOrder?: number;
      };

      const member = await db
        .selectFrom('members')
        .select(['id', 'church_id'])
        .where('id', '=', input.memberId)
        .where('event_id', '=', req.eventId!)
        .executeTakeFirst();
      if (!member) throw errors.notFound('Member', input.memberId);

      const registration = await createRegistration(
        {
          eventId: req.eventId!,
          itemId: input.itemId,
          memberId: input.memberId,
          churchId: member.church_id,
          eligibilityOverrideReason: input.eligibilityOverrideReason,
          callOrder: input.callOrder ?? null,
        },
        actorFromRequest(req),
        req.auth!.userId,
      );

      return created(res, registration);
    }),
  );

  /** ADM-06-04: register a team for a group item. */
  router.post(
    '/teams',
    validate({
      body: z.object({
        itemId: z.string().uuid(),
        teamName: z.string().min(1).max(200),
        churchId: z.string().uuid(),
        memberIds: z.array(z.string().uuid()).min(1).max(50),
        teamLeaderId: z.string().uuid().optional(),
        callOrder: z.coerce.number().int().min(0).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const input = req.body as {
        itemId: string;
        teamName: string;
        churchId: string;
        memberIds: string[];
        teamLeaderId?: string;
        callOrder?: number;
      };

      const registration = await createTeamRegistration(
        { eventId: req.eventId!, ...input, callOrder: input.callOrder ?? null },
        actorFromRequest(req),
        req.auth!.userId,
      );

      return created(res, registration);
    }),
  );

  /**
   * FSD 9.2: DELETE /api/registrations/{id} — withdraw a registration.
   * ADM-06-05 makes this a state change, never a deletion.
   */
  router.delete(
    '/:id',
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().max(500).optional() }).optional(),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const reason = (req.body as { reason?: string } | undefined)?.reason ?? null;

      const result = await withdrawRegistration(id, reason, actorFromRequest(req), req.auth!.userId);
      return ok(res, result);
    }),
  );

  /**
   * ADM-06-06 implies removal is permitted while no score exists yet — for
   * correcting a mistaken entry, as opposed to withdrawRegistration's DELETE
   * above, which is a recorded decision and stays in the list as WITHDRAWN.
   * A distinct path (rather than overloading DELETE) so the two can never be
   * confused client-side.
   */
  router.post(
    '/:id/purge',
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().min(10).max(500) }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };

      const result = await deleteRegistration(id, reason, actorFromRequest(req), req.auth!.userId);
      return ok(res, result);
    }),
  );

  /**
   * ADM-06-07: "Chest-number call list: for each item the administrator can
   * generate and print the ordered list of participants for the stage announcer,
   * optionally in randomised performance order."
   *
   * Randomisation writes the drawn order back to call_order rather than shuffling
   * on each read. A call sheet that reordered itself between the printed copy and
   * the screen would be worse than useless on stage.
   */
  router.post(
    '/call-order',
    validate({
      body: z.object({
        itemId: z.string().uuid(),
        mode: z.enum(['RANDOM', 'CHEST_NUMBER', 'CHURCH', 'MANUAL']),
        manualOrder: z.array(z.string().uuid()).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const input = req.body as { itemId: string; mode: string; manualOrder?: string[] };

      const registrations = await db
        .selectFrom('registrations as r')
        .leftJoin('members as m', 'm.id', 'r.member_id')
        .innerJoin('churches as c', 'c.id', 'r.church_id')
        .select([
          'r.id',
          'm.chest_number_numeric',
          'm.chest_number',
          'c.name as church_name',
          'r.team_name',
        ])
        .where('r.item_id', '=', input.itemId)
        .where('r.status', '=', 'REGISTERED')
        .execute();

      if (registrations.length === 0) {
        throw errors.notFound('Registrations for this item');
      }

      let ordered: string[];
      switch (input.mode) {
        case 'RANDOM':
          ordered = shuffle(registrations.map((r) => r.id));
          break;
        case 'CHURCH':
          ordered = [...registrations]
            .sort(
              (a, b) =>
                a.church_name.localeCompare(b.church_name) ||
                (a.chest_number_numeric ?? 0) - (b.chest_number_numeric ?? 0),
            )
            .map((r) => r.id);
          break;
        case 'MANUAL': {
          if (!input.manualOrder) throw errors.validation('A manual order must be supplied.');
          const known = new Set(registrations.map((r) => r.id));
          if (input.manualOrder.length !== registrations.length || !input.manualOrder.every((id) => known.has(id))) {
            throw errors.validation(
              'The manual order must list every registration in this item exactly once.',
            );
          }
          ordered = input.manualOrder;
          break;
        }
        default:
          ordered = [...registrations]
            .sort(
              (a, b) =>
                (a.chest_number_numeric ?? 0) - (b.chest_number_numeric ?? 0) ||
                (a.chest_number ?? '').localeCompare(b.chest_number ?? ''),
            )
            .map((r) => r.id);
      }

      await db.transaction().execute(async (trx) => {
        for (const [index, registrationId] of ordered.entries()) {
          await trx
            .updateTable('registrations')
            .set({ call_order: index + 1, updated_by: req.auth!.userId })
            .where('id', '=', registrationId)
            .execute();
        }

        // Performances already created for this item follow the same order, so
        // the live console's "advance to next" matches the printed call sheet.
        for (const [index, registrationId] of ordered.entries()) {
          await trx
            .updateTable('performances')
            .set({ call_order: index + 1, updated_by: req.auth!.userId })
            .where('registration_id', '=', registrationId)
            .execute();
        }

        await writeAudit(
          {
            eventId: req.eventId,
            actor: actorFromRequest(req),
            action: AuditAction.UPDATED,
            entityType: 'item',
            entityId: input.itemId,
            newValue: { callOrderMode: input.mode, participantCount: ordered.length },
            reason: `Call order set (${input.mode}) for the stage announcer (FSD ADM-06-07).`,
          },
          trx,
        );
      });

      return ok(res, { itemId: input.itemId, mode: input.mode, order: ordered });
    }),
  );

  return router;
}

/** Fisher-Yates using crypto randomness, so a draw order cannot be predicted. */
function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    const j = bytes[0]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
