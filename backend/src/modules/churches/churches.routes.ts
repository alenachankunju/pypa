/**
 * Church management (FSD 5.2).
 *
 * Churches are global master data, reusable across events (ADM-15-06), so they
 * are not event-scoped. Their member and registration counts, however, are — the
 * list view reports them for the ACTIVE event.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import {
  AuditAction,
  actorFromRequest,
  auditDiff,
  auditSnapshot,
  writeAudit,
} from '../../services/audit.js';
import { errors } from '../../utils/errors.js';
import { asyncHandler, created, ok, pageParams, paginated } from '../../utils/http.js';
import { churchImportRoutes } from './churchImport.routes.js';

/** ADM-02-02 field set. */
const churchSchema = z.object({
  name: z.string().min(2).max(200),
  shortCode: z
    .string()
    .min(3)
    .max(6)
    .regex(/^[A-Za-z0-9]+$/, 'Use letters and numbers only, 3 to 6 characters.'),
  zone: z.string().max(120).optional().nullable(),
  contactPerson: z.string().max(200).optional().nullable(),
  contactMobile: z.string().max(40).optional().nullable(),
  contactEmail: z.string().email().max(200).optional().nullable(),
  logoPath: z.string().max(500).optional().nullable(),
});

const updateChurchSchema = churchSchema.partial().extend({ isActive: z.boolean().optional() });

export function churchRoutes(): Router {
  const router = Router();

  /**
   * ADM-02-04: "The list view shows member count and registration count per
   * church so the administrator can spot a church that has not yet submitted its
   * entries."
   */
  router.get(
    '/',
    requireCapability(Capability.MANAGE_CHURCHES),
    validate({
      query: z.object({
        search: z.string().max(200).optional(),
        isActive: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().positive().optional(),
        pageSize: z.coerce.number().int().positive().max(200).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const q = req.query as { search?: string; isActive?: string };
      const { page, pageSize, offset } = pageParams(req.query as Record<string, unknown>);
      const eventId = req.eventId ?? null;

      let base = db.selectFrom('churches as c');
      if (q.search) {
        base = base.where((eb) =>
          eb.or([eb('c.name', 'ilike', `%${q.search}%`), eb('c.short_code', 'ilike', `%${q.search}%`)]),
        );
      }
      if (q.isActive) base = base.where('c.is_active', '=', q.isActive === 'true');

      const [rows, total] = await Promise.all([
        base
          .select((eb) => [
            'c.id',
            'c.name',
            'c.short_code',
            'c.zone',
            'c.contact_person',
            'c.contact_mobile',
            'c.contact_email',
            'c.logo_path',
            'c.is_active',
            eventId
              ? eb
                  .selectFrom('members as m')
                  .select((i) => i.fn.countAll<number>().as('n'))
                  .whereRef('m.church_id', '=', 'c.id')
                  .where('m.event_id', '=', eventId)
                  .where('m.is_active', '=', true)
                  .as('member_count')
              : eb.val(0).as('member_count'),
            eventId
              ? eb
                  .selectFrom('registrations as r')
                  .select((i) => i.fn.countAll<number>().as('n'))
                  .whereRef('r.church_id', '=', 'c.id')
                  .where('r.event_id', '=', eventId)
                  .where('r.status', '=', 'REGISTERED')
                  .as('registration_count')
              : eb.val(0).as('registration_count'),
          ])
          .orderBy('c.name')
          .limit(pageSize)
          .offset(offset)
          .execute(),
        base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
      ]);

      return paginated(
        res,
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          shortCode: r.short_code,
          zone: r.zone,
          contactPerson: r.contact_person,
          contactMobile: r.contact_mobile,
          contactEmail: r.contact_email,
          logoPath: r.logo_path,
          isActive: r.is_active,
          memberCount: Number(r.member_count ?? 0),
          registrationCount: Number(r.registration_count ?? 0),
          // ADM-02-04's purpose: surface churches that have not entered anyone.
          hasNoEntries: Number(r.registration_count ?? 0) === 0,
        })),
        page,
        pageSize,
        Number(total.count),
      );
    }),
  );

  router.use('/import', churchImportRoutes());

  router.get(
    '/:id',
    requireCapability(Capability.MANAGE_CHURCHES),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const church = await db.selectFrom('churches').selectAll().where('id', '=', id).executeTakeFirst();
      if (!church) throw errors.notFound('Church', id);
      return ok(res, church);
    }),
  );

  router.post(
    '/',
    requireCapability(Capability.MANAGE_CHURCHES),
    validate({ body: churchSchema }),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof churchSchema>;
      if (!req.auth) throw errors.unauthenticated();

      const church = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('churches')
          .values({
            name: input.name.trim(),
            short_code: input.shortCode.toUpperCase(),
            zone: input.zone ?? null,
            contact_person: input.contactPerson ?? null,
            contact_mobile: input.contactMobile ?? null,
            contact_email: input.contactEmail ?? null,
            logo_path: input.logoPath ?? null,
            created_by: req.auth!.userId,
            updated_by: req.auth!.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          {
            eventId: req.eventId ?? null,
            actor: actorFromRequest(req),
            action: AuditAction.CREATED,
            entityType: 'church',
            entityId: row.id,
            newValue: auditSnapshot(row),
          },
          trx,
        );

        return row;
      });

      return created(res, church);
    }),
  );

  router.patch(
    '/:id',
    requireCapability(Capability.MANAGE_CHURCHES),
    validate({ params: z.object({ id: z.string().uuid() }), body: updateChurchSchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const input = req.body as z.infer<typeof updateChurchSchema>;
      if (!req.auth) throw errors.unauthenticated();

      const before = await db.selectFrom('churches').selectAll().where('id', '=', id).executeTakeFirst();
      if (!before) throw errors.notFound('Church', id);

      const after = await db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable('churches')
          .set({
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.shortCode !== undefined ? { short_code: input.shortCode.toUpperCase() } : {}),
            ...(input.zone !== undefined ? { zone: input.zone } : {}),
            ...(input.contactPerson !== undefined ? { contact_person: input.contactPerson } : {}),
            ...(input.contactMobile !== undefined ? { contact_mobile: input.contactMobile } : {}),
            ...(input.contactEmail !== undefined ? { contact_email: input.contactEmail } : {}),
            ...(input.logoPath !== undefined ? { logo_path: input.logoPath } : {}),
            ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
            updated_by: req.auth!.userId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        const diff = auditDiff(before, row);
        await writeAudit(
          {
            eventId: req.eventId ?? null,
            actor: actorFromRequest(req),
            action:
              input.isActive === false
                ? AuditAction.DEACTIVATED
                : input.isActive === true
                  ? AuditAction.REACTIVATED
                  : AuditAction.UPDATED,
            entityType: 'church',
            entityId: id,
            oldValue: diff.old,
            newValue: diff.new,
          },
          trx,
        );

        return row;
      });

      // FSD 12.2: "A church is deactivated with active members — Deactivation
      // succeeds but the church is hidden from new-member dropdowns; existing
      // members and their results are untouched." The administrator is told so.
      let notice: string | undefined;
      if (input.isActive === false && req.eventId) {
        const { count } = await db
          .selectFrom('members')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('church_id', '=', id)
          .where('event_id', '=', req.eventId)
          .where('is_active', '=', true)
          .executeTakeFirstOrThrow();

        if (Number(count) > 0) {
          notice = `${count} active member(s) remain in this church. They and their results are unaffected; the church is simply hidden from new-member dropdowns (FSD 12.2).`;
        }
      }

      return ok(res, { ...after, ...(notice ? { notice } : {}) });
    }),
  );

  /**
   * ADM-02-03: "A church cannot be deleted if it has members. It can be
   * deactivated."
   *
   * The route exists so the refusal is explicit and well worded. The database
   * trigger churches_delete_guard (migration 0009) is the actual guarantee.
   */
  router.delete(
    '/:id',
    requireCapability(Capability.MANAGE_CHURCHES),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      const church = await db
        .selectFrom('churches')
        .select(['id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!church) throw errors.notFound('Church', id);

      const { count } = await db
        .selectFrom('members')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('church_id', '=', id)
        .executeTakeFirstOrThrow();

      if (Number(count) > 0) {
        throw errors.inUse(
          `"${church.name}" has ${count} member(s) and cannot be deleted (FSD ADM-02-03). Deactivate it instead — its members and results stay intact.`,
          { memberCount: Number(count) },
        );
      }

      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('churches').where('id', '=', id).execute();
        await writeAudit(
          {
            eventId: req.eventId ?? null,
            actor: actorFromRequest(req),
            action: AuditAction.DELETED,
            entityType: 'church',
            entityId: id,
            oldValue: { name: church.name },
          },
          trx,
        );
      });

      return ok(res, { deleted: true });
    }),
  );

  return router;
}
