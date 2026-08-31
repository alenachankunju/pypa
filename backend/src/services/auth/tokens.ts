/**
 * JWT access tokens and opaque refresh tokens.
 *
 * FSD 3.4: "JWT access token (short-lived) plus refresh token ... Stateless API
 * with revocable sessions."
 *
 * The two halves are deliberately different in kind:
 *
 *  - The ACCESS token is a signed JWT, verified without a database round trip so
 *    that FSD 11.1's sub-500 ms score submission budget is not spent on auth.
 *    It is short-lived precisely because it cannot be revoked.
 *
 *  - The REFRESH token is opaque random bytes, stored only as a SHA-256 hash in
 *    user_sessions. That is what makes ADM-07-05 force logout real: revoking the
 *    row kills the session, whereas a self-contained refresh JWT could not be
 *    withdrawn before its expiry.
 */
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../../config/env.js';
import type { UserRole } from '../../db/schema.js';
import { AppError, ErrorCode } from '../../utils/errors.js';

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessTokenClaims extends JWTPayload {
  /** User id. */
  sub: string;
  /** Session id, so a revoked session can be rejected on refresh. */
  sid: string;
  role: UserRole;
  username: string;
  name: string;
  /** ADM-01-08: the device this token was issued to. */
  did?: string;
  /** ADM-01-05: set while the user still owes a password change. */
  mcp?: boolean;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

/** ADM-01-07: judges 12 hours, admins 2 hours (FSD 18.2). */
export function refreshTtlHoursForRole(role: UserRole): number {
  return role === 'JUDGE' || role === 'COORDINATOR'
    ? env.REFRESH_TTL_HOURS_JUDGE
    : env.REFRESH_TTL_HOURS_ADMIN;
}

export async function signAccessToken(
  claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'iss'>,
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + env.ACCESS_TOKEN_TTL_MINUTES * 60_000);

  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(env.JWT_ISSUER)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(accessSecret);

  return { token, expiresAt };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, accessSecret, {
      issuer: env.JWT_ISSUER,
      algorithms: ['HS256'],
    });
    return payload as AccessTokenClaims;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('exp')) {
      throw new AppError(ErrorCode.TOKEN_EXPIRED, 'Your session has expired. Please sign in again.');
    }
    throw new AppError(ErrorCode.TOKEN_INVALID, 'Your session is no longer valid. Please sign in again.');
  }
}

/** 256 bits of entropy, URL-safe. Never stored in this form. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 rather than argon2 for the refresh token.
 *
 * A password is low-entropy and must be slow to guess; a 256-bit random token is
 * not guessable at all, so the only property needed is that a database read does
 * not yield a usable credential. SHA-256 gives that, and keeps token refresh off
 * the argon2 cost curve on every judge device every 30 minutes.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function refreshExpiryForRole(role: UserRole): Date {
  return new Date(Date.now() + refreshTtlHoursForRole(role) * 3_600_000);
}

/** Extract a bearer token from the Authorization header. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}
