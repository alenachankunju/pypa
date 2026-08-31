/**
 * Role-based authorisation — a direct encoding of the FSD 3.2 permission matrix.
 *
 * FSD 3.2: "This matrix is the authoritative source for server-side
 * authorisation checks; the user interface hides unavailable actions but the
 * server must enforce them independently."
 *
 * The matrix is therefore declared once, as data, and every protected route
 * names a capability rather than listing roles inline. Adding a role to a route
 * by hand is the mistake this structure is designed to prevent — AC-02 and
 * AC-06 both fail if one route disagrees with the matrix.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { db } from '../db/pool.js';
import type { UserRole } from '../db/schema.js';
import { errors } from '../utils/errors.js';

/** One capability row from the FSD 3.2 matrix. */
export const Capability = {
  MANAGE_ADMIN_ACCOUNTS: 'MANAGE_ADMIN_ACCOUNTS',
  MANAGE_JUDGE_ACCOUNTS: 'MANAGE_JUDGE_ACCOUNTS',
  RESET_PASSWORD: 'RESET_PASSWORD',
  MANAGE_CHURCHES: 'MANAGE_CHURCHES',
  MANAGE_CATEGORIES: 'MANAGE_CATEGORIES',
  MANAGE_ITEMS: 'MANAGE_ITEMS',
  MANAGE_MEMBERS: 'MANAGE_MEMBERS',
  MANAGE_REGISTRATIONS: 'MANAGE_REGISTRATIONS',
  MANAGE_PANELS: 'MANAGE_PANELS',
  MANAGE_SESSIONS: 'MANAGE_SESSIONS',
  CONTROL_STAGE: 'CONTROL_STAGE',
  MARK_ABSENT: 'MARK_ABSENT',
  ENTER_SCORE: 'ENTER_SCORE',
  BACK_ENTER_SCORE: 'BACK_ENTER_SCORE',
  VIEW_OWN_SCORES: 'VIEW_OWN_SCORES',
  VIEW_ALL_SCORES: 'VIEW_ALL_SCORES',
  VIEW_SCORE_PROGRESS: 'VIEW_SCORE_PROGRESS',
  REVOKE_SCORE: 'REVOKE_SCORE',
  CONFIGURE_SCORING: 'CONFIGURE_SCORING',
  VIEW_PROVISIONAL_RESULTS: 'VIEW_PROVISIONAL_RESULTS',
  PUBLISH_RESULTS: 'PUBLISH_RESULTS',
  EXPORT_REPORTS: 'EXPORT_REPORTS',
  VIEW_AUDIT_LOG: 'VIEW_AUDIT_LOG',
  BACKUP_RESTORE: 'BACKUP_RESTORE',
  MANAGE_SETTINGS: 'MANAGE_SETTINGS',
} as const;

export type CapabilityValue = (typeof Capability)[keyof typeof Capability];

/**
 * Roles that hold each capability outright.
 *
 * Transcribed cell by cell from FSD 3.2. A dash in the document is an absence
 * here; "Configurable" and "View count only" are handled as special cases below,
 * because they are not simple grants.
 */
const MATRIX: Record<CapabilityValue, UserRole[]> = {
  // Create / edit / deactivate admin accounts — Super Admin only.
  [Capability.MANAGE_ADMIN_ACCOUNTS]: ['SUPER_ADMIN'],
  // Create / edit / deactivate judge accounts.
  [Capability.MANAGE_JUDGE_ACCOUNTS]: ['SUPER_ADMIN', 'ADMIN'],
  // Reset another user's password. Admin is limited to judges — enforced by
  // assertCanResetPasswordFor() below, which the users module calls.
  [Capability.RESET_PASSWORD]: ['SUPER_ADMIN', 'ADMIN'],

  [Capability.MANAGE_CHURCHES]: ['SUPER_ADMIN', 'ADMIN'],
  [Capability.MANAGE_CATEGORIES]: ['SUPER_ADMIN', 'ADMIN'],
  [Capability.MANAGE_ITEMS]: ['SUPER_ADMIN', 'ADMIN'],
  [Capability.MANAGE_MEMBERS]: ['SUPER_ADMIN', 'ADMIN'],
  [Capability.MANAGE_REGISTRATIONS]: ['SUPER_ADMIN', 'ADMIN'],
  [Capability.MANAGE_PANELS]: ['SUPER_ADMIN', 'ADMIN'],

  // Open / close a judging session — coordinator included.
  [Capability.MANAGE_SESSIONS]: ['SUPER_ADMIN', 'ADMIN', 'COORDINATOR'],
  // Set the current performance on stage.
  [Capability.CONTROL_STAGE]: ['SUPER_ADMIN', 'ADMIN', 'COORDINATOR'],
  // Mark a participant absent.
  [Capability.MARK_ABSENT]: ['SUPER_ADMIN', 'ADMIN', 'COORDINATOR'],

  // Enter a score — JUDGE only. The matrix shows a dash for Super Admin and
  // Admin, and that is deliberate: scores must be attributable to the judge who
  // awarded them (FSD 3.1, "score attribution is the foundation of the audit
  // trail").
  [Capability.ENTER_SCORE]: ['JUDGE'],

  // Paper back-entry (FSD 11.4) is a separate, explicitly-recorded capability,
  // not a widening of ENTER_SCORE: "Marks captured on paper are entered
  // afterwards by an administrator through a dedicated back-entry screen that
  // records who entered them and why."
  [Capability.BACK_ENTER_SCORE]: ['SUPER_ADMIN', 'ADMIN'],

  [Capability.VIEW_OWN_SCORES]: ['JUDGE'],
  // View all scores for a performance. Coordinator is "View count only" and is
  // therefore absent here; see VIEW_SCORE_PROGRESS.
  [Capability.VIEW_ALL_SCORES]: ['SUPER_ADMIN', 'ADMIN'],
  // ADM-09-03: the coordinator sees Submitted / Waiting per judge, never marks.
  [Capability.VIEW_SCORE_PROGRESS]: ['SUPER_ADMIN', 'ADMIN', 'COORDINATOR'],

  // "Configurable" for Admin — see requireRevokeScore() below.
  [Capability.REVOKE_SCORE]: ['SUPER_ADMIN'],

  [Capability.CONFIGURE_SCORING]: ['SUPER_ADMIN'],
  [Capability.VIEW_PROVISIONAL_RESULTS]: ['SUPER_ADMIN', 'ADMIN'],
  [Capability.PUBLISH_RESULTS]: ['SUPER_ADMIN'],
  [Capability.EXPORT_REPORTS]: ['SUPER_ADMIN', 'ADMIN'],
  // Admin is "Read-only"; there is no write path to the audit log for anyone
  // (ADM-14-03), so read access is the whole capability.
  [Capability.VIEW_AUDIT_LOG]: ['SUPER_ADMIN', 'ADMIN'],
  [Capability.BACKUP_RESTORE]: ['SUPER_ADMIN'],
  [Capability.MANAGE_SETTINGS]: ['SUPER_ADMIN'],
};

export function roleHasCapability(role: UserRole, capability: CapabilityValue): boolean {
  return MATRIX[capability].includes(role);
}

/** All capabilities a role holds — used to drive the client's navigation. */
export function capabilitiesForRole(role: UserRole): CapabilityValue[] {
  return (Object.keys(MATRIX) as CapabilityValue[]).filter((c) => roleHasCapability(role, c));
}

/**
 * Require one capability. The workhorse guard for every protected route.
 */
export function requireCapability(...capabilities: CapabilityValue[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) return next(errors.unauthenticated());

    const granted = capabilities.every((c) => roleHasCapability(auth.role, c));
    if (!granted) {
      return next(
        errors.forbidden(
          'Your role does not permit this action. If you believe this is wrong, ask a Super Admin to check your account.',
        ),
      );
    }
    next();
  };
}

/** Require any one of several capabilities. */
export function requireAnyCapability(...capabilities: CapabilityValue[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) return next(errors.unauthenticated());
    if (capabilities.some((c) => roleHasCapability(auth.role, c))) return next();
    next(errors.forbidden('Your role does not permit this action.'));
  };
}

/** Require an exact role. Used sparingly — prefer a capability. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) return next(errors.unauthenticated());
    if (!roles.includes(auth.role)) {
      return next(errors.forbidden('Your role does not permit this action.'));
    }
    next();
  };
}

/**
 * ADM-01-02: "Judges cannot reach admin routes by URL manipulation; the server
 * rejects such requests with 403."
 *
 * Mounted in front of the whole /api/admin tree as a blunt second line of
 * defence, so a route added without its capability guard still cannot be reached
 * by a judge's token.
 */
export function denyJudges(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.auth?.role === 'JUDGE') {
      return next(errors.forbidden('This area is not available to judges.'));
    }
    next();
  };
}

/**
 * The "Configurable" cell: revoking a submitted score (FSD 3.2, ADM-10-01).
 *
 * A Super Admin always may. An Admin may only where a Super Admin has explicitly
 * granted it on their account (users.can_revoke_scores, migration 0012). Judges
 * and coordinators never may, in any configuration.
 */
export function requireRevokeScore(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = req.auth;
      if (!auth) throw errors.unauthenticated();

      if (auth.role === 'SUPER_ADMIN') return next();

      if (auth.role !== 'ADMIN') {
        throw errors.forbidden('Only a Super Admin, or an Admin who has been granted it, may revoke a score.');
      }

      const row = await db
        .selectFrom('users')
        .select('can_revoke_scores')
        .where('id', '=', auth.userId)
        .executeTakeFirst();

      if (!row?.can_revoke_scores) {
        throw errors.forbidden(
          'You have not been granted permission to revoke scores. A Super Admin can grant this on your account.',
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * FSD 3.2: "Reset another user's password — Super Admin: Yes; Admin: Yes (judges
 * only)."
 *
 * Called by the users module once the target's role is known, since the
 * restriction depends on who is being reset rather than on the route.
 */
export function assertCanResetPasswordFor(actorRole: UserRole, targetRole: UserRole): void {
  if (actorRole === 'SUPER_ADMIN') return;

  if (actorRole === 'ADMIN') {
    // "judges only" — read to include coordinators, who are the same class of
    // event-day account and whose credentials an admin must be able to reissue.
    if (targetRole === 'JUDGE' || targetRole === 'COORDINATOR') return;
    throw errors.forbidden(
      'Administrators may reset passwords for judges and coordinators only. Ask a Super Admin to reset an administrator account.',
    );
  }

  throw errors.forbidden('Your role does not permit resetting passwords.');
}

/**
 * FSD 3.1: the Super Admin account "Cannot be deleted while it is the only Super
 * Admin account." Deactivation is the deletion path here (ADM-01-12), so the
 * same protection applies to it.
 */
export async function assertNotLastSuperAdmin(userId: string): Promise<void> {
  const target = await db
    .selectFrom('users')
    .select(['role', 'is_active'])
    .where('id', '=', userId)
    .executeTakeFirst();

  if (!target || target.role !== 'SUPER_ADMIN') return;

  const { count } = await db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('role', '=', 'SUPER_ADMIN')
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  if (Number(count) <= 1) {
    throw errors.conflict(
      'This is the only active Super Admin account and cannot be deactivated. Create another Super Admin first.',
    );
  }
}
