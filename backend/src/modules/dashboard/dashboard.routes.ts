/**
 * Administrator dashboard (screen A1) and the pre-event readiness report.
 *
 * FSD 13: "The system surfaces this as a setup checklist on the administrator
 * dashboard, showing what remains before judging can begin."
 *
 * FSD 13 also specifies the readiness report: "lists members without
 * registrations, items without participants, items without a session, sessions
 * without a panel, judges without an assignment, and any member whose derived
 * category conflicts with an item they are entered in. This report should be run
 * and cleared the day before the event."
 */
import { Router } from 'express';
import { sql } from 'kysely';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { publicationSummary } from '../../services/results/publication.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { parseMissingJudges } from '../sessions/sessions.service.js';

export function dashboardRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());
  router.use(requireCapability(Capability.VIEW_PROVISIONAL_RESULTS));

  /**
   * ADM-A1: "Churches, members, items, sessions; outstanding marks; unpublished
   * item count."
   */
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const eventId = req.eventId!;

      const [counts, openSessions, outstanding, results, recentActivity] = await Promise.all([
        dashboardCounts(eventId),

        db
          .selectFrom('sessions as s')
          .innerJoin('panels as p', 'p.id', 's.panel_id')
          .select((eb) => [
            's.id',
            's.name',
            's.stage',
            's.opened_at',
            'p.name as panel_name',
            eb
              .selectFrom('performances as pf')
              .select((i) => i.fn.countAll<number>().as('n'))
              .whereRef('pf.session_id', '=', 's.id')
              .as('total'),
            eb
              .selectFrom('performances as pf')
              .select((i) => i.fn.countAll<number>().as('n'))
              .whereRef('pf.session_id', '=', 's.id')
              .where('pf.status', 'in', ['COMPLETE', 'ABSENT', 'VOID', 'WITHDRAWN'])
              .as('resolved'),
          ])
          .where('s.event_id', '=', eventId)
          .where('s.status', '=', 'OPEN')
          .orderBy('s.opened_at')
          .execute(),

        // The cross-session outstanding-marks view (ADM-09-08 at dashboard level).
        db
          .selectFrom('v_performance_progress as pp')
          .innerJoin('items as i', 'i.id', 'pp.item_id')
          .innerJoin('sessions as s', 's.id', 'pp.session_id')
          .innerJoin('registrations as r', 'r.id', 'pp.registration_id')
          .leftJoin('members as m', 'm.id', 'r.member_id')
          .select([
            'pp.performance_id',
            'pp.status',
            'pp.submitted_count',
            'pp.panel_size',
            'pp.missing_judges',
            'i.name as item_name',
            's.name as session_name',
            's.id as session_id',
            'm.chest_number',
            'm.full_name as member_name',
            'r.team_name',
          ])
          .where('pp.event_id', '=', eventId)
          .where('s.status', '=', 'OPEN')
          .where('pp.status', 'in', ['ON_STAGE', 'IN_PROGRESS'])
          .orderBy('pp.outstanding_count', 'desc')
          .limit(50)
          .execute(),

        publicationSummary(eventId),

        db
          .selectFrom('audit_logs')
          .select(['id', 'occurred_at', 'actor_name', 'action', 'entity_type', 'reason'])
          .where((eb) => eb.or([eb('event_id', '=', eventId), eb('event_id', 'is', null)]))
          .orderBy('occurred_at', 'desc')
          .limit(15)
          .execute(),
      ]);

      return ok(res, {
        counts,
        openSessions: openSessions.map((s) => ({
          id: s.id,
          name: s.name,
          stage: s.stage,
          panelName: s.panel_name,
          openedAt: s.opened_at,
          total: Number(s.total ?? 0),
          resolved: Number(s.resolved ?? 0),
        })),
        outstandingMarks: outstanding.map((o) => ({
          performanceId: o.performance_id,
          sessionId: o.session_id,
          sessionName: o.session_name,
          itemName: o.item_name,
          chestNumber: o.chest_number,
          participantName: o.member_name ?? o.team_name ?? 'Unknown',
          status: o.status,
          submittedCount: Number(o.submitted_count),
          panelSize: o.panel_size,
          missingJudges: parseMissingJudges(o.missing_judges),
        })),
        results,
        recentActivity: recentActivity.map((a) => ({
          id: Number(a.id),
          occurredAt: a.occurred_at,
          actorName: a.actor_name,
          action: a.action,
          entityType: a.entity_type,
          reason: a.reason,
        })),
      });
    }),
  );

  /**
   * FSD 13: the setup checklist.
   *
   * "The order below is enforced by dependency: each step requires the previous
   * one." Each step reports whether it is complete and what it blocks, so the
   * dashboard can show exactly where setup has stalled.
   */
  router.get(
    '/setup-checklist',
    asyncHandler(async (req, res) => {
      const eventId = req.eventId!;
      const counts = await dashboardCounts(eventId);

      const event = await db
        .selectFrom('events')
        .select(['age_cutoff_date', 'name'])
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow();

      const [config, badges] = await Promise.all([
        db.selectFrom('scoring_config').select(['id']).where('event_id', '=', eventId).executeTakeFirst(),
        db
          .selectFrom('snapshots')
          .select((eb) => eb.fn.countAll<number>().as('c'))
          .where('event_id', '=', eventId)
          .executeTakeFirstOrThrow(),
      ]);

      const steps = [
        {
          step: 1,
          action: 'Configure event settings including the age cut-off date',
          blocks: 'Category derivation',
          complete: Boolean(event.age_cutoff_date),
          detail: `Cut-off date: ${event.age_cutoff_date}`,
        },
        {
          step: 2,
          action: 'Create categories with age bands',
          blocks: 'Item creation, member categorisation',
          complete: counts.categories > 0,
          detail: `${counts.categories} category/categories`,
        },
        {
          step: 3,
          action: 'Create churches',
          blocks: 'Member creation',
          complete: counts.churches > 0,
          detail: `${counts.churches} church(es)`,
        },
        {
          step: 4,
          action: 'Create items and assign categories, caps and criteria',
          blocks: 'Registration',
          complete: counts.items > 0,
          detail: `${counts.items} item(s)`,
        },
        {
          step: 5,
          action: 'Configure scoring rules, position points, tie-breaks and grades',
          blocks: 'Result computation',
          complete: Boolean(config),
          detail: config ? 'Configured' : 'Not yet configured',
        },
        {
          step: 6,
          action: 'Create members with chest numbers and church allocation',
          blocks: 'Registration',
          complete: counts.members > 0,
          detail: `${counts.members} member(s)`,
        },
        {
          step: 7,
          action: 'Register members to items',
          blocks: 'Performance creation',
          complete: counts.registrations > 0,
          detail: `${counts.registrations} registration(s)`,
        },
        {
          step: 8,
          action: 'Create judge accounts and issue credentials',
          blocks: 'Panel creation',
          complete: counts.judges > 0,
          detail: `${counts.judges} judge account(s)`,
        },
        {
          step: 9,
          action: 'Build panels and designate chief judges where used',
          blocks: 'Session creation',
          complete: counts.panels > 0,
          detail: `${counts.panels} panel(s)`,
        },
        {
          step: 10,
          action: 'Create sessions binding panels to items and stages',
          blocks: 'Opening a session',
          complete: counts.sessions > 0,
          detail: `${counts.sessions} session(s)`,
        },
        {
          step: 11,
          action: 'Print badges and call sheets',
          blocks: 'Event day operations',
          // Printing leaves no trace in the data, so this is an operator
          // acknowledgement rather than something the system can verify.
          complete: null,
          detail: 'Manual step — print from Reports',
        },
        {
          step: 12,
          action: 'Take a pre-event snapshot',
          blocks: 'Recovery position',
          complete: Number(badges.c) > 0,
          detail: `${badges.c} snapshot(s) taken`,
        },
        {
          step: 13,
          action: 'Open sessions and begin judging',
          blocks: null,
          complete: counts.openSessions > 0,
          detail: `${counts.openSessions} session(s) open`,
        },
      ];

      const blocked = steps.find((s) => s.complete === false);

      return ok(res, {
        eventName: event.name,
        steps,
        nextStep: blocked ?? null,
        completedCount: steps.filter((s) => s.complete === true).length,
        totalSteps: steps.length,
      });
    }),
  );

  /**
   * FSD 13 pre-event readiness report.
   *
   * "This report should be run and cleared the day before the event."
   */
  router.get(
    '/readiness',
    asyncHandler(async (req, res) => {
      const eventId = req.eventId!;

      const [
        membersWithoutRegistrations,
        itemsWithoutParticipants,
        itemsWithoutSession,
        sessionsWithoutPanel,
        judgesWithoutAssignment,
        categoryConflicts,
      ] = await Promise.all([
        db
          .selectFrom('members as m')
          .innerJoin('churches as c', 'c.id', 'm.church_id')
          .select(['m.id', 'm.chest_number', 'm.full_name', 'c.name as church_name'])
          .where('m.event_id', '=', eventId)
          .where('m.is_active', '=', true)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('registrations as r')
                  .select('r.id')
                  .whereRef('r.member_id', '=', 'm.id')
                  .where('r.status', '=', 'REGISTERED'),
              ),
            ),
          )
          .orderBy('m.chest_number_numeric')
          .execute(),

        db
          .selectFrom('items as i')
          .select(['i.id', 'i.name', 'i.code'])
          .where('i.event_id', '=', eventId)
          .where('i.status', '=', 'ACTIVE')
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('registrations as r')
                  .select('r.id')
                  .whereRef('r.item_id', '=', 'i.id')
                  .where('r.status', '=', 'REGISTERED'),
              ),
            ),
          )
          .orderBy('i.name')
          .execute(),

        db
          .selectFrom('items as i')
          .select(['i.id', 'i.name', 'i.code'])
          .where('i.event_id', '=', eventId)
          .where('i.status', '=', 'ACTIVE')
          .where((eb) =>
            eb.not(
              eb.exists(
                eb.selectFrom('session_items as si').select('si.id').whereRef('si.item_id', '=', 'i.id'),
              ),
            ),
          )
          .orderBy('i.name')
          .execute(),

        // A session must have a panel by foreign key, so the real failure mode
        // is a panel with no judges on it.
        db
          .selectFrom('sessions as s')
          .innerJoin('panels as p', 'p.id', 's.panel_id')
          .select(['s.id', 's.name', 'p.name as panel_name'])
          .where('s.event_id', '=', eventId)
          .where('s.status', 'in', ['DRAFT', 'OPEN'])
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('panel_judges as pj')
                  .select('pj.id')
                  .whereRef('pj.panel_id', '=', 'p.id')
                  .where('pj.removed_at', 'is', null),
              ),
            ),
          )
          .execute(),

        db
          .selectFrom('users as u')
          .select(['u.id', 'u.full_name', 'u.username'])
          .where('u.role', '=', 'JUDGE')
          .where('u.is_active', '=', true)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('panel_judges as pj')
                  .innerJoin('panels as p', 'p.id', 'pj.panel_id')
                  .select('pj.id')
                  .whereRef('pj.user_id', '=', 'u.id')
                  .where('p.event_id', '=', eventId)
                  .where('pj.removed_at', 'is', null),
              ),
            ),
          )
          .orderBy('u.full_name')
          .execute(),

        // "any member whose derived category conflicts with an item they are
        // entered in" — the registrations that would now be refused.
        db
          .selectFrom('registrations as r')
          .innerJoin('items as i', 'i.id', 'r.item_id')
          .innerJoin('members as m', 'm.id', 'r.member_id')
          .leftJoin('categories as ic', 'ic.id', 'i.category_id')
          .leftJoin('categories as mc', 'mc.id', 'm.category_id')
          .select([
            'r.id as registration_id',
            'm.chest_number',
            'm.full_name as member_name',
            'i.name as item_name',
            'ic.name as item_category',
            'mc.name as member_category',
            'i.gender_restriction',
            'm.gender',
          ])
          .where('r.event_id', '=', eventId)
          .where('r.status', '=', 'REGISTERED')
          .where('i.open_to_all_categories', '=', false)
          // Written as a raw fragment because it compares two different enum
          // types (gender against gender_restriction), which the query builder
          // correctly refuses to do implicitly. The cast to text is the
          // deliberate widening that makes the comparison meaningful.
          .where(
            sql<boolean>`(
              (i.category_id IS NOT NULL
                AND (m.category_id IS NULL OR m.category_id <> i.category_id))
              OR
              (i.gender_restriction <> 'ANY'
                AND (m.gender IS NULL OR m.gender::text <> i.gender_restriction::text))
            )`,
          )
          .execute(),
      ]);

      const issues = [
        { key: 'membersWithoutRegistrations', label: 'Members with no registrations', rows: membersWithoutRegistrations },
        { key: 'itemsWithoutParticipants', label: 'Items with no participants', rows: itemsWithoutParticipants },
        { key: 'itemsWithoutSession', label: 'Items not assigned to any session', rows: itemsWithoutSession },
        { key: 'sessionsWithoutJudges', label: 'Sessions whose panel has no judges', rows: sessionsWithoutPanel },
        { key: 'judgesWithoutAssignment', label: 'Judges not assigned to any panel', rows: judgesWithoutAssignment },
        { key: 'categoryConflicts', label: 'Registrations whose eligibility no longer holds', rows: categoryConflicts },
      ];

      const totalIssues = issues.reduce((sum, i) => sum + i.rows.length, 0);

      return ok(res, {
        clean: totalIssues === 0,
        totalIssues,
        issues,
        note:
          totalIssues === 0
            ? 'The readiness report is clear. The event is ready to judge (FSD 13).'
            : 'Resolve these before event day. This report should be run and cleared the day before (FSD 13).',
      });
    }),
  );

  return router;
}

async function dashboardCounts(eventId: string) {
  const [churches, categories, items, members, registrations, judges, panels, sessions, openSessions] =
    await Promise.all([
      db.selectFrom('churches').select((eb) => eb.fn.countAll<number>().as('c')).where('is_active', '=', true).executeTakeFirstOrThrow(),
      db.selectFrom('categories').select((eb) => eb.fn.countAll<number>().as('c')).where('event_id', '=', eventId).where('is_active', '=', true).executeTakeFirstOrThrow(),
      db.selectFrom('items').select((eb) => eb.fn.countAll<number>().as('c')).where('event_id', '=', eventId).where('status', '=', 'ACTIVE').executeTakeFirstOrThrow(),
      db.selectFrom('members').select((eb) => eb.fn.countAll<number>().as('c')).where('event_id', '=', eventId).where('is_active', '=', true).executeTakeFirstOrThrow(),
      db.selectFrom('registrations').select((eb) => eb.fn.countAll<number>().as('c')).where('event_id', '=', eventId).where('status', '=', 'REGISTERED').executeTakeFirstOrThrow(),
      db.selectFrom('users').select((eb) => eb.fn.countAll<number>().as('c')).where('role', '=', 'JUDGE').where('is_active', '=', true).executeTakeFirstOrThrow(),
      db.selectFrom('panels').select((eb) => eb.fn.countAll<number>().as('c')).where('event_id', '=', eventId).where('is_active', '=', true).executeTakeFirstOrThrow(),
      db.selectFrom('sessions').select((eb) => eb.fn.countAll<number>().as('c')).where('event_id', '=', eventId).executeTakeFirstOrThrow(),
      db.selectFrom('sessions').select((eb) => eb.fn.countAll<number>().as('c')).where('event_id', '=', eventId).where('status', '=', 'OPEN').executeTakeFirstOrThrow(),
    ]);

  return {
    churches: Number(churches.c),
    categories: Number(categories.c),
    items: Number(items.c),
    members: Number(members.c),
    registrations: Number(registrations.c),
    judges: Number(judges.c),
    panels: Number(panels.c),
    sessions: Number(sessions.c),
    openSessions: Number(openSessions.c),
  };
}
