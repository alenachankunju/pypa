/**
 * Event settings and data safety (FSD 5.15).
 *
 * ADM-15-01 event settings, ADM-15-06 archive and reset, ADM-15-07 freeze mode.
 * Snapshot and restore (ADM-15-02..05) live in the snapshots module.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { requireLiveSession } from '../../middleware/authenticate.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { invalidateEventCache } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { AuditAction, actorFromRequest, writeAudit } from '../../services/audit.js';
import { errors } from '../../utils/errors.js';
import { auditedUpdate, crudContext } from '../../utils/crud.js';
import { asyncHandler, created, ok } from '../../utils/http.js';

/** ADM-15-01 field set. */
const eventSchema = z.object({
  name: z.string().min(2).max(200),
  edition: z.string().max(60).optional().nullable(),
  logoPath: z.string().max(500).optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  /** ADM-03-03: the single event-wide age cut-off. */
  ageCutoffDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().max(60).optional(),
  /** ADM-14-05: months after end_date before audit_logs become purge-eligible. */
  auditRetentionMonths: z.coerce.number().int().min(1).max(240).optional(),
});

/** The frontend reads camelCase everywhere else in the app; this row is no exception. */
function mapEvent(row: {
  id: string;
  name: string;
  edition: string | null;
  logo_path: string | null;
  start_date: unknown;
  end_date: unknown;
  age_cutoff_date: unknown;
  timezone: string;
  status: string;
  freeze_mode: boolean;
  freeze_reason: string | null;
  audit_retention_months: number;
  archived_at: unknown;
}) {
  return {
    id: row.id,
    name: row.name,
    edition: row.edition,
    logoPath: row.logo_path,
    startDate: row.start_date,
    endDate: row.end_date,
    ageCutoffDate: row.age_cutoff_date,
    timezone: row.timezone,
    status: row.status,
    freezeMode: row.freeze_mode,
    freezeReason: row.freeze_reason,
    auditRetentionMonths: row.audit_retention_months,
    archivedAt: row.archived_at,
  };
}

export function eventRoutes(): Router {
  const router = Router();

  router.get(
    '/',
    requireCapability(Capability.VIEW_PROVISIONAL_RESULTS),
    asyncHandler(async (_req, res) => {
      const events = await db
        .selectFrom('events')
        .select([
          'id',
          'name',
          'edition',
          'logo_path',
          'start_date',
          'end_date',
          'age_cutoff_date',
          'timezone',
          'status',
          'freeze_mode',
          'freeze_reason',
          'audit_retention_months',
          'archived_at',
        ])
        .orderBy('created_at', 'desc')
        .execute();

      return ok(res, events.map(mapEvent));
    }),
  );

  /** The active event, plus its setup progress (FSD 13). */
  router.get(
    '/active',
    asyncHandler(async (req, res) => {
      if (!req.eventId) {
        return ok(res, null, {
          message:
            'No active event is configured. A Super Admin must create and activate one before anything else can be done (FSD 13, step 1).',
        });
      }

      const event = await db
        .selectFrom('events')
        .selectAll()
        .where('id', '=', req.eventId)
        .executeTakeFirstOrThrow();

      return ok(res, mapEvent(event));
    }),
  );

  router.post(
    '/',
    requireCapability(Capability.MANAGE_SETTINGS),
    validate({ body: eventSchema.extend({ activate: z.boolean().optional() }) }),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof eventSchema> & { activate?: boolean };

      const event = await db.transaction().execute(async (trx) => {
        // Only one event may be ACTIVE (unique index, migration 0002), so an
        // incoming activation stands the current one down first.
        if (input.activate) {
          await trx
            .updateTable('events')
            .set({ status: 'SETUP', updated_by: req.auth!.userId })
            .where('status', '=', 'ACTIVE')
            .execute();
        }

        const row = await trx
          .insertInto('events')
          .values({
            name: input.name.trim(),
            edition: input.edition ?? null,
            logo_path: input.logoPath ?? null,
            start_date: input.startDate ?? null,
            end_date: input.endDate ?? null,
            age_cutoff_date: input.ageCutoffDate,
            timezone: input.timezone ?? 'Asia/Kolkata',
            status: input.activate ? 'ACTIVE' : 'SETUP',
            created_by: req.auth!.userId,
            updated_by: req.auth!.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        // FSD 18.2 defaults, seeded so an event is usable the moment it exists
        // and step 5 of FSD 13 is a review rather than a blank form.
        await trx
          .insertInto('scoring_config')
          .values({ event_id: row.id, created_by: req.auth!.userId, updated_by: req.auth!.userId })
          .execute();

        await trx
          .insertInto('position_points')
          .values(
            [
              { position: 1, points: 5 },
              { position: 2, points: 3 },
              { position: 3, points: 1 },
            ].map((p) => ({
              event_id: row.id,
              item_id: null,
              position: p.position,
              points: p.points,
              created_by: req.auth!.userId,
              updated_by: req.auth!.userId,
            })),
          )
          .execute();

        await trx
          .insertInto('grade_bands')
          .values(
            [
              { grade: 'A', min: 80, order: 0 },
              { grade: 'B', min: 60, order: 1 },
              { grade: 'C', min: 40, order: 2 },
            ].map((g) => ({
              event_id: row.id,
              grade: g.grade,
              min_percentage: g.min,
              points: 0,
              display_order: g.order,
              created_by: req.auth!.userId,
              updated_by: req.auth!.userId,
            })),
          )
          .execute();

        await writeAudit(
          {
            eventId: row.id,
            actor: actorFromRequest(req),
            action: AuditAction.CREATED,
            entityType: 'event',
            entityId: row.id,
            newValue: { name: row.name, ageCutoffDate: input.ageCutoffDate },
          },
          trx,
        );

        return row;
      });

      invalidateEventCache();
      return created(res, mapEvent(event));
    }),
  );

  router.patch(
    '/:id',
    requireCapability(Capability.MANAGE_SETTINGS),
    validate({ params: z.object({ id: z.string().uuid() }), body: eventSchema.partial() }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const input = req.body as Partial<z.infer<typeof eventSchema>>;

      // ADM-03-03: the cut-off date determines every member's category, so
      // changing it after members exist would silently recategorise the roster.
      if (input.ageCutoffDate) {
        const existing = await db
          .selectFrom('events')
          .select('age_cutoff_date')
          .where('id', '=', id)
          .executeTakeFirst();

        if (existing && String(existing.age_cutoff_date) !== input.ageCutoffDate) {
          const { count } = await db
            .selectFrom('members')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('event_id', '=', id)
            .executeTakeFirstOrThrow();

          if (Number(count) > 0) {
            throw errors.conflict(
              `The age cut-off date determines every member's category (FSD ADM-03-03), and ${count} member(s) already exist. ` +
                'Changing it now would recategorise them silently. Correct the date before entering members, or re-derive each category deliberately.',
              { memberCount: Number(count) },
            );
          }
        }
      }

      const row = await auditedUpdate(
        'events',
        id,
        {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.edition !== undefined ? { edition: input.edition } : {}),
          ...(input.logoPath !== undefined ? { logo_path: input.logoPath } : {}),
          ...(input.startDate !== undefined ? { start_date: input.startDate } : {}),
          ...(input.endDate !== undefined ? { end_date: input.endDate } : {}),
          ...(input.ageCutoffDate !== undefined ? { age_cutoff_date: input.ageCutoffDate } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.auditRetentionMonths !== undefined
            ? { audit_retention_months: input.auditRetentionMonths }
            : {}),
          updated_by: req.auth!.userId,
        },
        crudContext(req, 'event', actorFromRequest(req)),
      );

      invalidateEventCache();
      return ok(res, mapEvent(row as Parameters<typeof mapEvent>[0]));
    }),
  );

  /** Make an event the active one. Exactly one may be active at a time. */
  router.post(
    '/:id/activate',
    requireCapability(Capability.MANAGE_SETTINGS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('events')
          .set({ status: 'SETUP', updated_by: req.auth!.userId })
          .where('status', '=', 'ACTIVE')
          .execute();

        await trx
          .updateTable('events')
          .set({ status: 'ACTIVE', updated_by: req.auth!.userId })
          .where('id', '=', id)
          .execute();

        await writeAudit(
          {
            eventId: id,
            actor: actorFromRequest(req),
            action: AuditAction.UPDATED,
            entityType: 'event',
            entityId: id,
            newValue: { status: 'ACTIVE' },
            reason: 'Event activated.',
          },
          trx,
        );
      });

      invalidateEventCache();
      return ok(res, { activated: true, eventId: id });
    }),
  );

  /**
   * ADM-15-07: "A read-only 'freeze' mode that blocks all data changes once
   * results are final, preventing accidental edits after the event."
   */
  router.post(
    '/:id/freeze',
    requireLiveSession(),
    requireCapability(Capability.MANAGE_SETTINGS),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ frozen: z.boolean(), reason: z.string().max(500).optional() }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const { frozen, reason } = req.body as { frozen: boolean; reason?: string };

      if (frozen && !reason) {
        throw errors.validation('A reason is required when freezing the event, so operators know why edits are blocked.');
      }

      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('events')
          .set({
            freeze_mode: frozen,
            freeze_reason: frozen ? (reason ?? null) : null,
            updated_by: req.auth!.userId,
          })
          .where('id', '=', id)
          .execute();

        await writeAudit(
          {
            eventId: id,
            actor: actorFromRequest(req),
            action: frozen ? AuditAction.FREEZE_ENABLED : AuditAction.FREEZE_DISABLED,
            entityType: 'event',
            entityId: id,
            newValue: { freezeMode: frozen },
            reason: reason ?? null,
          },
          trx,
        );
      });

      invalidateEventCache();

      return ok(res, {
        frozen,
        message: frozen
          ? 'The event is now read-only. No data changes are permitted until the freeze is lifted.'
          : 'Freeze lifted. Data changes are permitted again.',
      });
    }),
  );

  /**
   * ADM-15-06: "Event archive and reset, which closes the current event and
   * starts a new one while retaining churches and judges as reusable master
   * data."
   *
   * Nothing is copied and nothing is deleted: churches and users are already
   * global (migrations 0002, 0003), so archiving the old event and activating a
   * new one is the whole operation. That is why the schema scopes categories,
   * items and members to an event but not churches or users.
   */
  router.post(
    '/:id/archive',
    requireLiveSession(),
    requireCapability(Capability.MANAGE_SETTINGS),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().min(10).max(500), confirm: z.boolean() }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const { reason, confirm } = req.body as { reason: string; confirm: boolean };

      if (!confirm) {
        const counts = await eventCounts(id);
        return ok(res, {
          dryRun: true,
          willArchive: counts,
          confirmationRequired: 'confirm',
          note: 'Churches and user accounts are global and are retained for reuse in the next event (FSD ADM-15-06).',
        });
      }

      const unpublished = await db
        .selectFrom('v_item_readiness')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('event_id', '=', id)
        .where('item_status', '=', 'ACTIVE')
        .where('publication_state', '!=', 'PUBLISHED')
        .executeTakeFirstOrThrow();

      if (Number(unpublished.count) > 0) {
        throw errors.conflict(
          `${unpublished.count} item(s) are not yet published. Archiving now would freeze the event with results outstanding. Publish or withhold them first.`,
          { unpublishedCount: Number(unpublished.count) },
        );
      }

      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('events')
          .set({
            status: 'ARCHIVED',
            archived_at: new Date(),
            freeze_mode: true,
            freeze_reason: 'Event archived.',
            updated_by: req.auth!.userId,
          })
          .where('id', '=', id)
          .execute();

        await writeAudit(
          {
            eventId: id,
            actor: actorFromRequest(req),
            action: AuditAction.EVENT_ARCHIVED,
            entityType: 'event',
            entityId: id,
            newValue: { status: 'ARCHIVED' },
            reason,
          },
          trx,
        );
      });

      invalidateEventCache();

      return ok(res, {
        archived: true,
        message:
          'Event archived and frozen. Churches and user accounts remain available for the next event (FSD ADM-15-06).',
      });
    }),
  );

  return router;
}

async function eventCounts(eventId: string) {
  const [members, items, registrations, scores] = await Promise.all([
    db.selectFrom('members').select((eb) => eb.fn.countAll<number>().as('c')).where('event_id', '=', eventId).executeTakeFirstOrThrow(),
    db.selectFrom('items').select((eb) => eb.fn.countAll<number>().as('c')).where('event_id', '=', eventId).executeTakeFirstOrThrow(),
    db.selectFrom('registrations').select((eb) => eb.fn.countAll<number>().as('c')).where('event_id', '=', eventId).executeTakeFirstOrThrow(),
    db
      .selectFrom('scores as s')
      .innerJoin('performances as p', 'p.id', 's.performance_id')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('p.event_id', '=', eventId)
      .executeTakeFirstOrThrow(),
  ]);

  return {
    members: Number(members.c),
    items: Number(items.c),
    registrations: Number(registrations.c),
    scores: Number(scores.c),
  };
}
