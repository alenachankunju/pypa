/**
 * The result publication lifecycle (FSD 4.8, 5.12).
 *
 * "Results move through defined states. This prevents the common failure mode of
 * a number being announced and then quietly changing."
 *
 *   IN_PROGRESS -> READY -> PROVISIONAL -> PUBLISHED
 *                                       -> WITHHELD (frozen pending dispute)
 *
 * IN_PROGRESS and READY are computed states, set by the result engine. The three
 * beyond them are human decisions and live in this module.
 */
import type { Executor } from '../../db/pool.js';
import { db } from '../../db/pool.js';
import type { ItemResultState } from '../../db/schema.js';
import { errors } from '../../utils/errors.js';
import { AuditAction, writeAudit, type AuditActor } from '../audit.js';
import { computeItemResult } from './itemResults.js';

/** ADM-12-05 / ADM-10-01 style reasons must be substantive, not a keystroke. */
const MIN_REASON_LENGTH = 15;

export interface PublicationChange {
  itemId: string;
  itemName: string;
  from: ItemResultState;
  to: ItemResultState;
}

/**
 * Move an item to PROVISIONAL (FSD 4.8: "Admin has reviewed and resolved any
 * ties; awaiting sign-off").
 *
 * ADM-12-02: "Any item containing an unresolved tie is clearly flagged and
 * cannot progress to Provisional until resolved."
 */
export async function markProvisional(
  itemId: string,
  eventId: string,
  actor: AuditActor,
): Promise<PublicationChange> {
  return db.transaction().execute(async (trx) => {
    const current = await loadPublication(itemId, trx);

    if (current.state === 'PUBLISHED') {
      throw errors.resultPublished(current.itemName);
    }

    // Recompute first, so the tie flag reflects the present state of the data
    // rather than whatever it was when the item was last touched.
    const computed = await computeItemResult(itemId, eventId, { actorId: actor.id }, trx);

    if (computed.state === 'IN_PROGRESS') {
      throw errors.conflict(
        `"${current.itemName}" still has performances that are not complete. ` +
          'Every performance must be COMPLETE, ABSENT, VOID or WITHDRAWN first (FSD 7.4).',
        { pending: computed.pending },
      );
    }

    if (computed.unresolvedTies.length > 0) {
      throw errors.tieUnresolved({
        itemId,
        itemName: current.itemName,
        ties: computed.unresolvedTies,
      });
    }

    await trx
      .updateTable('item_publications')
      .set({ state: 'PROVISIONAL', updated_by: actor.id })
      .where('item_id', '=', itemId)
      .execute();

    await writeAudit(
      {
        eventId,
        actor,
        action: AuditAction.RESULT_COMPUTED,
        entityType: 'item_publication',
        entityId: itemId,
        oldValue: { state: current.state },
        newValue: { state: 'PROVISIONAL' },
      },
      trx,
    );

    return { itemId, itemName: current.itemName, from: current.state, to: 'PROVISIONAL' };
  });
}

/**
 * Publish an item result (ADM-12-03). Super Admin only — enforced at the route.
 *
 * "Publication timestamps the result and locks it."
 *
 * Publishing also locks the scoring configuration (ADM-11-09): "Scoring
 * configuration is locked once the first result is published."
 */
export async function publishItem(
  itemId: string,
  eventId: string,
  actor: AuditActor,
): Promise<PublicationChange> {
  return db.transaction().execute(async (trx) => {
    const current = await loadPublication(itemId, trx);

    if (current.state === 'PUBLISHED') {
      throw errors.conflict(`"${current.itemName}" is already published.`);
    }

    const computed = await computeItemResult(itemId, eventId, { actorId: actor.id }, trx);

    if (computed.state === 'IN_PROGRESS') {
      throw errors.conflict(
        `"${current.itemName}" cannot be published: some performances are still awaiting marks.`,
        { pending: computed.pending },
      );
    }

    // ADM-12-02 / FSD 9.4 TIE_UNRESOLVED — "Item cannot be published until the
    // tie is decided."
    if (computed.unresolvedTies.length > 0) {
      throw errors.tieUnresolved({
        itemId,
        itemName: current.itemName,
        ties: computed.unresolvedTies,
      });
    }

    const now = new Date();

    await trx
      .updateTable('item_publications')
      .set({
        state: 'PUBLISHED',
        published_by: actor.id,
        published_at: now,
        unpublish_reason: null,
        updated_by: actor.id,
      })
      .where('item_id', '=', itemId)
      .execute();

    await lockScoringConfig(eventId, actor, trx);

    await writeAudit(
      {
        eventId,
        actor,
        action: AuditAction.RESULT_PUBLISHED,
        entityType: 'item_publication',
        entityId: itemId,
        oldValue: { state: current.state },
        newValue: { state: 'PUBLISHED', publishedAt: now.toISOString() },
      },
      trx,
    );

    return { itemId, itemName: current.itemName, from: current.state, to: 'PUBLISHED' };
  });
}

/**
 * ADM-12-04: "Bulk publish all Ready items, with a summary confirmation listing
 * what will be published."
 *
 * @param dryRun When true, returns what WOULD be published without writing —
 *               this is the summary the confirmation dialog shows.
 */
export async function publishAllReady(
  eventId: string,
  actor: AuditActor,
  options: { dryRun?: boolean } = {},
): Promise<{ published: PublicationChange[]; blocked: { itemId: string; itemName: string; reason: string }[] }> {
  const candidates = await db
    .selectFrom('v_item_readiness')
    .select(['item_id', 'item_name', 'publication_state', 'has_unresolved_tie', 'is_ready', 'pending_count'])
    .where('event_id', '=', eventId)
    .where('publication_state', 'in', ['READY', 'PROVISIONAL'])
    .orderBy('item_name')
    .execute();

  const published: PublicationChange[] = [];
  const blocked: { itemId: string; itemName: string; reason: string }[] = [];

  for (const candidate of candidates) {
    if (!candidate.is_ready) {
      blocked.push({
        itemId: candidate.item_id,
        itemName: candidate.item_name,
        reason: `${candidate.pending_count} performance(s) still awaiting marks.`,
      });
      continue;
    }
    if (candidate.has_unresolved_tie) {
      blocked.push({
        itemId: candidate.item_id,
        itemName: candidate.item_name,
        reason: 'An unresolved tie requires an administrator decision (FSD 4.5).',
      });
      continue;
    }

    if (options.dryRun) {
      published.push({
        itemId: candidate.item_id,
        itemName: candidate.item_name,
        from: candidate.publication_state,
        to: 'PUBLISHED',
      });
      continue;
    }

    try {
      published.push(await publishItem(candidate.item_id, eventId, actor));
    } catch (error) {
      blocked.push({
        itemId: candidate.item_id,
        itemName: candidate.item_name,
        reason: error instanceof Error ? error.message : 'Unknown error.',
      });
    }
  }

  return { published, blocked };
}

/**
 * ADM-12-05: "Unpublish with a mandatory reason, which triggers recomputation of
 * church totals."
 *
 * FSD 4.8: "Once an item is Published, it can only be changed by a Super Admin
 * performing an explicit 'unpublish and correct' action, which is recorded in
 * the audit log and forces recomputation of all downstream totals."
 *
 * The recomputation itself is a consequence rather than a step here: church and
 * championship totals are derived from PUBLISHED items by the standings views,
 * so removing this item from that set is what recalculates them. The caller
 * records a recompute run for the change report (FSD 7.7).
 */
export async function unpublishItem(
  itemId: string,
  eventId: string,
  reason: string,
  actor: AuditActor,
): Promise<PublicationChange> {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_LENGTH) {
    throw errors.validation(
      `A reason of at least ${MIN_REASON_LENGTH} characters is required to unpublish a result. ` +
        'It appears in the exceptions report and on the change report (FSD ADM-10-04, 7.7).',
      { minLength: MIN_REASON_LENGTH, provided: trimmed.length },
    );
  }

  return db.transaction().execute(async (trx) => {
    const current = await loadPublication(itemId, trx);

    if (current.state !== 'PUBLISHED') {
      throw errors.conflict(`"${current.itemName}" is not published, so it cannot be unpublished.`);
    }

    await trx
      .updateTable('item_publications')
      .set({
        state: 'PROVISIONAL',
        unpublished_by: actor.id,
        unpublished_at: new Date(),
        unpublish_reason: trimmed,
        updated_by: actor.id,
      })
      .where('item_id', '=', itemId)
      .execute();

    await writeAudit(
      {
        eventId,
        actor,
        action: AuditAction.RESULT_UNPUBLISHED,
        entityType: 'item_publication',
        entityId: itemId,
        oldValue: { state: 'PUBLISHED' },
        newValue: { state: 'PROVISIONAL' },
        reason: trimmed,
      },
      trx,
    );

    return { itemId, itemName: current.itemName, from: 'PUBLISHED', to: 'PROVISIONAL' };
  });
}

/**
 * FSD 4.8 WITHHELD: "Result frozen pending a dispute or investigation. Admin
 * only; item excluded from totals with a visible warning."
 */
export async function withholdItem(
  itemId: string,
  eventId: string,
  reason: string,
  actor: AuditActor,
): Promise<PublicationChange> {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_LENGTH) {
    throw errors.validation(
      `A reason of at least ${MIN_REASON_LENGTH} characters is required to withhold a result.`,
    );
  }

  return db.transaction().execute(async (trx) => {
    const current = await loadPublication(itemId, trx);

    await trx
      .updateTable('item_publications')
      .set({ state: 'WITHHELD', withheld_reason: trimmed, updated_by: actor.id })
      .where('item_id', '=', itemId)
      .execute();

    await writeAudit(
      {
        eventId,
        actor,
        action: AuditAction.RESULT_WITHHELD,
        entityType: 'item_publication',
        entityId: itemId,
        oldValue: { state: current.state },
        newValue: { state: 'WITHHELD' },
        reason: trimmed,
      },
      trx,
    );

    return { itemId, itemName: current.itemName, from: current.state, to: 'WITHHELD' };
  });
}

/**
 * Record an administrator's decision on a tie the sequence could not break
 * (FSD 4.5.5, ADM-12-02, API POST /results/items/{id}/resolve-tie).
 *
 * "requires the administrator to either declare a shared position or break the
 * tie manually with a recorded justification."
 *
 * A previous decision for the same performance is superseded rather than
 * overwritten, so the trail shows every decision that was ever made.
 */
export interface TieDecisionInput {
  performanceId: string;
  assignedPosition: number;
  declaredShared: boolean;
}

export async function resolveTie(
  itemId: string,
  eventId: string,
  decisions: TieDecisionInput[],
  reason: string,
  actor: AuditActor,
): Promise<{ itemId: string; decisions: number; unresolvedRemaining: number }> {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_LENGTH) {
    throw errors.validation(
      `A justification of at least ${MIN_REASON_LENGTH} characters is required. ` +
        'It is printed on the result sheet and in the exceptions report (FSD 4.5, ADM-10-04).',
    );
  }
  if (decisions.length === 0) {
    throw errors.validation('At least one tie decision is required.');
  }
  if (!actor.id) {
    throw errors.unauthenticated();
  }

  return db.transaction().execute(async (trx) => {
    const current = await loadPublication(itemId, trx);
    if (current.state === 'PUBLISHED') {
      throw errors.resultPublished(current.itemName);
    }

    // Confirm every named performance really belongs to this item, so a crafted
    // request cannot move a position in a different item.
    const valid = await trx
      .selectFrom('performances')
      .select('id')
      .where('item_id', '=', itemId)
      .where(
        'id',
        'in',
        decisions.map((d) => d.performanceId),
      )
      .execute();

    if (valid.length !== decisions.length) {
      throw errors.validation('One or more performances do not belong to this item.');
    }

    await trx
      .updateTable('manual_tie_decisions')
      .set({ superseded_at: new Date() })
      .where('item_id', '=', itemId)
      .where('superseded_at', 'is', null)
      .where(
        'performance_id',
        'in',
        decisions.map((d) => d.performanceId),
      )
      .execute();

    await trx
      .insertInto('manual_tie_decisions')
      .values(
        decisions.map((d) => ({
          event_id: eventId,
          item_id: itemId,
          performance_id: d.performanceId,
          assigned_position: d.assignedPosition,
          declared_shared: d.declaredShared,
          reason: trimmed,
          decided_by: actor.id!,
        })),
      )
      .execute();

    // Recompute so the decision takes effect and the tie flag clears.
    const computed = await computeItemResult(itemId, eventId, { actorId: actor.id }, trx);

    await writeAudit(
      {
        eventId,
        actor,
        action: AuditAction.TIE_RESOLVED,
        entityType: 'item',
        entityId: itemId,
        newValue: { decisions },
        reason: trimmed,
      },
      trx,
    );

    return {
      itemId,
      decisions: decisions.length,
      unresolvedRemaining: computed.unresolvedTies.length,
    };
  });
}

/**
 * ADM-11-09: lock the scoring configuration on first publication.
 *
 * Idempotent — publishing the twentieth item simply finds it already locked.
 */
async function lockScoringConfig(
  eventId: string,
  actor: AuditActor,
  executor: Executor,
): Promise<void> {
  const config = await executor
    .selectFrom('scoring_config')
    .select(['id', 'locked'])
    .where('event_id', '=', eventId)
    .executeTakeFirst();

  if (!config || config.locked) return;

  await executor
    .updateTable('scoring_config')
    .set({ locked: true, locked_at: new Date(), locked_by: actor.id, updated_by: actor.id })
    .where('id', '=', config.id)
    .execute();

  await writeAudit(
    {
      eventId,
      actor,
      action: AuditAction.CONFIG_LOCKED,
      entityType: 'scoring_config',
      entityId: config.id,
      newValue: { locked: true },
      reason: 'Locked automatically on first result publication (FSD ADM-11-09).',
    },
    executor,
  );
}

async function loadPublication(
  itemId: string,
  executor: Executor,
): Promise<{ state: ItemResultState; itemName: string }> {
  const row = await executor
    .selectFrom('items as i')
    .leftJoin('item_publications as ip', 'ip.item_id', 'i.id')
    .select(['i.name as item_name', 'ip.state'])
    .where('i.id', '=', itemId)
    .executeTakeFirst();

  if (!row) throw errors.notFound('Item', itemId);

  return { state: row.state ?? 'IN_PROGRESS', itemName: row.item_name };
}

/**
 * ADM-12-09: "Every result screen shows the count of items still unpublished, so
 * nobody announces a champion while items remain outstanding."
 */
export async function publicationSummary(eventId: string): Promise<{
  total: number;
  published: number;
  provisional: number;
  ready: number;
  inProgress: number;
  withheld: number;
  unpublished: number;
  withUnresolvedTies: number;
}> {
  const rows = await db
    .selectFrom('v_item_readiness')
    .select(['publication_state', 'has_unresolved_tie'])
    .where('event_id', '=', eventId)
    .where('item_status', '=', 'ACTIVE')
    .execute();

  const count = (state: ItemResultState) => rows.filter((r) => r.publication_state === state).length;

  const published = count('PUBLISHED');

  return {
    total: rows.length,
    published,
    provisional: count('PROVISIONAL'),
    ready: count('READY'),
    inProgress: count('IN_PROGRESS'),
    withheld: count('WITHHELD'),
    unpublished: rows.length - published,
    withUnresolvedTies: rows.filter((r) => r.has_unresolved_tie).length,
  };
}
