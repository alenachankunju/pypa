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

    // ADM-08-02: the completion target is the actual assigned count.
    const panelJudges = await trx
      .selectFrom('panel_judges as pj')
      .innerJoin('users as u', 'u.id', 'pj.user_id')
      .innerJoin('panels as p', 'p.id', 'pj.panel_id')
      .select(['pj.user_id', 'pj.weight', 'u.full_name', 'u.is_active', 'p.chief_judge_id'])
      .where('pj.panel_id', '=', session.panel_id)
      .where('pj.removed_at', 'is', null)
      .execute();

    const activeJudges = panelJudges.filter((j) => j.is_active);

    if (activeJudges.length === 0) {
      throw errors.conflict(
        `Session "${session.name}" cannot be opened: its panel has no active judges assigned (FSD ADM-08-01).`,
      );
    }

    const warnings: string[] = [];
    if (activeJudges.length < panelJudges.length) {
      warnings.push(
        `${panelJudges.length - activeJudges.length} judge(s) on this panel have deactivated accounts and are excluded. The completion target is ${activeJudges.length}.`,
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

    const registrations = await trx
      .selectFrom('registrations')
      .select(['id', 'item_id', 'call_order'])
      .where('item_id', 'in', itemIds)
      .where('status', '=', 'REGISTERED')
      .execute();

    const existing = await trx
      .selectFrom('performances')
      .select(['registration_id'])
      .where('item_id', 'in', itemIds)
      .execute();

    const alreadyHasPerformance = new Set(existing.map((e) => e.registration_id));
    const toCreate = registrations.filter((r) => !alreadyHasPerformance.has(r.id));

    let performancesCreated = 0;

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

      performancesCreated += 1;
    }

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
      performancesExisting: registrations.length - performancesCreated,
      warnings,
    };
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
