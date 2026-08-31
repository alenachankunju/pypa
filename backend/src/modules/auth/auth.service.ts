/**
 * Authentication service (FSD 5.1).
 *
 * The whole of ADM-01 lives here: single login screen for every role, role-based
 * routing, argon2id hashing, lockout, forced password change, admin-only reset,
 * configurable session expiry and optional device pinning.
 *
 * There is deliberately NO registration function in this file, and no route that
 * reaches one. AC-02: "Only administrators can create users. No self-registration
 * route exists anywhere in the application or API." Account creation lives in the
 * users module behind the MANAGE_*_ACCOUNTS capability.
 */
import type { Request } from 'express';
import { db } from '../../db/pool.js';
import type { UserRole } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { AppError, ErrorCode, errors } from '../../utils/errors.js';
import { clientIp } from '../../utils/http.js';
import {
  checkPasswordPolicy,
  dummyVerify,
  hashPassword,
  verifyPassword,
} from '../../services/auth/password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiryForRole,
  refreshTtlHoursForRole,
  signAccessToken,
} from '../../services/auth/tokens.js';
import {
  AuditAction,
  anonymousActor,
  writeAudit,
  writeAuditSafe,
  type AuditActor,
} from '../../services/audit.js';
import { capabilitiesForRole } from '../../middleware/authorize.js';

export interface LoginInput {
  username: string;
  password: string;
  /** ADM-01-08: stable identifier generated and stored by the client. */
  deviceId?: string;
}

export interface AuthenticatedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshExpiresAt: string;
  user: {
    id: string;
    username: string;
    fullName: string;
    role: UserRole;
    mustChangePassword: boolean;
    capabilities: string[];
    /** ADM-01-02: where the client should land after signing in. */
    landingRoute: string;
  };
}

/**
 * ADM-01-01: "All users, regardless of role, log in through a single login
 * screen using username (or email) and password."
 */
export async function login(input: LoginInput, req: Request): Promise<AuthenticatedSession> {
  const identifier = input.username.trim();
  const ip = clientIp(req) ?? null;
  const userAgent = req.headers['user-agent'] ?? null;

  const user = await db
    .selectFrom('users')
    .selectAll()
    .where((eb) => eb.or([eb('username', '=', identifier), eb('email', '=', identifier)]))
    .executeTakeFirst();

  // ---------------------------------------------------------------------
  // Unknown username.
  //
  // A dummy argon2 verification runs before the refusal so a missing account
  // costs the same time as a wrong password. Without it, response latency alone
  // reveals which usernames exist — and the FSD's judge usernames are handed out
  // on paper, so an enumerable list is a real exposure.
  // ---------------------------------------------------------------------
  if (!user) {
    await dummyVerify(input.password);
    await recordAttempt(identifier, ip, userAgent, false, 'NO_SUCH_USER');
    writeAuditSafe({
      actor: anonymousActor(req, identifier),
      action: AuditAction.LOGIN_FAILED,
      entityType: 'user',
      reason: 'Unknown username',
    });
    throw new AppError(
      ErrorCode.INVALID_CREDENTIALS,
      'That username or password is not correct. Check with your administrator if you are unsure.',
    );
  }

  // ADM-01-04: the lock is checked before the password, so a locked account
  // cannot be probed for password correctness during the lockout window.
  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    const minutes = Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000);
    await recordAttempt(identifier, ip, userAgent, false, 'LOCKED');
    throw new AppError(
      ErrorCode.ACCOUNT_LOCKED,
      `This account is locked after too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask an administrator to reset it.`,
      { details: { lockedUntil: user.locked_until.toISOString() } },
    );
  }

  // ADM-01-12: a deactivated account cannot sign in, but its history remains.
  if (!user.is_active) {
    await recordAttempt(identifier, ip, userAgent, false, 'INACTIVE');
    throw new AppError(
      ErrorCode.ACCOUNT_INACTIVE,
      'This account has been deactivated. Please speak to your administrator.',
    );
  }

  const passwordValid = await verifyPassword(input.password, user.password_hash);

  if (!passwordValid) {
    await handleFailedAttempt(user.id, user.failed_attempts, identifier, ip, userAgent, req);
    throw new AppError(
      ErrorCode.INVALID_CREDENTIALS,
      'That username or password is not correct. Check with your administrator if you are unsure.',
    );
  }

  // ---------------------------------------------------------------------
  // ADM-01-08: optional device pinning.
  //
  // "A second login from a different device is blocked until an admin releases
  // the pin. Recommended to prevent credential sharing."
  //
  // The first successful login on a pin-enabled account claims the device;
  // afterwards only that device may sign in.
  // ---------------------------------------------------------------------
  if (user.device_pin_enabled) {
    if (!input.deviceId) {
      throw new AppError(
        ErrorCode.DEVICE_PIN_MISMATCH,
        'This account is locked to a single device, but this browser did not identify itself. Please use the device you were issued.',
      );
    }
    if (user.device_pin && user.device_pin !== input.deviceId) {
      await recordAttempt(identifier, ip, userAgent, false, 'DEVICE_PIN_MISMATCH');
      writeAuditSafe({
        actor: anonymousActor(req, identifier),
        action: AuditAction.LOGIN_FAILED,
        entityType: 'user',
        entityId: user.id,
        reason: 'Device pin mismatch',
        deviceId: input.deviceId,
      });
      throw new AppError(
        ErrorCode.DEVICE_PIN_MISMATCH,
        'This account is signed in on another device. An administrator must release the device lock before you can sign in here.',
      );
    }
  }

  // Successful login clears the failure counter and claims the pin if unset.
  await db
    .updateTable('users')
    .set({
      failed_attempts: 0,
      locked_until: null,
      last_login_at: new Date(),
      ...(user.device_pin_enabled && !user.device_pin && input.deviceId
        ? { device_pin: input.deviceId }
        : {}),
    })
    .where('id', '=', user.id)
    .execute();

  await recordAttempt(identifier, ip, userAgent, true, null);

  const session = await issueSession(
    {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
      mustChangePassword: user.must_change_password,
    },
    { deviceId: input.deviceId, ip, userAgent },
  );

  writeAuditSafe({
    actor: {
      id: user.id,
      name: user.full_name,
      role: user.role,
      ipAddress: ip,
      userAgent,
      requestId: (req.res?.locals.requestId as string | undefined) ?? null,
    },
    action: AuditAction.LOGIN_SUCCEEDED,
    entityType: 'user',
    entityId: user.id,
    deviceId: input.deviceId ?? null,
  });

  return session;
}

/**
 * ADM-01-04: "Five consecutive failed attempts lock the account for 15 minutes.
 * The lock and its expiry are recorded in the audit log."
 */
async function handleFailedAttempt(
  userId: string,
  currentFailures: number,
  username: string,
  ip: string | null,
  userAgent: string | null,
  req: Request,
): Promise<void> {
  const failures = currentFailures + 1;
  const shouldLock = failures >= env.LOGIN_MAX_FAILED_ATTEMPTS;
  const lockedUntil = shouldLock ? new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000) : null;

  await db
    .updateTable('users')
    .set({ failed_attempts: failures, locked_until: lockedUntil })
    .where('id', '=', userId)
    .execute();

  await recordAttempt(username, ip, userAgent, false, 'BAD_PASSWORD');

  writeAuditSafe({
    actor: anonymousActor(req, username),
    action: shouldLock ? AuditAction.ACCOUNT_LOCKED : AuditAction.LOGIN_FAILED,
    entityType: 'user',
    entityId: userId,
    newValue: shouldLock ? { failedAttempts: failures, lockedUntil: lockedUntil?.toISOString() } : { failedAttempts: failures },
    reason: shouldLock
      ? `Locked for ${env.LOGIN_LOCKOUT_MINUTES} minutes after ${failures} consecutive failed attempts (FSD ADM-01-04).`
      : null,
  });
}

async function recordAttempt(
  username: string,
  ip: string | null,
  userAgent: string | null,
  succeeded: boolean,
  failureCode: string | null,
): Promise<void> {
  await db
    .insertInto('login_attempts')
    .values({ username, ip_address: ip, user_agent: userAgent, succeeded, failure_code: failureCode })
    .execute();
}

/** Mint an access token and a stored refresh session. */
async function issueSession(
  user: {
    id: string;
    username: string;
    fullName: string;
    role: UserRole;
    mustChangePassword: boolean;
  },
  context: { deviceId?: string; ip: string | null; userAgent: string | null },
): Promise<AuthenticatedSession> {
  const refreshToken = generateRefreshToken();
  const refreshExpiresAt = refreshExpiryForRole(user.role);

  const session = await db
    .insertInto('user_sessions')
    .values({
      user_id: user.id,
      refresh_token_hash: hashRefreshToken(refreshToken),
      device_id: context.deviceId ?? null,
      user_agent: context.userAgent,
      ip_address: context.ip,
      expires_at: refreshExpiresAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const { token, expiresAt } = await signAccessToken({
    sub: user.id,
    sid: session.id,
    role: user.role,
    username: user.username,
    name: user.fullName,
    did: context.deviceId,
    mcp: user.mustChangePassword,
  });

  return {
    accessToken: token,
    refreshToken,
    expiresAt: expiresAt.toISOString(),
    refreshExpiresAt: refreshExpiresAt.toISOString(),
    user: {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      capabilities: capabilitiesForRole(user.role),
      landingRoute: landingRouteForRole(user.role),
    },
  };
}

/**
 * ADM-01-02: "On successful login the user is routed by role: administrators to
 * the admin dashboard, judges to the judge home screen."
 */
function landingRouteForRole(role: UserRole): string {
  switch (role) {
    case 'JUDGE':
      return '/judge';
    case 'COORDINATOR':
      return '/admin/live';
    default:
      return '/admin';
  }
}

/**
 * Exchange a refresh token for a new access token.
 *
 * The refresh token is ROTATED on every use: the presented session is revoked
 * and a fresh one issued. A refresh token that is replayed after rotation is
 * therefore invalid, which turns a stolen token into a single-use window rather
 * than a standing key for the whole 12-hour judge session (ADM-01-07).
 */
export async function refresh(
  refreshToken: string,
  req: Request,
): Promise<AuthenticatedSession> {
  const hash = hashRefreshToken(refreshToken);

  const session = await db
    .selectFrom('user_sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select([
      's.id as session_id',
      's.revoked_at',
      's.expires_at',
      's.device_id',
      'u.id as user_id',
      'u.username',
      'u.full_name',
      'u.role',
      'u.must_change_password',
      'u.is_active',
    ])
    .where('s.refresh_token_hash', '=', hash)
    .executeTakeFirst();

  if (!session) {
    throw new AppError(ErrorCode.TOKEN_INVALID, 'Your session is no longer valid. Please sign in again.');
  }
  // ADM-07-05: an administrator ended this session.
  if (session.revoked_at) {
    throw new AppError(
      ErrorCode.SESSION_REVOKED,
      'Your session was ended by an administrator. Please sign in again.',
    );
  }
  if (session.expires_at.getTime() < Date.now()) {
    throw new AppError(ErrorCode.TOKEN_EXPIRED, 'Your session has expired. Please sign in again.');
  }
  if (!session.is_active) {
    throw new AppError(ErrorCode.ACCOUNT_INACTIVE, 'This account has been deactivated.');
  }

  await db
    .updateTable('user_sessions')
    .set({ revoked_at: new Date(), revoked_reason: 'Rotated on refresh' })
    .where('id', '=', session.session_id)
    .execute();

  return issueSession(
    {
      id: session.user_id,
      username: session.username,
      fullName: session.full_name,
      role: session.role,
      mustChangePassword: session.must_change_password,
    },
    {
      deviceId: session.device_id ?? undefined,
      ip: clientIp(req) ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    },
  );
}

export async function logout(sessionId: string, actor: AuditActor): Promise<void> {
  await db
    .updateTable('user_sessions')
    .set({ revoked_at: new Date(), revoked_reason: 'Signed out' })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();

  writeAuditSafe({
    actor,
    action: AuditAction.LOGOUT,
    entityType: 'user_session',
    entityId: sessionId,
  });
}

/**
 * Change one's own password (ADM-01-05).
 *
 * Every other session for the user is revoked. If a password is being changed
 * because it may have been seen by someone else — which on event day is the
 * usual reason — leaving other sessions alive would defeat the point.
 */
export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  currentSessionId: string,
  actor: AuditActor,
): Promise<void> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'password_hash', 'must_change_password'])
    .where('id', '=', userId)
    .executeTakeFirst();

  if (!user) throw errors.notFound('User', userId);

  const valid = await verifyPassword(currentPassword, user.password_hash);
  if (!valid) {
    throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'Your current password is not correct.');
  }

  if (currentPassword === newPassword) {
    throw errors.validation('The new password must be different from the current one.');
  }

  const policy = checkPasswordPolicy(newPassword);
  if (!policy.valid) {
    throw errors.validation(`That password does not meet the requirements. ${policy.problems.join(' ')}`, {
      problems: policy.problems,
    });
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({
        password_hash: await hashPassword(newPassword),
        must_change_password: false,
        updated_by: userId,
      })
      .where('id', '=', userId)
      .execute();

    await trx
      .updateTable('user_sessions')
      .set({ revoked_at: new Date(), revoked_reason: 'Password changed' })
      .where('user_id', '=', userId)
      .where('id', '!=', currentSessionId)
      .where('revoked_at', 'is', null)
      .execute();

    await writeAudit(
      {
        actor,
        action: AuditAction.PASSWORD_CHANGED,
        entityType: 'user',
        entityId: userId,
      },
      trx,
    );
  });
}

/** Session TTL in hours for the signed-in role, surfaced to the client. */
export function sessionTtlHours(role: UserRole): number {
  return refreshTtlHoursForRole(role);
}
