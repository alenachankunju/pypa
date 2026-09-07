/**
 * Session lifecycle (FSD 5.8).
 *
 * A session binds a panel to one or more items at a stage for a period of time.
 * "This is what makes multi-judge scoring deterministic."
 */
import { db, type Executor } from '../../db/pool.js';
import { AuditAction, writeAudit, type AuditActor } from '../../services/audit.js';
import { publishSessionStatus } from '../../services/realtime.js';
import { errors } from '../../utils/errors.js';

export interface OpenSessionResult {
  sessionId: string;
  status: 'OPEN';
  panelSize: number;
  performancesCreated: number;
  performancesExisting: number;
  warnings: string[];
}

interface PanelJudgeRow {
  user_id: string;
  weight: string | number;
  full_name: string;
  is_active: boolean;
  chief_judge_id: string | null;
}

/** ADM-08-02: the completion target is the actual assigned count, active judges only. */
export async function loadActiveJudges(
  trx: Executor,
  panelId: string,
): Promise<{ active: PanelJudgeRow[]; total: number }> {
  const panelJudges = await trx
    .selectFrom('panel_judges as pj')
    .innerJoin('users as u', 'u.id', 'pj.user_id')
    .innerJoin('panels as p', 'p.id', 'pj.panel_id')
    .select(['pj.user_id', 'pj.weight', 'u.full_name', 'u.is_active', 'p.chief_judge_id'])
    .where('pj.panel_id', '=', panelId)
    .where('pj.removed_at', 'is', null)
    .execute();

  return { active: panelJudges.filter((j) => j.is_active), total: panelJudges.length };
}

/**
 * Materialise SCHEDULED performances (+ their judge-panel snapshot) for every
 * still-unperformed REGISTERED registration across the given items. Shared by
 * openSession() (every item in the session, session DRAFT -> OPEN) and
 * addItemsToSession() (just the newly-added item, session already OPEN) —
 * same operation, different trigger, so a mid-session item addition gets
 * exactly the same panel-snapshot guarantee (FSD 7.2) as opening day one.
 */
export async function materializePerformances(
  trx: Executor,
  params: { eventId: string; sessionId: string; itemIds: string[]; activeJudges: PanelJudgeRow[]; userId: string },
): Promise<{ created: number; existing: number }> {
  const { eventId, sessionId, itemIds, activeJudges, userId } = params;
  if (itemIds.length === 0) return { created: 0, existing: 0 };

  const registrations = await trx
    .selectFrom('registrations')
    .select(['id', 'item_id', 'call_order'])
    .where('item_id', 'in', itemIds)
    .where('status', '=', 'REGISTERED')
    .execute();

  const existingPerformances = await trx
    .selectFrom('performances')
    .select(['registration_id'])
    .where('item_id', 'in', itemIds)
    .execute();

  const alreadyHasPerformance = new Set(existingPerformances.map((e) => e.registration_id));
  const toCreate = registrations.filter((r) => !alreadyHasPerformance.has(r.id));

  let created = 0;
  for (const registration of toCreate) {
    const performance = await trx
      .insertInto('performances')
      .values({
        event_id: eventId,
        registration_id: registration.id,
        item_id: registration.item_id,
        session_id: sessionId,
        attempt_no: 1,
        // FSD 7.2: snapshot, never read live from the panel afterwards.
        panel_size: activeJudges.length,
        status: 'SCHEDULED',
        call_order: registration.call_order,
        created_by: userId,
        updated_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // ADM-09-08 needs the expected judges by name, so the panel composition is
    // snapshotted alongside the size.
    await trx
      .insertInto('performance_judges')
      .values(
        activeJudges.map((judge) => ({
          performance_id: performance.id,
          judge_id: judge.user_id,
          weight: Number(judge.weight),
          is_chief: judge.user_id === judge.chief_judge_id,
        })),
      )
      .execute();

    created += 1;
  }

  return { created, existing: registrations.length - created };
}

/**
 * Called right after a new registration is created (registrations.service.ts),
 * for exactly the item just registered — covers the one gap the other two
 * callers don't: openSession() and addItemsToSession() both materialise every
 * REGISTERED registration that exists at the moment an item is linked, but a
 * registration created afterwards, for an item already linked to an
 * already-OPEN session, would otherwise sit in `registrations` with no
 * `performances` row at all — invisible on the live console, and unable to be
 * called to stage, until someone thinks to re-add the item (which
 * addItemsToSession refuses once it's already linked). This closes that gap
 * for every new registration, without waiting for anyone to notice.
 */
export async function materializeForNewRegistration(
  trx: Executor,
  params: { eventId: string; itemId: string; userId: string },
): Promise<void> {
  const links = await trx
    .selectFrom('session_items as si')
    .innerJoin('sessions as s', 's.id', 'si.session_id')
    .select(['s.id as session_id', 's.panel_id'])
    .where('si.item_id', '=', params.itemId)
    .where('s.status', '=', 'OPEN')
    .execute();

  for (const link of links) {
    const { active: activeJudges } = await loadActiveJudges(trx, link.panel_id);
    await materializePerformances(trx, {
      eventId: params.eventId,
      sessionId: link.session_id,
      itemIds: [params.itemId],
      activeJudges,
      userId: params.userId,
    });
  }
}

/**
 * ADM-08-04: "Open a session. Only when a session is open can its judges enter
 * marks."
 *
 * Opening also materialises the performances for every registration in the
 * session's items. FSD 4.1 describes a performance as created "the moment a
 * participant is called to the stage", but creating them up front is what makes
 * the live console's participant list, the outstanding-marks panel (ADM-09-08)
 * and the progress indicator (ADM-09-09) possible before anyone has performed.
 * A SCHEDULED performance is exactly that: called but not yet on stage.
 *
 * Each performance snapshots its panel size AND its expected judges (FSD 7.2),
 * so a mid-session panel change cannot retroactively alter what a performance
 * already in flight was targeting.
 */
export async function openSession(
  sessionId: string,
  eventId: string,
  actor: AuditActor,
  userId: string,
): Promise<OpenSessionResult> {
  return db.transaction().execute(async (trx) => {
    const session = await trx
      .selectFrom('sessions')
      .select(['id', 'name', 'status', 'panel_id'])
      .where('id', '=', sessionId)
      .where('event_id', '=', eventId)
      .forUpdate()
      .executeTakeFirst();

    if (!session) throw errors.notFound('Session', sessionId);
    if (session.status === 'OPEN') {
      throw errors.conflict(`Session "${session.name}" is already open.`);
    }
    if (session.status === 'CLOSED' || session.status === 'FORCE_CLOSED') {
      throw errors.conflict(
        `Session "${session.name}" has been closed and cannot be reopened. Create a new session if further judging is needed.`,
      );
    }

    const { active: activeJudges, total: totalJudges } = await loadActiveJudges(trx, session.panel_id);

    if (activeJudges.length === 0) {
      throw errors.conflict(
        `Session "${session.name}" cannot be opened: its panel has no active judges assigned (FSD ADM-08-01).`,
      );
    }

    const warnings: string[] = [];
    if (activeJudges.length < totalJudges) {
      warnings.push(
        `${totalJudges - activeJudges.length} judge(s) on this panel have deactivated accounts and are excluded. The completion target is ${activeJudges.length}.`,
      );
    }

    const items = await trx
      .selectFrom('session_items')
      .select('item_id')
      .where('session_id', '=', sessionId)
      .execute();

    if (items.length === 0) {
      throw errors.conflict(
        `Session "${session.name}" has no items assigned to it (FSD ADM-08-03).`,
      );
    }

    const itemIds = items.map((i) => i.item_id);

    const { created: performancesCreated, existing: performancesExisting } = await materializePerformances(trx, {
      eventId,
      sessionId,
      itemIds,
      activeJudges,
      userId,
    });

    await trx
      .updateTable('sessions')
      .set({ status: 'OPEN', opened_at: new Date(), opened_by: userId, updated_by: userId })
      .where('id', '=', sessionId)
      .execute();

    await writeAudit(
      {
        eventId,
        actor,
        action: AuditAction.SESSION_OPENED,
        entityType: 'session',
        entityId: sessionId,
        newValue: {
          panelSize: activeJudges.length,
          itemCount: itemIds.length,
          performancesCreated,
        },
      },
      trx,
    );

    publishSessionStatus(sessionId, 'OPEN');

    return {
      sessionId,
      status: 'OPEN' as const,
      panelSize: activeJudges.length,
      performancesCreated,
      performancesExisting,
      warnings,
    };
  });
}

export interface AddItemsToSessionResult {
  sessionId: string;
  itemsAdded: number;
  performancesCreated: number;
}

/**
 * Add item(s) to a session after it was created — the original creation form
 * (ADM-08-03) takes the item list once and PATCH deliberately can't change
 * it, so there was previously no way to bring a new item into a session that
 * was already open without creating a whole second session for it. If the
 * session is already OPEN, this immediately materialises SCHEDULED
 * performances for the new item's current registrations too (same snapshot
 * guarantee as opening day one) — otherwise the added item silently never
 * gets a performance created for it and can't be put on stage. If the
 * session is still DRAFT, opening it later does that naturally.
 */
export async function addItemsToSession(
  sessionId: string,
  eventId: string,
  itemIds: string[],
  actor: AuditActor,
  userId: string,
): Promise<AddItemsToSessionResult> {
  return db.transaction().execute(async (trx) => {
    const session = await trx
      .selectFrom('sessions')
      .select(['id', 'name', 'status', 'panel_id'])
      .where('id', '=', sessionId)
      .where('event_id', '=', eventId)
      .forUpdate()
      .executeTakeFirst();

    if (!session) throw errors.notFound('Session', sessionId);
    if (session.status === 'CLOSED' || session.status === 'FORCE_CLOSED') {
      throw errors.conflict(`Session "${session.name}" is closed — create a new session for further items.`);
    }

    const items = await trx
      .selectFrom('items')
      .select(['id', 'name'])
      .where('id', 'in', itemIds)
      .where('event_id', '=', eventId)
      .execute();
    if (items.length !== itemIds.length) throw errors.notFound('Item', itemIds.join(', '));

    const existingLinks = await trx
      .selectFrom('session_items')
      .select(['item_id', 'display_order'])
      .where('session_id', '=', sessionId)
      .execute();

    const alreadyLinked = new Set(existingLinks.map((l) => l.item_id));
    const newItemIds = itemIds.filter((id) => !alreadyLinked.has(id));

    if (newItemIds.length === 0) {
      throw errors.conflict('Every selected item is already part of this session.');
    }

    let nextOrder = existingLinks.reduce((max, l) => Math.max(max, l.display_order), -1) + 1;

    await trx
      .insertInto('session_items')
      .values(
        newItemIds.map((itemId) => ({
          session_id: sessionId,
          item_id: itemId,
          display_order: nextOrder++,
          created_by: userId,
          updated_by: userId,
        })),
      )
      .execute();

    let performancesCreated = 0;
    if (session.status === 'OPEN') {
      const { active: activeJudges } = await loadActiveJudges(trx, session.panel_id);
      const result = await materializePerformances(trx, {
        eventId,
        sessionId,
        itemIds: newItemIds,
        activeJudges,
        userId,
      });
      performancesCreated = result.created;
    }

    await writeAudit(
      {
        eventId,
        actor,
        action: AuditAction.UPDATED,
        entityType: 'session',
        entityId: sessionId,
        newValue: { itemsAdded: items.map((i) => i.name), performancesCreated },
        reason: `Added ${items.length} item(s) to session "${session.name}" after creation (ADM-08-03).`,
      },
      trx,
    );

    if (performancesCreated > 0) publishSessionStatus(sessionId, 'OPEN');

    return { sessionId, itemsAdded: newItemIds.length, performancesCreated };
  });
}

export interface CloseSessionResult {
  sessionId: string;
  status: 'CLOSED' | 'FORCE_CLOSED';
  forced: boolean;
  incompletePerformances: {
    performanceId: string;
    itemName: string;
    chestNumber: string | null;
    participantName: string;
    status: string;
    missingJudges: string[];
  }[];
}

/**
 * ADM-08-05: "Close a session. Closing is blocked, with an explicit list of
 * exceptions, if any performance in the session is not COMPLETE, ABSENT or VOID.
 * The administrator may force-close, which requires a reason and is prominently
 * flagged in the audit log and on the result sheet."
 */
export async function closeSession(
  sessionId: string,
  eventId: string,
  options: { force?: boolean; reason?: string },
  actor: AuditActor,
  userId: string,
): Promise<CloseSessionResult> {
  const session = await db
    .selectFrom('sessions')
    .select(['id', 'name', 'status'])
    .where('id', '=', sessionId)
    .where('event_id', '=', eventId)
    .executeTakeFirst();

  if (!session) throw errors.notFound('Session', sessionId);
  if (session.status !== 'OPEN') {
    throw errors.conflict(`Session "${session.name}" is not open.`);
  }

  const incomplete = await listIncompletePerformances(sessionId);

  if (incomplete.length > 0 && !options.force) {
    throw errors.conflict(
      `Session "${session.name}" has ${incomplete.length} performance(s) that are not complete. ` +
        'Resolve them, or force-close with a reason — a forced close is flagged on every affected result sheet (FSD ADM-08-05).',
      { incompletePerformances: incomplete, canForce: true },
    );
  }

  if (options.force && incomplete.length > 0) {
    const reason = options.reason?.trim() ?? '';
    if (reason.length < 15) {
      throw errors.validation(
        'Force-closing a session with incomplete performances requires a reason of at least 15 characters. ' +
          'It appears in the exceptions report and on the result sheet (FSD ADM-08-05, ADM-10-04).',
      );
    }
  }

  const forced = options.force === true && incomplete.length > 0;
  const status = forced ? ('FORCE_CLOSED' as const) : ('CLOSED' as const);

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('sessions')
      .set({
        status,
        closed_at: new Date(),
        closed_by: userId,
        force_closed_reason: forced ? (options.reason ?? null) : null,
        updated_by: userId,
      })
      .where('id', '=', sessionId)
      .execute();

    // Nothing is on stage once the session is closed.
    await trx
      .updateTable('performances')
      .set({ is_current: false, updated_by: userId })
      .where('session_id', '=', sessionId)
      .where('is_current', '=', true)
      .execute();

    await writeAudit(
      {
        eventId,
        actor,
        action: forced ? AuditAction.SESSION_FORCE_CLOSED : AuditAction.SESSION_CLOSED,
        entityType: 'session',
        entityId: sessionId,
        oldValue: { status: 'OPEN' },
        newValue: { status, incompleteCount: incomplete.length },
        reason: forced ? options.reason : null,
      },
      trx,
    );
  });

  publishSessionStatus(sessionId, status);

  return { sessionId, status, forced, incompletePerformances: incomplete };
}

/**
 * Every performance in a session that is not COMPLETE, ABSENT, VOID or WITHDRAWN,
 * with the judges still owing a mark.
 *
 * This is the query behind ADM-09-08's outstanding-marks panel — "the single most
 * important operational feature in the system" — and behind the ADM-08-05 close
 * check.
 */
export async function listIncompletePerformances(
  sessionId: string,
  executor: Executor = db,
): Promise<CloseSessionResult['incompletePerformances']> {
  const rows = await executor
    .selectFrom('v_performance_progress as pp')
    .innerJoin('items as i', 'i.id', 'pp.item_id')
    .innerJoin('registrations as r', 'r.id', 'pp.registration_id')
    .leftJoin('members as m', 'm.id', 'r.member_id')
    .leftJoin('categories as cat', 'cat.id', 'i.category_id')
    .select([
      'pp.performance_id',
      'pp.status',
      'pp.missing_judges',
      'i.name as item_name',
      'm.chest_number',
      'm.full_name as member_name',
      'r.team_name',
    ])
    .where('pp.session_id', '=', sessionId)
    .where('pp.status', 'in', ['SCHEDULED', 'ON_STAGE', 'IN_PROGRESS'])
    // Same ordering as the live console: lower category to higher, then item,
    // then chest number.
    .orderBy('cat.min_age')
    .orderBy('i.name')
    .orderBy('m.chest_number_numeric')
    .execute();

  return rows.map((row) => ({
    performanceId: row.performance_id,
    itemName: row.item_name,
    chestNumber: row.chest_number,
    participantName: row.member_name ?? row.team_name ?? 'Unknown',
    status: row.status,
    missingJudges: parseMissingJudges(row.missing_judges).map((j) => j.fullName),
  }));
}

export function parseMissingJudges(raw: unknown): { judgeId: string; fullName: string }[] {
  if (!raw) return [];
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? (parsed as { judgeId: string; fullName: string }[]) : [];
}

/**
 * ADM-08-07: "The system warns if the same judge is assigned to two sessions
 * that overlap in time."
 *
 * FSD 12.3 confirms this is a warning rather than a block: "Two sessions run
 * simultaneously on different stages — Fully supported ... a judge assigned to
 * both is warned of the overlap at assignment time."
 */
export async function findOverlappingAssignments(
  sessionId: string,
  eventId: string,
): Promise<{ judgeName: string; otherSessionName: string; otherSessionId: string }[]> {
  const session = await db
    .selectFrom('sessions')
    .select(['id', 'panel_id', 'scheduled_start', 'scheduled_end'])
    .where('id', '=', sessionId)
    .executeTakeFirst();

  if (!session?.scheduled_start || !session.scheduled_end) return [];

  const rows = await db
    .selectFrom('sessions as other')
    .innerJoin('panel_judges as pj', 'pj.panel_id', 'other.panel_id')
    .innerJoin('users as u', 'u.id', 'pj.user_id')
    .select(['u.full_name as judge_name', 'other.name as other_session_name', 'other.id as other_session_id'])
    .where('other.event_id', '=', eventId)
    .where('other.id', '!=', sessionId)
    .where('other.status', 'in', ['DRAFT', 'OPEN'])
    .where('pj.removed_at', 'is', null)
    // Two intervals overlap when each starts before the other ends.
    .where('other.scheduled_start', '<', session.scheduled_end)
    .where('other.scheduled_end', '>', session.scheduled_start)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('panel_judges as mine')
          .select('mine.id')
          .where('mine.panel_id', '=', session.panel_id)
          .where('mine.removed_at', 'is', null)
          .whereRef('mine.user_id', '=', 'pj.user_id'),
      ),
    )
    .execute();

  return rows.map((r) => ({
    judgeName: r.judge_name,
    otherSessionName: r.other_session_name,
    otherSessionId: r.other_session_id,
  }));
}
