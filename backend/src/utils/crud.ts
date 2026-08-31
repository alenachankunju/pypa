/**
 * Audited create / update / deactivate helpers.
 *
 * Every state-changing action must reach audit_logs (ADM-14-01), and every
 * change must commit together with its audit entry. Repeating that transaction
 * in a dozen modules invites the one place where somebody forgets, so it is
 * written once here.
 *
 * Business rules stay in the modules. This file only owns the mechanics:
 * transaction, write, diff, audit.
 */
import type { Insertable, Updateable } from 'kysely';
import { db } from '../db/pool.js';
import type { Database } from '../db/schema.js';
import {
  AuditAction,
  auditDiff,
  auditSnapshot,
  writeAudit,
  type AuditActionValue,
  type AuditActor,
} from '../services/audit.js';
import { errors } from './errors.js';

/** Tables this helper may operate on: those with an `id` primary key. */
type AuditableTable = keyof Database & string;

export interface CrudContext {
  actor: AuditActor;
  eventId?: string | null;
  entityType: string;
  userId: string;
}

/** Insert a row and record its creation. */
export async function auditedInsert<T extends AuditableTable>(
  table: T,
  values: Insertable<Database[T]>,
  ctx: CrudContext,
): Promise<Record<string, unknown>> {
  return db.transaction().execute(async (trx) => {
    const row = (await trx
      .insertInto(table)
      .values(values as never)
      .returningAll()
      .executeTakeFirstOrThrow()) as Record<string, unknown>;

    await writeAudit(
      {
        eventId: ctx.eventId ?? null,
        actor: ctx.actor,
        action: AuditAction.CREATED,
        entityType: ctx.entityType,
        entityId: String(row.id ?? ''),
        newValue: auditSnapshot(row),
      },
      trx,
    );

    return row;
  });
}

export interface AuditedUpdateOptions {
  /** Overrides the default CREATED/UPDATED/DEACTIVATED inference. */
  action?: AuditActionValue;
  /** Mandatory justification, where the FSD requires one. */
  reason?: string | null;
  /** Runs inside the transaction after the update, before the audit write. */
  afterUpdate?: (row: Record<string, unknown>, trx: Parameters<typeof writeAudit>[1]) => Promise<void>;
}

/**
 * Update a row and record the diff.
 *
 * Only the fields that actually changed reach old_value / new_value, which keeps
 * the trail readable during a dispute (ADM-14-04).
 */
export async function auditedUpdate<T extends AuditableTable>(
  table: T,
  id: string,
  values: Updateable<Database[T]>,
  ctx: CrudContext,
  options: AuditedUpdateOptions = {},
): Promise<Record<string, unknown>> {
  return db.transaction().execute(async (trx) => {
    const before = (await trx
      .selectFrom(table)
      .selectAll()
      .where('id' as never, '=', id as never)
      .executeTakeFirst()) as Record<string, unknown> | undefined;

    if (!before) throw errors.notFound(ctx.entityType, id);

    const after = (await trx
      .updateTable(table)
      .set(values as never)
      .where('id' as never, '=', id as never)
      .returningAll()
      .executeTakeFirstOrThrow()) as Record<string, unknown>;

    if (options.afterUpdate) await options.afterUpdate(after, trx);

    const diff = auditDiff(before, after);

    // Nothing changed — skip the audit write rather than recording an empty
    // diff. A trail full of no-op entries is harder to search, not safer.
    if (Object.keys(diff.new).length === 0 && !options.reason) return after;

    const inferredAction =
      'is_active' in values
        ? values.is_active === false
          ? AuditAction.DEACTIVATED
          : AuditAction.REACTIVATED
        : AuditAction.UPDATED;

    await writeAudit(
      {
        eventId: ctx.eventId ?? null,
        actor: ctx.actor,
        action: options.action ?? inferredAction,
        entityType: ctx.entityType,
        entityId: id,
        oldValue: diff.old,
        newValue: diff.new,
        reason: options.reason ?? null,
      },
      trx,
    );

    return after;
  });
}

/**
 * Delete a row and record it.
 *
 * Reserved for entities the FSD genuinely permits deleting. Users, members,
 * churches with members, items with performances and registrations with scores
 * are all protected by triggers in migration 0009 and are deactivated or
 * withdrawn instead.
 */
export async function auditedDelete<T extends AuditableTable>(
  table: T,
  id: string,
  ctx: CrudContext,
  reason?: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = (await trx
      .selectFrom(table)
      .selectAll()
      .where('id' as never, '=', id as never)
      .executeTakeFirst()) as Record<string, unknown> | undefined;

    if (!before) throw errors.notFound(ctx.entityType, id);

    await trx
      .deleteFrom(table)
      .where('id' as never, '=', id as never)
      .execute();

    await writeAudit(
      {
        eventId: ctx.eventId ?? null,
        actor: ctx.actor,
        action: AuditAction.DELETED,
        entityType: ctx.entityType,
        entityId: id,
        oldValue: auditSnapshot(before),
        reason: reason ?? null,
      },
      trx,
    );
  });
}

/** Build a CrudContext from a request. */
export function crudContext(
  req: { auth?: Express.AuthenticatedUser; eventId?: string },
  entityType: string,
  actor: AuditActor,
): CrudContext {
  if (!req.auth) throw errors.unauthenticated();
  return { actor, eventId: req.eventId ?? null, entityType, userId: req.auth.userId };
}
