/**
 * Audit trail writer (FSD 5.14).
 *
 * ADM-14-01 requires every state-changing action to be logged with actor, role,
 * IP, action, entity, previous and new value, and the reason where one was
 * required. The trail is append-only (ADM-14-03) and enforced as such by trigger
 * in migration 0009 — this module is the only thing that writes to it.
 *
 * A note on failure handling. An audit write that fails inside a caller's
 * transaction rolls the whole action back, and that is correct: FSD 2.2 lists
 * "preserve a full audit trail so any result can be defended if challenged" as a
 * primary objective, so an unauditable action must not happen. The one exception
 * is the fire-and-forget helper at the bottom, used for read-only and
 * authentication-adjacent events where losing a log line is preferable to
 * failing a judge's login.
 */
import type { Request } from 'express';
import type { Executor } from '../db/pool.js';
import { db } from '../db/pool.js';
import type { UserRole } from '../db/schema.js';
import { clientIp } from '../utils/http.js';
import { logger } from '../utils/logger.js';

/**
 * Canonical action names.
 *
 * Kept as a closed set so the audit log is searchable by action (ADM-14-04)
 * without the operator having to guess whether the system wrote "score.revoke"
 * or "SCORE_REVOKED" on the day.
 */
export const AuditAction = {
  // Authentication (FSD 5.1)
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  ACCOUNT_LOCKED: 'auth.account.locked',
  LOGOUT: 'auth.logout',
  PASSWORD_CHANGED: 'auth.password.changed',
  PASSWORD_RESET: 'auth.password.reset',
  SESSION_FORCE_REVOKED: 'auth.session.force_revoked',
  DEVICE_PIN_CLAIMED: 'auth.device_pin.claimed',
  DEVICE_PIN_RELEASED: 'auth.device_pin.released',

  // Master data
  CREATED: 'entity.created',
  UPDATED: 'entity.updated',
  DEACTIVATED: 'entity.deactivated',
  REACTIVATED: 'entity.reactivated',
  DELETED: 'entity.deleted',
  IMPORTED: 'entity.imported',
  CATEGORY_OVERRIDDEN: 'member.category.overridden',
  ELIGIBILITY_OVERRIDDEN: 'registration.eligibility.overridden',

  // Sessions and panels (FSD 5.8)
  SESSION_OPENED: 'session.opened',
  SESSION_CLOSED: 'session.closed',
  SESSION_FORCE_CLOSED: 'session.force_closed',
  PANEL_JUDGE_ADDED: 'panel.judge.added',
  PANEL_JUDGE_REMOVED: 'panel.judge.removed',

  // Live judging (FSD 5.9)
  PERFORMANCE_CREATED: 'performance.created',
  PERFORMANCE_SET_CURRENT: 'performance.set_current',
  PERFORMANCE_ABSENT: 'performance.marked_absent',
  PERFORMANCE_VOIDED: 'performance.voided',
  PERFORMANCE_REINSTATED: 'performance.reinstated',
  PERFORMANCE_COMPLETED: 'performance.completed',

  // Scoring (FSD 4.3, 5.10)
  SCORE_SUBMITTED: 'score.submitted',
  SCORE_OUT_OF_SEQUENCE: 'score.submitted.out_of_sequence',
  SCORE_REVOKED: 'score.revoked',
  SCORE_BACK_ENTERED: 'score.back_entered',

  // Results (FSD 5.12)
  RESULT_COMPUTED: 'result.computed',
  RESULT_PUBLISHED: 'result.published',
  RESULT_UNPUBLISHED: 'result.unpublished',
  RESULT_WITHHELD: 'result.withheld',
  TIE_RESOLVED: 'result.tie.resolved',
  RECOMPUTED: 'result.recomputed',

  // Configuration and settings (FSD 5.11, 5.15)
  CONFIG_UPDATED: 'config.updated',
  CONFIG_LOCKED: 'config.locked',
  CONFIG_UNLOCKED: 'config.unlocked',
  FREEZE_ENABLED: 'settings.freeze.enabled',
  FREEZE_DISABLED: 'settings.freeze.disabled',
  SNAPSHOT_CREATED: 'settings.snapshot.created',
  SNAPSHOT_RESTORED: 'settings.snapshot.restored',
  EVENT_ARCHIVED: 'settings.event.archived',

  // Reporting
  REPORT_EXPORTED: 'report.exported',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

/** The acting user and request context, gathered by middleware. */
export interface AuditActor {
  id: string | null;
  name: string | null;
  role: UserRole | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  deviceId?: string | null;
}

export interface AuditEntry {
  eventId?: string | null;
  actor: AuditActor;
  action: AuditActionValue | string;
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  /** Mandatory wherever the FSD requires a typed justification. */
  reason?: string | null;
  /** ADM-14-02: score submissions carry the device and session identifier. */
  deviceId?: string | null;
  sessionId?: string | null;
}

/**
 * Write one audit row.
 *
 * Pass the caller's transaction as `executor` so the log and the change it
 * describes commit or roll back together. A log entry describing a change that
 * was rolled back would be worse than no entry at all.
 */
export async function writeAudit(entry: AuditEntry, executor: Executor = db): Promise<void> {
  await executor
    .insertInto('audit_logs')
    .values({
      event_id: entry.eventId ?? null,
      actor_id: entry.actor.id,
      actor_name: entry.actor.name,
      actor_role: entry.actor.role,
      ip_address: entry.actor.ipAddress ?? null,
      user_agent: entry.actor.userAgent ?? null,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      old_value: entry.oldValue === undefined ? null : (JSON.stringify(entry.oldValue) as never),
      new_value: entry.newValue === undefined ? null : (JSON.stringify(entry.newValue) as never),
      reason: entry.reason ?? null,
      device_id: entry.deviceId ?? entry.actor.deviceId ?? null,
      session_id: entry.sessionId ?? null,
      request_id: entry.actor.requestId ?? null,
    })
    .execute();
}

/**
 * Write several audit rows in one statement.
 * Used by bulk import commit (ADM-05-07) and by recomputation (7.7), where one
 * operator action legitimately produces many entity changes.
 */
export async function writeAuditBatch(
  entries: AuditEntry[],
  executor: Executor = db,
): Promise<void> {
  if (entries.length === 0) return;

  await executor
    .insertInto('audit_logs')
    .values(
      entries.map((entry) => ({
        event_id: entry.eventId ?? null,
        actor_id: entry.actor.id,
        actor_name: entry.actor.name,
        actor_role: entry.actor.role,
        ip_address: entry.actor.ipAddress ?? null,
        user_agent: entry.actor.userAgent ?? null,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId ?? null,
        old_value: entry.oldValue === undefined ? null : (JSON.stringify(entry.oldValue) as never),
        new_value: entry.newValue === undefined ? null : (JSON.stringify(entry.newValue) as never),
        reason: entry.reason ?? null,
        device_id: entry.deviceId ?? entry.actor.deviceId ?? null,
        session_id: entry.sessionId ?? null,
        request_id: entry.actor.requestId ?? null,
      })),
    )
    .execute();
}

/**
 * Best-effort audit write that never throws.
 *
 * Only for events where the audit entry is secondary to the operation: a failed
 * login attempt, a logout, a report export. Never for a state change that the
 * committee might later need to defend.
 */
export function writeAuditSafe(entry: AuditEntry, executor: Executor = db): void {
  void writeAudit(entry, executor).catch((error) => {
    logger.error({ err: error, action: entry.action }, 'audit write failed');
  });
}

/** Build an actor from an authenticated request. */
export function actorFromRequest(req: Request): AuditActor {
  const user = req.auth;
  return {
    id: user?.userId ?? null,
    name: user?.fullName ?? null,
    role: user?.role ?? null,
    ipAddress: clientIp(req) ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    requestId: (req.res?.locals.requestId as string | undefined) ?? null,
    deviceId: user?.deviceId ?? null,
  };
}

/** Anonymous actor, for pre-authentication events such as a failed login. */
export function anonymousActor(req: Request, username?: string): AuditActor {
  return {
    id: null,
    name: username ? `unknown (${username})` : null,
    role: null,
    ipAddress: clientIp(req) ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    requestId: (req.res?.locals.requestId as string | undefined) ?? null,
  };
}

/**
 * Reduce a row to the fields worth recording, dropping noise and secrets.
 *
 * FSD 11.2 forbids password hashes from being logged anywhere, and updated_at
 * churn makes a diff unreadable, so both are stripped before the value reaches
 * old_value / new_value.
 */
const OMITTED_FIELDS = new Set([
  'password_hash',
  'refresh_token_hash',
  'updated_at',
  'created_at',
  'updated_by',
  'created_by',
]);

export function auditSnapshot<T extends Record<string, unknown>>(row: T | null | undefined): unknown {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (OMITTED_FIELDS.has(key)) continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/**
 * Compute the changed fields between two snapshots.
 * Keeps old_value / new_value focused on what actually moved, which matters when
 * an operator is scanning the trail during a dispute (ADM-14-04).
 */
export function auditDiff<T extends Record<string, unknown>>(
  before: T,
  after: T,
): { old: Record<string, unknown>; new: Record<string, unknown> } {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (OMITTED_FIELDS.has(key)) continue;
    const a = before[key];
    const b = after[key];
    const aNorm = a instanceof Date ? a.toISOString() : a;
    const bNorm = b instanceof Date ? b.toISOString() : b;
    if (JSON.stringify(aNorm) !== JSON.stringify(bNorm)) {
      oldValues[key] = aNorm;
      newValues[key] = bNorm;
    }
  }

  return { old: oldValues, new: newValues };
}

/**
 * ADM-14-05: "Retention is for the full event plus a configurable archival
 * period (default 24 months)."
 *
 * This reports what is past the retention cut-off; it never deletes anything.
 * ADM-14-03 is a hard, unconditional guarantee — migration 0009's
 * audit_logs_no_delete / audit_logs_no_update triggers raise on every DELETE
 * and UPDATE regardless of caller, by design, so that no application code
 * path (a bug, a compromised admin session, a future feature) can edit the
 * trail. Retention therefore isn't something this service can enforce by
 * deleting rows — an actual purge past the configured period is deliberately
 * an out-of-band DBA action (temporarily dropping the trigger with a
 * superuser connection), not an in-app button. What the application can and
 * does own is the configurable period itself (events.audit_retention_months)
 * and surfacing how many rows are currently eligible, so an operator knows
 * when that out-of-band step is due.
 */
export async function auditRetentionStatus(
  eventId: string,
): Promise<{ cutoff: Date | null; eligibleForPurgeCount: number; retentionMonths: number }> {
  const event = await db
    .selectFrom('events')
    .select(['end_date', 'audit_retention_months'])
    .where('id', '=', eventId)
    .executeTakeFirst();

  if (!event?.end_date) return { cutoff: null, eligibleForPurgeCount: 0, retentionMonths: event?.audit_retention_months ?? 24 };

  const cutoff = new Date(event.end_date);
  cutoff.setMonth(cutoff.getMonth() + event.audit_retention_months);

  const { count } = await db
    .selectFrom('audit_logs')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('event_id', '=', eventId)
    .where('occurred_at', '<', cutoff)
    .executeTakeFirstOrThrow();

  return { cutoff, eligibleForPurgeCount: Number(count), retentionMonths: event.audit_retention_months };
}
