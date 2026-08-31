/**
 * User account management (FSD 5.1.2, 5.7).
 *
 * ADM-01-10: "Only Super Admin and Admin can create user accounts. There is no
 * public registration route anywhere in the application."
 * ADM-01-12: "Users are deactivated, never hard-deleted, so that historical
 * scores remain attributable." There is accordingly no DELETE route here.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import {
  Capability,
  assertCanResetPasswordFor,
  assertNotLastSuperAdmin,
  requireCapability,
} from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import {
  AuditAction,
  actorFromRequest,
  auditDiff,
  auditSnapshot,
  writeAudit,
} from '../../services/audit.js';
import {
  checkPasswordPolicy,
  generateTemporaryPassword,
  hashPassword,
} from '../../services/auth/password.js';
import { errors } from '../../utils/errors.js';
import { asyncHandler, created, ok, pageParams, paginated } from '../../utils/http.js';

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'JUDGE', 'COORDINATOR'] as const;

const createUserSchema = z.object({
  fullName: z.string().min(2).max(200),
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dots, underscores or hyphens only.'),
  email: z.string().email().max(200).optional().nullable(),
  role: z.enum(ROLES),
  mobile: z.string().max(40).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  /** Omit to have one generated and returned once (ADM-01-06 out-of-band handover). */
  temporaryPassword: z.string().min(8).max(128).optional(),
  /** ADM-07-03: conflict-of-interest link for judges. */
  affiliatedChurchId: z.string().uuid().optional().nullable(),
  /** ADM-01-08 */
  devicePinEnabled: z.boolean().optional(),
  /** FSD 3.2 "Configurable" cell — Super Admin only, ignored for other roles. */
  canRevokeScores: z.boolean().optional(),
});

const updateUserSchema = createUserSchema
  .omit({ username: true, temporaryPassword: true, role: true })
  .partial()
  .extend({ isActive: z.boolean().optional() });

const listQuerySchema = z.object({
  search: z.string().max(200).optional(),
  role: z.enum(ROLES).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

export function userRoutes(): Router {
  const router = Router();

  /**
   * ADM-01-14: "The user list supports search by name, filter by role and filter
   * by active status."
   * ADM-07-04: for judges, the list shows submitted counts and outstanding marks —
   * "the fastest way to identify the judge holding up an item."
   */
  router.get(
    '/',
    requireCapability(Capability.MANAGE_JUDGE_ACCOUNTS),
    validate({ query: listQuerySchema }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof listQuerySchema>;
      const { page, pageSize, offset } = pageParams(req.query as Record<string, unknown>);

      let base = db.selectFrom('users as u');
      if (q.search) base = base.where((eb) =>
        eb.or([eb('u.full_name', 'ilike', `%${q.search}%`), eb('u.username', 'ilike', `%${q.search}%`)]),
      );
      if (q.role) base = base.where('u.role', '=', q.role);
      if (q.isActive) base = base.where('u.is_active', '=', q.isActive === 'true');

      const [rows, total] = await Promise.all([
        base
          .leftJoin('churches as c', 'c.id', 'u.affiliated_church_id')
          .select([
            'u.id',
            'u.username',
            'u.email',
            'u.full_name',
            'u.role',
            'u.mobile',
            'u.is_active',
            'u.must_change_password',
            'u.last_login_at',
            'u.locked_until',
            'u.device_pin_enabled',
            'u.device_pin',
            'u.can_revoke_scores',
            'u.affiliated_church_id',
            'c.name as affiliated_church_name',
          ])
          .orderBy('u.role')
          .orderBy('u.full_name')
          .limit(pageSize)
          .offset(offset)
          .execute(),
        base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
      ]);

      // ADM-07-04 activity figures, fetched in one pass for the judges on this page.
      const judgeIds = rows.filter((r) => r.role === 'JUDGE').map((r) => r.id);
      const activity =
        judgeIds.length > 0
          ? await db
              .selectFrom('v_judge_activity')
              .select(['judge_id', 'scores_submitted', 'scores_revoked', 'mean_deviation'])
              .where('judge_id', 'in', judgeIds)
              .execute()
          : [];

      const outstanding =
        judgeIds.length > 0
          ? await db
              .selectFrom('performance_judges as pj')
              .innerJoin('performances as p', 'p.id', 'pj.performance_id')
              .select((eb) => ['pj.judge_id', eb.fn.countAll<number>().as('outstanding')])
              .where('pj.judge_id', 'in', judgeIds)
              .where('p.status', 'in', ['SCHEDULED', 'ON_STAGE', 'IN_PROGRESS'])
              .where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('scores as s')
                      .select('s.id')
                      .whereRef('s.performance_id', '=', 'pj.performance_id')
                      .whereRef('s.judge_id', '=', 'pj.judge_id')
                      .where('s.revoked', '=', false),
                  ),
                ),
              )
              .groupBy('pj.judge_id')
              .execute()
          : [];

      const activityById = new Map(activity.map((a) => [a.judge_id, a]));
      const outstandingById = new Map(outstanding.map((o) => [o.judge_id, Number(o.outstanding)]));

      return paginated(
        res,
        rows.map((row) => ({
          id: row.id,
          username: row.username,
          email: row.email,
          fullName: row.full_name,
          role: row.role,
          mobile: row.mobile,
          isActive: row.is_active,
          mustChangePassword: row.must_change_password,
          lastLoginAt: row.last_login_at,
          isLocked: row.locked_until !== null && row.locked_until.getTime() > Date.now(),
          lockedUntil: row.locked_until,
          devicePinEnabled: row.device_pin_enabled,
          devicePinned: Boolean(row.device_pin),
          canRevokeScores: row.can_revoke_scores,
          affiliatedChurchId: row.affiliated_church_id,
          affiliatedChurchName: row.affiliated_church_name,
          scoresSubmitted: Number(activityById.get(row.id)?.scores_submitted ?? 0),
          scoresRevoked: Number(activityById.get(row.id)?.scores_revoked ?? 0),
          meanDeviation: activityById.get(row.id)?.mean_deviation ?? null,
          outstandingMarks: outstandingById.get(row.id) ?? 0,
        })),
        page,
        pageSize,
        Number(total.count),
      );
    }),
  );

  /**
   * ADM-01-11: "Creating a user captures: full name, username, temporary
   * password, role, mobile number (optional), and active flag."
   *
   * The temporary password is returned in the response EXACTLY ONCE and is never
   * stored in plain text or logged (ADM-01-03). ADM-01-06 makes handing it over
   * a deliberate human step, so the administrator must capture it here.
   */
  router.post(
    '/',
    requireCapability(Capability.MANAGE_JUDGE_ACCOUNTS),
    validate({ body: createUserSchema }),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof createUserSchema>;
      const actor = actorFromRequest(req);
      if (!req.auth) throw errors.unauthenticated();

      // Creating an ADMIN or SUPER_ADMIN needs the stronger capability.
      if (input.role === 'ADMIN' || input.role === 'SUPER_ADMIN') {
        if (req.auth.role !== 'SUPER_ADMIN') {
          throw errors.forbidden('Only a Super Admin may create administrator accounts (FSD 3.2).');
        }
      }
      if (input.canRevokeScores && req.auth.role !== 'SUPER_ADMIN') {
        throw errors.forbidden('Only a Super Admin may grant the score-revocation permission.');
      }

      const temporaryPassword = input.temporaryPassword ?? generateTemporaryPassword();
      const policy = checkPasswordPolicy(temporaryPassword);
      if (!policy.valid) {
        throw errors.validation(`The temporary password is not acceptable. ${policy.problems.join(' ')}`);
      }

      const user = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('users')
          .values({
            username: input.username,
            email: input.email ?? null,
            password_hash: await hashPassword(temporaryPassword),
            full_name: input.fullName,
            role: input.role,
            mobile: input.mobile ?? null,
            notes: input.notes ?? null,
            affiliated_church_id: input.affiliatedChurchId ?? null,
            device_pin_enabled: input.devicePinEnabled ?? false,
            can_revoke_scores: input.canRevokeScores ?? false,
            // ADM-01-05: always true for a newly issued account.
            must_change_password: true,
            created_by: req.auth!.userId,
            updated_by: req.auth!.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          {
            actor,
            action: AuditAction.CREATED,
            entityType: 'user',
            entityId: row.id,
            newValue: auditSnapshot(row),
          },
          trx,
        );

        return row;
      });

      return created(res, {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
        isActive: user.is_active,
        // Shown once. ADM-01-03 forbids storing or emailing it.
        temporaryPassword,
        handoverNote:
          'Give this password to the user directly. It is shown only now and cannot be retrieved again. They must change it at first sign-in.',
      });
    }),
  );

  /** ADM-01-11 field updates and ADM-01-12 deactivation. */
  router.patch(
    '/:id',
    requireCapability(Capability.MANAGE_JUDGE_ACCOUNTS),
    validate({ params: z.object({ id: z.string().uuid() }), body: updateUserSchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const input = req.body as z.infer<typeof updateUserSchema>;
      if (!req.auth) throw errors.unauthenticated();

      const before = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
      if (!before) throw errors.notFound('User', id);

      if (
        (before.role === 'ADMIN' || before.role === 'SUPER_ADMIN') &&
        req.auth.role !== 'SUPER_ADMIN'
      ) {
        throw errors.forbidden('Only a Super Admin may edit administrator accounts (FSD 3.2).');
      }
      if (input.canRevokeScores !== undefined && req.auth.role !== 'SUPER_ADMIN') {
        throw errors.forbidden('Only a Super Admin may change the score-revocation permission.');
      }

      // FSD 3.1: the last Super Admin cannot be removed from service.
      if (input.isActive === false) {
        await assertNotLastSuperAdmin(id);
      }

      // ADM-01-13: "Deactivating a judge who has open unsubmitted assignments
      // raises a warning listing the affected sessions."
      let warning: { message: string; sessions: { id: string; name: string; pending: number }[] } | undefined;
      if (input.isActive === false && (before.role === 'JUDGE' || before.role === 'COORDINATOR')) {
        const openWork = await db
          .selectFrom('performance_judges as pj')
          .innerJoin('performances as p', 'p.id', 'pj.performance_id')
          .innerJoin('sessions as s', 's.id', 'p.session_id')
          .select((eb) => ['s.id', 's.name', eb.fn.countAll<number>().as('pending')])
          .where('pj.judge_id', '=', id)
          .where('p.status', 'in', ['SCHEDULED', 'ON_STAGE', 'IN_PROGRESS'])
          .where('s.status', '=', 'OPEN')
          .groupBy(['s.id', 's.name'])
          .execute();

        if (openWork.length > 0) {
          warning = {
            message:
              'This judge still has performances awaiting their mark in open sessions. Replace them on the panel before closing those sessions (FSD ADM-01-13, ADM-08-06).',
            sessions: openWork.map((w) => ({ id: w.id, name: w.name, pending: Number(w.pending) })),
          };
        }
      }

      const after = await db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable('users')
          .set({
            ...(input.fullName !== undefined ? { full_name: input.fullName } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            ...(input.affiliatedChurchId !== undefined
              ? { affiliated_church_id: input.affiliatedChurchId }
              : {}),
            ...(input.devicePinEnabled !== undefined
              ? { device_pin_enabled: input.devicePinEnabled }
              : {}),
            ...(input.canRevokeScores !== undefined
              ? { can_revoke_scores: input.canRevokeScores }
              : {}),
            ...(input.isActive !== undefined
              ? { is_active: input.isActive, deactivated_at: input.isActive ? null : new Date() }
              : {}),
            updated_by: req.auth!.userId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        const diff = auditDiff(before, row);
        await writeAudit(
          {
            actor: actorFromRequest(req),
            action:
              input.isActive === false
                ? AuditAction.DEACTIVATED
                : input.isActive === true
                  ? AuditAction.REACTIVATED
                  : AuditAction.UPDATED,
            entityType: 'user',
            entityId: id,
            oldValue: diff.old,
            newValue: diff.new,
          },
          trx,
        );

        // Deactivation ends every live session immediately (ADM-07-05 spirit).
        if (input.isActive === false) {
          await trx
            .updateTable('user_sessions')
            .set({ revoked_at: new Date(), revoked_reason: 'Account deactivated' })
            .where('user_id', '=', id)
            .where('revoked_at', 'is', null)
            .execute();
        }

        return row;
      });

      return ok(res, {
        id: after.id,
        fullName: after.full_name,
        isActive: after.is_active,
        ...(warning ? { warning } : {}),
      });
    }),
  );

  /**
   * ADM-01-06 / FSD 3.2: reset another user's password.
   * An Admin may reset judges and coordinators only; a Super Admin may reset anyone.
   */
  router.post(
    '/:id/reset-password',
    requireCapability(Capability.RESET_PASSWORD),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ temporaryPassword: z.string().min(8).max(128).optional() }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      if (!req.auth) throw errors.unauthenticated();

      const target = await db
        .selectFrom('users')
        .select(['id', 'role', 'full_name', 'username'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!target) throw errors.notFound('User', id);

      assertCanResetPasswordFor(req.auth.role, target.role);

      const temporaryPassword =
        (req.body as { temporaryPassword?: string }).temporaryPassword ?? generateTemporaryPassword();
      const policy = checkPasswordPolicy(temporaryPassword);
      if (!policy.valid) {
        throw errors.validation(`That password is not acceptable. ${policy.problems.join(' ')}`);
      }

      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('users')
          .set({
            password_hash: await hashPassword(temporaryPassword),
            must_change_password: true,
            failed_attempts: 0,
            locked_until: null,
            updated_by: req.auth!.userId,
          })
          .where('id', '=', id)
          .execute();

        // Every existing session is ended: a reset means the old credential is
        // no longer trusted.
        await trx
          .updateTable('user_sessions')
          .set({ revoked_at: new Date(), revoked_reason: 'Password reset by administrator' })
          .where('user_id', '=', id)
          .where('revoked_at', 'is', null)
          .execute();

        await writeAudit(
          {
            actor: actorFromRequest(req),
            action: AuditAction.PASSWORD_RESET,
            entityType: 'user',
            entityId: id,
            reason: `Password reset for ${target.username} by ${req.auth!.username}.`,
          },
          trx,
        );
      });

      return ok(res, {
        userId: id,
        username: target.username,
        fullName: target.full_name,
        temporaryPassword,
        handoverNote:
          'Give this password to the user directly. It is shown only now. They must change it at next sign-in, and all their devices have been signed out.',
      });
    }),
  );

  /**
   * ADM-07-05: "Force logout: an administrator can terminate a judge's session,
   * for example when a device is lost or handed to a different person."
   */
  router.post(
    '/:id/force-logout',
    requireCapability(Capability.MANAGE_JUDGE_ACCOUNTS),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ reason: z.string().max(500).optional() }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      const reason = (req.body as { reason?: string }).reason ?? 'Force logout by administrator';
      if (!req.auth) throw errors.unauthenticated();

      const result = await db
        .updateTable('user_sessions')
        .set({ revoked_at: new Date(), revoked_by: req.auth.userId, revoked_reason: reason })
        .where('user_id', '=', id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();

      await writeAudit({
        actor: actorFromRequest(req),
        action: AuditAction.SESSION_FORCE_REVOKED,
        entityType: 'user',
        entityId: id,
        reason,
      });

      return ok(res, { sessionsEnded: Number(result.numUpdatedRows) });
    }),
  );

  /** ADM-01-08: release a device pin so the account can sign in elsewhere. */
  router.post(
    '/:id/release-device-pin',
    requireCapability(Capability.MANAGE_JUDGE_ACCOUNTS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      await db.updateTable('users').set({ device_pin: null }).where('id', '=', id).execute();

      await writeAudit({
        actor: actorFromRequest(req),
        action: AuditAction.DEVICE_PIN_RELEASED,
        entityType: 'user',
        entityId: id,
        reason: 'Device lock released so the account can sign in on a different device.',
      });

      return ok(res, { released: true });
    }),
  );

  /** Unlock an account locked by ADM-01-04 before the window elapses. */
  router.post(
    '/:id/unlock',
    requireCapability(Capability.MANAGE_JUDGE_ACCOUNTS),
    validate({ params: z.object({ id: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };

      await db
        .updateTable('users')
        .set({ failed_attempts: 0, locked_until: null })
        .where('id', '=', id)
        .execute();

      await writeAudit({
        actor: actorFromRequest(req),
        action: AuditAction.UPDATED,
        entityType: 'user',
        entityId: id,
        reason: 'Account unlocked by administrator after failed sign-in attempts.',
      });

      return ok(res, { unlocked: true });
    }),
  );

  return router;
}
