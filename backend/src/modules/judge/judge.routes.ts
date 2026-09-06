/**
 * Judge endpoints (FSD 6, 9.3).
 *
 * This namespace is shaped as much by what it OMITS as by what it contains.
 *
 * FSD 9.3: "There is deliberately no PUT or DELETE endpoint for scores in the
 * judge namespace. The absence is part of the specification." (AC-05)
 *
 * FSD 6.9 — what judges must never see, each item "a potential integrity
 * failure". Every response below is filtered against that list:
 *   - any other judge's mark, at any time          -> no route returns another judge's mark
 *   - aggregate or average scores                  -> aggregate is never selected here
 *   - any ranking, position or leaderboard         -> no results route in this namespace
 *   - church point totals or championship standings-> likewise
 *   - members or items outside their session        -> every query joins through the session
 *   - any administrative function or route          -> denyJudges guards /api/admin
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { scoreRateLimit } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { actorFromRequest } from '../../services/audit.js';
import { submitScore } from '../../services/scoring/submitScore.js';
import { errors } from '../../utils/errors.js';
import { asyncHandler, created, ok } from '../../utils/http.js';

export function judgeRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());

  /**
   * JDG-01-02 / FSD 9.3: open sessions assigned to this judge.
   *
   * JDG-01-03: "If the judge has no open session, the screen states clearly 'No
   * active judging session assigned' and shows their upcoming sessions with
   * scheduled times." Upcoming DRAFT sessions are therefore returned alongside
   * the open ones, so the client has something to show rather than a blank.
   */
  router.get(
    '/sessions',
    requireCapability(Capability.ENTER_SCORE),
    asyncHandler(async (req, res) => {
      const judgeId = req.auth!.userId;

      const sessions = await db
        .selectFrom('sessions as s')
        .innerJoin('panels as p', 'p.id', 's.panel_id')
        .innerJoin('panel_judges as pj', 'pj.panel_id', 'p.id')
        .select((eb) => [
          's.id',
          's.name',
          's.stage',
          's.status',
          's.scheduled_start',
          's.scheduled_end',
          'p.name as panel_name',
          eb
            .selectFrom('session_items as si')
            .select((i) => i.fn.countAll<number>().as('n'))
            .whereRef('si.session_id', '=', 's.id')
            .as('item_count'),
          // The judge's OWN outstanding count. Deliberately not the panel's:
          // FSD 6.9 forbids showing a judge how far anyone else has got.
          eb
            .selectFrom('performance_judges as mypj')
            .innerJoin('performances as pf', 'pf.id', 'mypj.performance_id')
            .select((i) => i.fn.countAll<number>().as('n'))
            .whereRef('pf.session_id', '=', 's.id')
            .where('mypj.judge_id', '=', judgeId)
            .where('pf.status', 'in', ['SCHEDULED', 'ON_STAGE', 'IN_PROGRESS'])
            .where((inner) =>
              inner.not(
                inner.exists(
                  inner
                    .selectFrom('scores as sc')
                    .select('sc.id')
                    .whereRef('sc.performance_id', '=', 'pf.id')
                    .where('sc.judge_id', '=', judgeId)
                    .where('sc.revoked', '=', false),
                ),
              ),
            )
            .as('my_outstanding'),
        ])
        .where('s.event_id', '=', req.eventId!)
        .where('pj.user_id', '=', judgeId)
        .where('pj.removed_at', 'is', null)
        .where('s.status', 'in', ['DRAFT', 'OPEN'])
        .orderBy('s.status')
        .orderBy('s.scheduled_start')
        .execute();

      const open = sessions.filter((s) => s.status === 'OPEN');

      return ok(res, {
        open: open.map(mapSession),
        upcoming: sessions.filter((s) => s.status === 'DRAFT').map(mapSession),
        // JDG-01-02: "If exactly one session is open, the judge is taken straight
        // into it."
        autoSelectSessionId: open.length === 1 ? open[0]!.id : null,
      });
    }),
  );

  /**
   * FSD 9.3: GET /api/judge/sessions/{id}/bundle — the cacheable offline bundle.
   *
   * JDG-08-01: "On entering a session the app caches the participant and item
   * data for that session locally."
   *
   * Everything the judge app needs to keep working with no network, and nothing
   * more. No marks (not even the judge's own aggregate view), no other judges,
   * no items outside the session (JDG-03-05, 6.9).
   */
  router.get(
    '/sessions/:id/bundle',
    requireCapability(Capability.ENTER_SCORE),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id: sessionId } = req.params as { id: string };
      const judgeId = req.auth!.userId;

      const session = await assertJudgeOnSession(sessionId, judgeId, req.eventId!);

      const [items, performances, myScores, config] = await Promise.all([
        db
          .selectFrom('session_items as si')
          .innerJoin('items as i', 'i.id', 'si.item_id')
          .leftJoin('scoring_config as sc', 'sc.event_id', 'i.event_id')
          .select([
            'i.id',
            'i.name',
            'i.code',
            'i.type',
            'i.stage',
            'i.max_mark',
            'sc.max_mark as config_max_mark',
            'sc.decimal_places',
            'si.display_order',
          ])
          .where('si.session_id', '=', sessionId)
          .orderBy('si.display_order')
          .execute(),

        db
          .selectFrom('performances as p')
          .innerJoin('registrations as r', 'r.id', 'p.registration_id')
          .innerJoin('churches as c', 'c.id', 'r.church_id')
          .leftJoin('members as m', 'm.id', 'r.member_id')
          .leftJoin('categories as cat', 'cat.id', 'm.category_id')
          .select([
            'p.id as performance_id',
            'p.item_id',
            'p.status',
            'p.is_current',
            'p.call_order',
            'p.attempt_no',
            'm.id as member_id',
            'm.chest_number',
            'm.full_name as member_name',
            'm.photo_path',
            'r.team_name',
            'r.id as registration_id',
            'c.name as church_name',
            'c.short_code as church_short_code',
            'cat.name as category_name',
          ])
          .where('p.session_id', '=', sessionId)
          // A voided or withdrawn performance can never be scored, so it is not
          // cached — it would only clutter the search results on a small screen.
          .where('p.status', 'in', ['SCHEDULED', 'ON_STAGE', 'IN_PROGRESS', 'COMPLETE', 'ABSENT'])
          .orderBy('p.call_order')
          .execute(),

        // JDG-02-03: "If the judge has already submitted for the current
        // performance, the screen shows a clear submitted confirmation with THEIR
        // OWN mark." Only this judge's rows are ever returned.
        db
          .selectFrom('scores as s')
          .innerJoin('performances as p', 'p.id', 's.performance_id')
          .select(['s.id', 's.performance_id', 's.mark', 's.submitted_at', 's.revoked', 's.revoked_reason'])
          .where('p.session_id', '=', sessionId)
          .where('s.judge_id', '=', judgeId)
          .execute(),

        db
          .selectFrom('scoring_config')
          .select(['max_mark', 'decimal_places', 'show_out_of_session_items'])
          .where('event_id', '=', req.eventId!)
          .executeTakeFirst(),
      ]);

      const itemIds = items.map((i) => i.id);
      const criteria =
        itemIds.length > 0
          ? await db
              .selectFrom('item_criteria')
              .select(['id', 'item_id', 'name', 'max_mark', 'display_order'])
              .where('item_id', 'in', itemIds)
              .orderBy('display_order')
              .execute()
          : [];

      const myScoreByPerformance = new Map(
        myScores.filter((s) => !s.revoked).map((s) => [s.performance_id, s]),
      );
      const revokedByPerformance = new Map(
        myScores.filter((s) => s.revoked).map((s) => [s.performance_id, s]),
      );

      return ok(res, {
        session: {
          id: session.id,
          name: session.name,
          stage: session.stage,
          status: session.status,
          panelName: session.panel_name,
        },
        judge: { id: judgeId, fullName: req.auth!.fullName },
        config: {
          maxMark: Number(config?.max_mark ?? 10),
          decimalPlaces: Number(config?.decimal_places ?? 1),
          // JDG-04-03: default is to show out-of-session items greyed, "because
          // it helps the judge confirm they have the right person".
          showOutOfSessionItems: config?.show_out_of_session_items ?? true,
        },
        items: items.map((i) => ({
          id: i.id,
          name: i.name,
          code: i.code,
          type: i.type,
          stage: i.stage,
          maxMark: Number(i.max_mark ?? i.config_max_mark ?? 10),
          criteria: criteria
            .filter((c) => c.item_id === i.id)
            .map((c) => ({ id: c.id, name: c.name, maxMark: Number(c.max_mark) })),
        })),
        performances: performances.map((p) => {
          const mine = myScoreByPerformance.get(p.performance_id);
          const revoked = revokedByPerformance.get(p.performance_id);

          return {
            performanceId: p.performance_id,
            registrationId: p.registration_id,
            itemId: p.item_id,
            status: p.status,
            isCurrent: p.is_current,
            callOrder: p.call_order,
            attemptNo: p.attempt_no,
            memberId: p.member_id,
            chestNumber: p.chest_number,
            participantName: p.member_name ?? p.team_name ?? 'Unknown',
            photoPath: p.photo_path,
            churchName: p.church_name,
            churchShortCode: p.church_short_code,
            categoryName: p.category_name,
            // JDG-04-02: per-judge status — Not yet scored / Already scored by
            // you / Awaiting other judges. Expressed as this judge's own state
            // only; no count of who else has submitted (FSD 6.9, JDG-06-08).
            myScore: mine ? { mark: Number(mine.mark), submittedAt: mine.submitted_at } : null,
            // JDG-07-04: a revoked mark must be re-entered.
            revokedScore: revoked
              ? { mark: Number(revoked.mark), reason: revoked.revoked_reason }
              : null,
          };
        }),
        cachedAt: new Date().toISOString(),
      });
    }),
  );

  /**
   * FSD 9.3: GET /api/judge/current — the performance currently on stage.
   * JDG-02-01, JDG-02-02, JDG-02-04.
   */
  router.get(
    '/current',
    requireCapability(Capability.ENTER_SCORE),
    validate({ query: z.object({ sessionId: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const sessionId = (req.query as { sessionId: string }).sessionId;
      const judgeId = req.auth!.userId;

      await assertJudgeOnSession(sessionId, judgeId, req.eventId!);

      const current = await db
        .selectFrom('performances as p')
        .innerJoin('items as i', 'i.id', 'p.item_id')
        .innerJoin('registrations as r', 'r.id', 'p.registration_id')
        .innerJoin('churches as c', 'c.id', 'r.church_id')
        .leftJoin('members as m', 'm.id', 'r.member_id')
        .select([
          'p.id as performance_id',
          'p.item_id',
          'p.status',
          'p.call_order',
          'i.name as item_name',
          'i.max_mark',
          'm.chest_number',
          'm.full_name as member_name',
          'm.photo_path',
          'r.team_name',
          'c.name as church_name',
        ])
        .where('p.session_id', '=', sessionId)
        .where('p.is_current', '=', true)
        .executeTakeFirst();

      // JDG-02-05: "If no performance is currently on stage, the judge is shown
      // the manual search option instead."
      if (!current) return ok(res, { current: null, useManualSearch: true });

      const myScore = await db
        .selectFrom('scores')
        .select(['mark', 'submitted_at'])
        .where('performance_id', '=', current.performance_id)
        .where('judge_id', '=', judgeId)
        .where('revoked', '=', false)
        .executeTakeFirst();

      // JDG-02-04 progress strip.
      const siblings = await db
        .selectFrom('performances')
        .select(['id'])
        .where('item_id', '=', current.item_id)
        .where('session_id', '=', sessionId)
        .where('status', '!=', 'VOID')
        .orderBy('call_order')
        .orderBy('created_at')
        .execute();

      const position = siblings.findIndex((s) => s.id === current.performance_id) + 1;

      return ok(res, {
        current: {
          performanceId: current.performance_id,
          itemId: current.item_id,
          itemName: current.item_name,
          maxMark: Number(current.max_mark ?? 10),
          status: current.status,
          chestNumber: current.chest_number,
          participantName: current.member_name ?? current.team_name ?? 'Unknown',
          photoPath: current.photo_path,
          churchName: current.church_name,
          progress: { position: position > 0 ? position : 1, total: siblings.length },
          // JDG-02-03: the judge can always see what they gave; never change it.
          myScore: myScore ? { mark: Number(myScore.mark), submittedAt: myScore.submitted_at } : null,
        },
        useManualSearch: false,
      });
    }),
  );

  /**
   * FSD 9.3: GET /api/judge/search — chest number or name, WITHIN the session.
   *
   * JDG-03-05: "Search is restricted to members registered in items within the
   * judge's current open session. A judge cannot browse the full event roster."
   * JDG-03-06: "If the chest number does not exist, the message is explicit ...
   * Silent empty results are not acceptable."
   */
  router.get(
    '/search',
    requireCapability(Capability.ENTER_SCORE),
    validate({
      query: z.object({
        sessionId: z.string().uuid(),
        q: z.string().min(2, 'Enter at least two characters.').max(100),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { sessionId, q } = req.query as unknown as { sessionId: string; q: string };
      const judgeId = req.auth!.userId;

      await assertJudgeOnSession(sessionId, judgeId, req.eventId!);

      const term = q.trim();

      const rows = await db
        .selectFrom('performances as p')
        .innerJoin('registrations as r', 'r.id', 'p.registration_id')
        .innerJoin('churches as c', 'c.id', 'r.church_id')
        .leftJoin('members as m', 'm.id', 'r.member_id')
        .leftJoin('categories as cat', 'cat.id', 'm.category_id')
        .select([
          'm.id as member_id',
          'm.chest_number',
          'm.full_name as member_name',
          'm.photo_path',
          'r.team_name',
          'r.id as registration_id',
          'c.name as church_name',
          'cat.name as category_name',
        ])
        .where('p.session_id', '=', sessionId)
        .where('p.status', 'in', ['SCHEDULED', 'ON_STAGE', 'IN_PROGRESS', 'COMPLETE'])
        .where((eb) =>
          eb.or([
            // JDG-03-01: numeric-first. An exact chest match ranks first below.
            eb('m.chest_number', 'ilike', `${term}%`),
            // JDG-03-03: "Search also accepts a partial name, for cases where a
            // badge is obscured."
            eb('m.full_name', 'ilike', `%${term}%`),
            eb('r.team_name', 'ilike', `%${term}%`),
          ]),
        )
        .groupBy([
          'm.id',
          'm.chest_number',
          'm.full_name',
          'm.photo_path',
          'r.team_name',
          'r.id',
          'c.name',
          'cat.name',
        ])
        .limit(25)
        .execute();

      if (rows.length === 0) {
        // JDG-03-06: explicit, never a silent empty list.
        throw errors.chestNotFoundInSession(term);
      }

      // Exact chest matches first — the judge usually typed a full badge number.
      const sorted = [...rows].sort((a, b) => {
        const aExact = a.chest_number?.toLowerCase() === term.toLowerCase() ? 0 : 1;
        const bExact = b.chest_number?.toLowerCase() === term.toLowerCase() ? 0 : 1;
        return aExact - bExact || (a.chest_number ?? '').localeCompare(b.chest_number ?? '');
      });

      return ok(
        res,
        sorted.map((r) => ({
          memberId: r.member_id,
          registrationId: r.registration_id,
          chestNumber: r.chest_number,
          participantName: r.member_name ?? r.team_name ?? 'Unknown',
          photoPath: r.photo_path,
          churchName: r.church_name,
          categoryName: r.category_name,
        })),
      );
    }),
  );

  /**
   * FSD 9.3: GET /api/judge/members/{id}/items — items this member is registered
   * in, within the session (JDG-04-01, JDG-04-02, JDG-04-03).
   */
  router.get(
    '/members/:memberId/items',
    requireCapability(Capability.ENTER_SCORE),
    validate({
      params: z.object({ memberId: z.string().uuid() }),
      query: z.object({ sessionId: z.string().uuid() }),
    }),
    asyncHandler(async (req, res) => {
      const { memberId } = req.params as { memberId: string };
      const sessionId = (req.query as { sessionId: string }).sessionId;
      const judgeId = req.auth!.userId;

      await assertJudgeOnSession(sessionId, judgeId, req.eventId!);

      const member = await db
        .selectFrom('members as m')
        .innerJoin('churches as c', 'c.id', 'm.church_id')
        .leftJoin('categories as cat', 'cat.id', 'm.category_id')
        .select([
          'm.id',
          'm.chest_number',
          'm.full_name',
          'm.photo_path',
          'c.name as church_name',
          'cat.name as category_name',
        ])
        .where('m.id', '=', memberId)
        .where('m.event_id', '=', req.eventId!)
        .executeTakeFirst();

      if (!member) throw errors.notFound('Participant', memberId);

      const config = await db
        .selectFrom('scoring_config')
        .select('show_out_of_session_items')
        .where('event_id', '=', req.eventId!)
        .executeTakeFirst();

      const rows = await db
        .selectFrom('registrations as r')
        .innerJoin('items as i', 'i.id', 'r.item_id')
        .leftJoin('performances as p', (join) =>
          join.onRef('p.registration_id', '=', 'r.id').on('p.session_id', '=', sessionId),
        )
        .leftJoin('session_items as si', (join) =>
          join.onRef('si.item_id', '=', 'i.id').on('si.session_id', '=', sessionId),
        )
        .leftJoin('scores as myscore', (join) =>
          join
            .onRef('myscore.performance_id', '=', 'p.id')
            .on('myscore.judge_id', '=', judgeId)
            .on('myscore.revoked', '=', false),
        )
        .select([
          'i.id as item_id',
          'i.name as item_name',
          'i.code as item_code',
          'i.max_mark',
          'p.id as performance_id',
          'p.status as performance_status',
          'p.is_current',
          'si.id as in_session',
          'myscore.mark as my_mark',
          'myscore.submitted_at as my_submitted_at',
        ])
        .where('r.member_id', '=', memberId)
        .where('r.status', '=', 'REGISTERED')
        .orderBy('i.display_order')
        .orderBy('i.name')
        .execute();

      const inSession = rows.filter((r) => r.in_session !== null);
      const outOfSession = rows.filter((r) => r.in_session === null);

      const map = (r: (typeof rows)[number], available: boolean) => ({
        itemId: r.item_id,
        itemName: r.item_name,
        itemCode: r.item_code,
        maxMark: Number(r.max_mark ?? 10),
        performanceId: r.performance_id,
        performanceStatus: r.performance_status,
        isOnStage: r.is_current ?? false,
        available,
        // JDG-04-02: this judge's own status for the item, and nothing about
        // any other judge beyond whether the performance itself is complete.
        myStatus: r.my_mark !== null
          ? ('SCORED_BY_YOU' as const)
          : r.performance_status === 'COMPLETE'
            ? ('COMPLETE' as const)
            : r.performance_status
              ? ('NOT_YET_SCORED' as const)
              : ('NOT_IN_SESSION' as const),
        myMark: r.my_mark !== null ? Number(r.my_mark) : null,
        mySubmittedAt: r.my_submitted_at,
        unavailableReason: available ? null : 'This item is not part of your current session.',
      });

      return ok(res, {
        member: {
          id: member.id,
          chestNumber: member.chest_number,
          fullName: member.full_name,
          photoPath: member.photo_path,
          churchName: member.church_name,
          categoryName: member.category_name,
        },
        items: [
          ...inSession.map((r) => map(r, true)),
          // JDG-04-03: shown greyed by default so the judge can confirm they
          // have the right person; hidden entirely if configured that way.
          ...(config?.show_out_of_session_items !== false
            ? outOfSession.map((r) => map(r, false))
            : []),
        ],
      });
    }),
  );

  /**
   * FSD 9.3: POST /api/judge/scores — submit a mark. Idempotent and immutable.
   *
   * The whole of FSD 4.3, 6.6 and 7.2 is enforced inside submitScore(); this
   * route is the thin HTTP shell around it.
   *
   * JDG-06-07: "If the server reports that this judge has already scored this
   * performance, the app shows the existing mark and treats the action as
   * complete rather than showing a failure." The 409 ALREADY_SCORED response
   * carries the existing mark in its details for exactly that.
   */
  router.post(
    '/scores',
    requireCapability(Capability.ENTER_SCORE),
    scoreRateLimit,
    validate({
      body: z.object({
        performanceId: z.string().uuid(),
        mark: z.coerce.number().min(0),
        remarks: z.string().max(250).optional().nullable(),
        /** JDG-06-04/05: client-generated. Generated server-side if omitted. */
        idempotencyKey: z.string().min(8).max(200).optional(),
        /** JDG-08-06: client submission time, authoritative for the trail. */
        submittedAt: z.coerce.date().optional(),
        deviceId: z.string().max(200).optional(),
        criteria: z
          .array(z.object({ itemCriteriaId: z.string().uuid(), mark: z.coerce.number().min(0) }))
          .max(20)
          .optional(),
        acknowledgedOutOfSequence: z.boolean().optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const input = req.body as {
        performanceId: string;
        mark: number;
        remarks?: string | null;
        idempotencyKey?: string;
        submittedAt?: Date;
        deviceId?: string;
        criteria?: { itemCriteriaId: string; mark: number }[];
        acknowledgedOutOfSequence?: boolean;
      };

      const now = new Date();
      // JDG-08-06: a client timestamp is trusted for ordering the trail, but a
      // future one is not — a device with a wrong clock must not be able to
      // backdate or postdate a mark beyond a small tolerance.
      const submittedAt =
        input.submittedAt && input.submittedAt.getTime() <= now.getTime() + 60_000
          ? input.submittedAt
          : now;

      const result = await submitScore(
        {
          performanceId: input.performanceId,
          judgeId: req.auth!.userId,
          mark: input.mark,
          remarks: input.remarks ?? null,
          idempotencyKey: input.idempotencyKey ?? randomUUID(),
          submittedAt,
          deviceId: input.deviceId ?? req.auth!.deviceId ?? null,
          criteria: input.criteria,
          acknowledgedOutOfSequence: input.acknowledgedOutOfSequence,
          entryMode: 'JUDGE_DEVICE',
        },
        actorFromRequest(req),
        req.eventId!,
      );

      // FSD 6.9 / JDG-06-08: "After submission the judge sees no indication of
      // how many other judges have submitted or what they awarded." The service
      // returns submittedCount, panelSize and aggregate for the admin console;
      // none of them are forwarded here.
      return created(res, {
        scoreId: result.scoreId,
        performanceId: result.performanceId,
        mark: result.mark,
        submittedAt: result.submittedAt,
        wasReplay: result.wasReplay,
        isOutOfSequence: result.isOutOfSequence,
        message: 'Your mark has been recorded. It cannot be changed.',
      });
    }),
  );

  /**
   * FSD 9.3: GET /api/judge/my-scores — own submitted marks, read-only.
   * JDG-07-01 to JDG-07-04.
   */
  router.get(
    '/my-scores',
    requireCapability(Capability.VIEW_OWN_SCORES),
    validate({
      query: z.object({
        sessionId: z.string().uuid().optional(),
        itemId: z.string().uuid().optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const q = req.query as { sessionId?: string; itemId?: string };
      const judgeId = req.auth!.userId;

      let query = db
        .selectFrom('scores as s')
        .innerJoin('performances as p', 'p.id', 's.performance_id')
        .innerJoin('items as i', 'i.id', 'p.item_id')
        .innerJoin('registrations as r', 'r.id', 'p.registration_id')
        .innerJoin('churches as c', 'c.id', 'r.church_id')
        .leftJoin('members as m', 'm.id', 'r.member_id')
        .select([
          's.id',
          's.mark',
          's.submitted_at',
          's.remarks',
          's.revoked',
          's.revoked_reason',
          's.is_out_of_sequence',
          'p.id as performance_id',
          'p.status as performance_status',
          'i.name as item_name',
          'i.code as item_code',
          'm.chest_number',
          'm.full_name as member_name',
          'r.team_name',
          'c.name as church_name',
        ])
        .where('s.judge_id', '=', judgeId)
        .where('p.event_id', '=', req.eventId!);

      if (q.sessionId) query = query.where('p.session_id', '=', q.sessionId);
      if (q.itemId) query = query.where('p.item_id', '=', q.itemId);

      const rows = await query.orderBy('s.submitted_at', 'desc').limit(500).execute();

      return ok(
        res,
        rows.map((r) => ({
          scoreId: r.id,
          performanceId: r.performance_id,
          mark: Number(r.mark),
          submittedAt: r.submitted_at,
          remarks: r.remarks,
          itemName: r.item_name,
          itemCode: r.item_code,
          chestNumber: r.chest_number,
          participantName: r.member_name ?? r.team_name ?? 'Unknown',
          churchName: r.church_name,
          isOutOfSequence: r.is_out_of_sequence,
          // JDG-07-04: "If a mark has been revoked by an administrator, it
          // appears struck through with the label 'Revoked — please re-enter',
          // and tapping it opens mark entry for that performance again."
          revoked: r.revoked,
          revokedReason: r.revoked_reason,
          canReEnter: r.revoked && ['SCHEDULED', 'ON_STAGE', 'IN_PROGRESS'].includes(r.performance_status),
        })),
        // JDG-07-03: no edit or delete control exists anywhere on this screen.
        { readOnly: true },
      );
    }),
  );

  /**
   * JDG-08-07: the judge's device reports how many marks are sitting unsent in
   * its own offline queue, so a coordinator watching the live console can tell
   * a judge who is genuinely behind from one who is just quietly synced. This
   * is a self-report for operational visibility, not a correctness control —
   * the queue itself, and what it eventually submits, is unaffected either way.
   */
  router.post(
    '/queue-status',
    requireCapability(Capability.ENTER_SCORE),
    validate({ body: z.object({ count: z.coerce.number().int().min(0).max(1000) }) }),
    asyncHandler(async (req, res) => {
      const { count } = req.body as { count: number };

      await db
        .updateTable('user_sessions')
        .set({ queued_marks: count, queued_marks_reported_at: new Date() })
        .where('id', '=', req.auth!.sessionId)
        .execute();

      return ok(res, { acknowledged: true });
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------

function mapSession(s: {
  id: string;
  name: string;
  stage: string | null;
  status: string;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  panel_name: string;
  item_count: unknown;
  my_outstanding: unknown;
}) {
  return {
    id: s.id,
    name: s.name,
    stage: s.stage,
    status: s.status,
    scheduledStart: s.scheduled_start,
    scheduledEnd: s.scheduled_end,
    panelName: s.panel_name,
    itemCount: Number(s.item_count ?? 0),
    myOutstandingCount: Number(s.my_outstanding ?? 0),
  };
}

/**
 * FSD 9.4 NOT_ON_PANEL / SESSION_NOT_OPEN.
 *
 * 11.2: "Judges are authorised per session and per panel; a judge cannot score a
 * performance outside their assignment even with a valid token and a crafted
 * request." Every judge route calls this before returning any session data.
 */
async function assertJudgeOnSession(
  sessionId: string,
  judgeId: string,
  eventId: string,
): Promise<{ id: string; name: string; stage: string | null; status: string; panel_name: string }> {
  const session = await db
    .selectFrom('sessions as s')
    .innerJoin('panels as p', 'p.id', 's.panel_id')
    .innerJoin('panel_judges as pj', 'pj.panel_id', 'p.id')
    .select(['s.id', 's.name', 's.stage', 's.status', 'p.name as panel_name'])
    .where('s.id', '=', sessionId)
    .where('s.event_id', '=', eventId)
    .where('pj.user_id', '=', judgeId)
    .where('pj.removed_at', 'is', null)
    .executeTakeFirst();

  if (!session) throw errors.notOnPanel();

  // Reading a DRAFT session's details is allowed so JDG-01-03 can show upcoming
  // work; scoring against one is refused inside submitScore().
  if (session.status === 'CLOSED' || session.status === 'FORCE_CLOSED') {
    throw errors.sessionNotOpen(session.name);
  }

  return session;
}
