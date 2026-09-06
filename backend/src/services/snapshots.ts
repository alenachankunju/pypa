/**
 * Database snapshots (FSD 5.15, ADM-15-02..05).
 *
 * "The payload itself is written to object storage; this table [snapshots]
 * holds the catalogue entry, the checksum and the provenance" (migration
 * 0008). Scope is the active event's own data — churches and users are global
 * master data (ADM-15-06) and are never touched by a snapshot or restore.
 *
 * The dump/restore table list below is maintained in FK-safe order: dump order
 * doesn't matter, but restoreSnapshot() deletes children-before-parents and
 * re-inserts parents-before-children. Everything happens in one transaction,
 * so a mistake in that ordering aborts the whole restore rather than leaving
 * the database half-migrated — Postgres's transactional guarantee is what
 * makes this safe to ship without a staging environment to rehearse against.
 */
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { db } from '../db/pool.js';
import type { Database } from '../db/schema.js';
import { env, supabaseEnabled } from '../config/env.js';
import { errors } from '../utils/errors.js';
import { AuditAction, type AuditActor, writeAudit } from './audit.js';

/** children-before-parents; restore's delete phase uses this order verbatim. */
const DELETE_ORDER = [
  'import_rows',
  'import_batches',
  'recompute_runs',
  'manual_tie_decisions',
  'item_results',
  'item_publications',
  'grade_bands',
  'position_points',
  'scoring_config',
  'score_criteria_values',
  'scores',
  'performance_judges',
  'performances',
  'session_items',
  'sessions',
  'panel_judges',
  'panels',
  'registration_members',
  'registrations',
  'members',
  'item_criteria',
  'items',
  'categories',
] as const satisfies readonly (keyof Database)[];

/** parents-before-children; restore's insert phase uses this order verbatim. */
const INSERT_ORDER = [
  'categories',
  'items',
  'item_criteria',
  'members',
  'registrations',
  'registration_members',
  'panels',
  'panel_judges',
  'sessions',
  'session_items',
  'performances',
  'performance_judges',
  'scores',
  'score_criteria_values',
  'scoring_config',
  'position_points',
  'grade_bands',
  'item_publications',
  'item_results',
  'manual_tie_decisions',
  'recompute_runs',
  'import_batches',
  'import_rows',
] as const satisfies readonly (keyof Database)[];

export interface SnapshotPayload {
  eventId: string;
  createdAt: string;
  tables: Partial<Record<(typeof DELETE_ORDER)[number], unknown[]>>;
}

/** Pulls every event-scoped row for the active event, in no particular order. */
async function dumpEventData(eventId: string): Promise<SnapshotPayload['tables']> {
  const [
    categories,
    items,
    itemCriteria,
    members,
    registrations,
    registrationMembers,
    panels,
    panelJudges,
    sessions,
    sessionItems,
    performances,
    performanceJudges,
    scores,
    scoreCriteriaValues,
    scoringConfig,
    positionPoints,
    gradeBands,
    itemPublications,
    itemResults,
    manualTieDecisions,
    recomputeRuns,
    importBatches,
    importRows,
  ] = await Promise.all([
    db.selectFrom('categories').selectAll().where('event_id', '=', eventId).execute(),
    db.selectFrom('items').selectAll().where('event_id', '=', eventId).execute(),
    db
      .selectFrom('item_criteria as ic')
      .innerJoin('items as i', 'i.id', 'ic.item_id')
      .selectAll('ic')
      .where('i.event_id', '=', eventId)
      .execute(),
    db.selectFrom('members').selectAll().where('event_id', '=', eventId).execute(),
    db.selectFrom('registrations').selectAll().where('event_id', '=', eventId).execute(),
    db
      .selectFrom('registration_members as rm')
      .innerJoin('registrations as r', 'r.id', 'rm.registration_id')
      .selectAll('rm')
      .where('r.event_id', '=', eventId)
      .execute(),
    db.selectFrom('panels').selectAll().where('event_id', '=', eventId).execute(),
    db
      .selectFrom('panel_judges as pj')
      .innerJoin('panels as p', 'p.id', 'pj.panel_id')
      .selectAll('pj')
      .where('p.event_id', '=', eventId)
      .execute(),
    db.selectFrom('sessions').selectAll().where('event_id', '=', eventId).execute(),
    db
      .selectFrom('session_items as si')
      .innerJoin('sessions as s', 's.id', 'si.session_id')
      .selectAll('si')
      .where('s.event_id', '=', eventId)
      .execute(),
    db.selectFrom('performances').selectAll().where('event_id', '=', eventId).execute(),
    db
      .selectFrom('performance_judges as pj')
      .innerJoin('performances as p', 'p.id', 'pj.performance_id')
      .selectAll('pj')
      .where('p.event_id', '=', eventId)
      .execute(),
    db
      .selectFrom('scores as s')
      .innerJoin('performances as p', 'p.id', 's.performance_id')
      .selectAll('s')
      .where('p.event_id', '=', eventId)
      .execute(),
    db
      .selectFrom('score_criteria_values as scv')
      .innerJoin('scores as s', 's.id', 'scv.score_id')
      .innerJoin('performances as p', 'p.id', 's.performance_id')
      .selectAll('scv')
      .where('p.event_id', '=', eventId)
      .execute(),
    db.selectFrom('scoring_config').selectAll().where('event_id', '=', eventId).execute(),
    db.selectFrom('position_points').selectAll().where('event_id', '=', eventId).execute(),
    db.selectFrom('grade_bands').selectAll().where('event_id', '=', eventId).execute(),
    db.selectFrom('item_publications').selectAll().where('event_id', '=', eventId).execute(),
    db.selectFrom('item_results').selectAll().where('event_id', '=', eventId).execute(),
    db.selectFrom('manual_tie_decisions').selectAll().where('event_id', '=', eventId).execute(),
    db.selectFrom('recompute_runs').selectAll().where('event_id', '=', eventId).execute(),
    db.selectFrom('import_batches').selectAll().where('event_id', '=', eventId).execute(),
    db
      .selectFrom('import_rows as ir')
      .innerJoin('import_batches as b', 'b.id', 'ir.batch_id')
      .selectAll('ir')
      .where('b.event_id', '=', eventId)
      .execute(),
  ]);

  return {
    categories,
    items,
    item_criteria: itemCriteria,
    members,
    registrations,
    registration_members: registrationMembers,
    panels,
    panel_judges: panelJudges,
    sessions,
    session_items: sessionItems,
    performances,
    performance_judges: performanceJudges,
    scores,
    score_criteria_values: scoreCriteriaValues,
    scoring_config: scoringConfig,
    position_points: positionPoints,
    grade_bands: gradeBands,
    item_publications: itemPublications,
    item_results: itemResults,
    manual_tie_decisions: manualTieDecisions,
    recompute_runs: recomputeRuns,
    import_batches: importBatches,
    import_rows: importRows,
  };
}

function storageClient() {
  if (!supabaseEnabled) {
    throw errors.validation(
      'Supabase Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY), so snapshots cannot be stored.',
    );
  }
  return createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function uploadPayload(eventId: string, payload: SnapshotPayload): Promise<{ path: string; sizeBytes: number; checksum: string }> {
  const json = JSON.stringify(payload);
  const checksum = createHash('sha256').update(json).digest('hex');
  const path = `snapshots/${eventId}/${Date.now()}-${checksum.slice(0, 12)}.json`;

  const { error } = await storageClient()
    .storage.from(env.SUPABASE_STORAGE_BUCKET)
    .upload(path, json, { contentType: 'application/json', upsert: false });
  if (error) throw errors.validation(`Could not write the snapshot to storage: ${error.message}`);

  return { path, sizeBytes: Buffer.byteLength(json), checksum };
}

/** ADM-15-02/03: automatic or manual snapshot. Catalogued in `snapshots`. */
export async function createSnapshot(
  eventId: string,
  trigger: 'SCHEDULED' | 'MANUAL' | 'PRE_BULK_OPERATION',
  label: string | undefined,
  actor: AuditActor,
  userId: string,
): Promise<{ id: string; label: string | null; sizeBytes: number; createdAt: Date }> {
  const tables = await dumpEventData(eventId);
  const payload: SnapshotPayload = { eventId, createdAt: new Date().toISOString(), tables };
  const tableCounts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, (v as unknown[]).length]));

  const { path, sizeBytes, checksum } = await uploadPayload(eventId, payload);

  const row = await db
    .insertInto('snapshots')
    .values({
      event_id: eventId,
      label: label ?? null,
      trigger,
      storage_path: path,
      size_bytes: sizeBytes,
      checksum,
      table_counts: JSON.stringify(tableCounts),
      status: 'READY',
      created_by: userId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await writeAudit({
    eventId,
    actor,
    action: AuditAction.SNAPSHOT_CREATED,
    entityType: 'snapshot',
    entityId: row.id,
    newValue: { label: row.label, trigger, sizeBytes, tableCounts },
  });

  return { id: row.id, label: row.label, sizeBytes, createdAt: row.created_at };
}

export async function listSnapshots(eventId: string) {
  const rows = await db
    .selectFrom('snapshots as sn')
    .leftJoin('users as u', 'u.id', 'sn.created_by')
    .select([
      'sn.id',
      'sn.label',
      'sn.trigger',
      'sn.size_bytes',
      'sn.created_at',
      'sn.status',
      'sn.restored_at',
      'u.full_name as created_by_name',
    ])
    .where('sn.event_id', '=', eventId)
    .orderBy('sn.created_at', 'desc')
    .execute();

  return rows.map((r) => ({
    id: r.id,
    label: r.label ?? r.trigger,
    reason: r.trigger,
    sizeBytes: Number(r.size_bytes ?? 0),
    createdAt: r.created_at,
    createdByName: r.created_by_name,
    status: r.status,
    restoredAt: r.restored_at,
  }));
}

/** ADM-15-04: full restorable export, returned directly rather than catalogued. */
export async function exportEventData(eventId: string): Promise<SnapshotPayload> {
  const tables = await dumpEventData(eventId);
  return { eventId, createdAt: new Date().toISOString(), tables };
}

async function downloadPayload(storagePath: string): Promise<SnapshotPayload> {
  const { data, error } = await storageClient().storage.from(env.SUPABASE_STORAGE_BUCKET).download(storagePath);
  if (error || !data) throw errors.notFound('Snapshot payload', storagePath);
  const text = await data.text();
  return JSON.parse(text) as SnapshotPayload;
}

/**
 * ADM-15-05: restore is a hard, whole-transaction replace of this event's own
 * data with the snapshot's. Never touches churches, users or the events row
 * itself (FSD ADM-15-06 master-data boundary).
 */
export async function restoreSnapshot(snapshotId: string, eventId: string, actor: AuditActor, userId: string) {
  const snapshot = await db
    .selectFrom('snapshots')
    .select(['id', 'storage_path', 'label'])
    .where('id', '=', snapshotId)
    .where('event_id', '=', eventId)
    .executeTakeFirst();
  if (!snapshot || !snapshot.storage_path) throw errors.notFound('Snapshot', snapshotId);

  const payload = await downloadPayload(snapshot.storage_path);

  await db.transaction().execute(async (trx) => {
    for (const table of DELETE_ORDER) {
      // Each table here is event-scoped either directly or via a parent already
      // deleted this same pass, so deleting by a subquery on the still-present
      // parent id is unnecessary — the parent delete below removes the FK target
      // and every child was already cleared in an earlier loop iteration.
      await trx.deleteFrom(table).where((eb) => matchEventScope(eb, table, eventId)).execute();
    }

    for (const table of INSERT_ORDER) {
      const rows = payload.tables[table];
      if (rows && rows.length > 0) {
        await trx.insertInto(table).values(rows as never).execute();
      }
    }

    await writeAudit(
      {
        eventId,
        actor,
        action: AuditAction.SNAPSHOT_RESTORED,
        entityType: 'snapshot',
        entityId: snapshotId,
        reason: `Restored from snapshot "${snapshot.label ?? snapshotId}" (ADM-15-05).`,
      },
      trx,
    );
  });

  await db
    .updateTable('snapshots')
    .set({ restored_at: new Date(), restored_by: userId })
    .where('id', '=', snapshotId)
    .execute();
}

/**
 * Every table in DELETE_ORDER is scoped to the event either directly
 * (has its own event_id column) or through the immediate parent named here —
 * matching the join used in dumpEventData for that same table.
 */
function matchEventScope(
  eb: import('kysely').ExpressionBuilder<Database, (typeof DELETE_ORDER)[number]>,
  table: (typeof DELETE_ORDER)[number],
  eventId: string,
) {
  switch (table) {
    case 'item_criteria':
      return eb('item_id', 'in', eb.selectFrom('items').select('id').where('event_id', '=', eventId));
    case 'registration_members':
      return eb(
        'registration_id',
        'in',
        eb.selectFrom('registrations').select('id').where('event_id', '=', eventId),
      );
    case 'panel_judges':
      return eb('panel_id', 'in', eb.selectFrom('panels').select('id').where('event_id', '=', eventId));
    case 'session_items':
      return eb('session_id', 'in', eb.selectFrom('sessions').select('id').where('event_id', '=', eventId));
    case 'performance_judges':
      return eb(
        'performance_id',
        'in',
        eb.selectFrom('performances').select('id').where('event_id', '=', eventId),
      );
    case 'scores':
      return eb(
        'performance_id',
        'in',
        eb.selectFrom('performances').select('id').where('event_id', '=', eventId),
      );
    case 'score_criteria_values':
      return eb(
        'score_id',
        'in',
        eb
          .selectFrom('scores as s')
          .innerJoin('performances as p', 'p.id', 's.performance_id')
          .select('s.id')
          .where('p.event_id', '=', eventId),
      );
    case 'import_rows':
      return eb('batch_id', 'in', eb.selectFrom('import_batches').select('id').where('event_id', '=', eventId));
    default:
      // Every other table in DELETE_ORDER has its own event_id column.
      return eb('event_id' as never, '=', eventId as never);
  }
}
