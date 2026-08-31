/**
 * Password hashing and policy.
 *
 * FSD ADM-01-03: "Passwords are stored only as salted hashes (bcrypt cost 12 or
 * argon2id). Plain text passwords are never stored, logged or emailed."
 * argon2id is used here — it is the stronger of the two options the FSD permits,
 * and @node-rs/argon2 ships prebuilt binaries for both the Windows development
 * machines and the Linux build image, so no compiler is needed at deploy time.
 */
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { timingSafeEqual } from 'node:crypto';

/**
 * Algorithm.Argon2id from @node-rs/argon2.
 *
 * Written as a literal rather than imported: the package declares Algorithm as
 * an ambient `const enum`, which cannot be imported under `isolatedModules`
 * (required for the esbuild-based Netlify bundle). The value is part of the
 * package's public ABI and is asserted by the round-trip test in
 * tests/auth/password.test.ts.
 */
const ALGORITHM_ARGON2ID = 2;

/**
 * OWASP Password Storage Cheat Sheet parameters for argon2id: 19 MiB memory,
 * 2 iterations, 1 degree of parallelism. Sized so a login stays well inside the
 * FSD 11.1 latency budget while remaining expensive to attack offline.
 */
const ARGON2_OPTIONS = {
  algorithm: ALGORITHM_ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2Hash(plain, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * Never throws for a malformed or unrecognised hash — it returns false. A stored
 * hash that cannot be parsed must read as "wrong password", not as a 500 that
 * distinguishes this account from every other failed login.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * A dummy verification performed when the username does not exist.
 *
 * Without it, a missing user returns in microseconds while a real user costs a
 * full argon2 verification, and the difference lets an attacker enumerate valid
 * usernames by timing alone. The hash below is a real argon2id digest of a
 * random string, so the work performed is genuinely equivalent.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXJhbmRvbXNhbHR2YWx1ZQ$8kEwbJ0e2SL0J1zWJc8h1yjRlLp3nZfPqQ7YyTkVxHo';

export async function dummyVerify(plain: string): Promise<void> {
  await verifyPassword(plain, DUMMY_HASH);
}

export interface PasswordPolicyResult {
  valid: boolean;
  problems: string[];
}

/**
 * FSD ADM-01-05: "The system enforces minimum length 8 with at least one letter
 * and one number."
 *
 * Deliberately no symbol or mixed-case requirement beyond that. The FSD sets the
 * rule, and judges type these on a phone keypad in a dark auditorium — adding
 * friction the specification does not ask for would work against ADM-01-05's
 * intent rather than for it.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const problems: string[] = [];

  if (password.length < 8) problems.push('Use at least 8 characters.');
  if (!/[A-Za-z]/.test(password)) problems.push('Include at least one letter.');
  if (!/[0-9]/.test(password)) problems.push('Include at least one number.');
  if (password.length > 128) problems.push('Use no more than 128 characters.');

  return { valid: problems.length === 0, problems };
}

/**
 * Generate a readable temporary password for an administrator to hand over.
 *
 * FSD ADM-01-06 makes password reset a deliberate out-of-band, human step:
 * "An administrator resets the password and communicates it out of band. This is
 * deliberate: it keeps account control with the committee on event day."
 * So the value has to be dictatable over a noisy hall — hence no characters that
 * are ambiguous when spoken or read (0/O, 1/l/I).
 */
const SAFE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const SAFE_DIGITS = '23456789';

export function generateTemporaryPassword(length = 10): string {
  const alphabet = SAFE_LETTERS + SAFE_DIGITS;
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);

  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }

  // Guarantee the policy is met regardless of what the random draw produced.
  if (!/[A-Za-z]/.test(out)) out = `${SAFE_LETTERS[0]}${out.slice(1)}`;
  if (!/[0-9]/.test(out)) out = `${out.slice(0, -1)}${SAFE_DIGITS[0]}`;

  return out;
}

/** Constant-time comparison for opaque tokens (device pins, reset tokens). */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
