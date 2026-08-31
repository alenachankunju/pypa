/**
 * Realtime push via Supabase Realtime broadcast.
 *
 * FSD 3.3: "The realtime channel pushes two things: the current performance on
 * stage (so every judge's device follows the coordinator automatically), and
 * live scoring progress to the admin console. If the realtime channel is
 * unavailable the application degrades to polling; it is a convenience layer,
 * NEVER A CORRECTNESS DEPENDENCY."
 *
 * That last clause is why every function here is fire-and-forget and swallows
 * its errors. A broadcast that fails must never roll back a score that was
 * successfully written, and must never make a judge's submission appear to fail.
 *
 * WHY BROADCAST RATHER THAN postgres_changes
 * Supabase can stream table changes directly to subscribed clients. That is not
 * usable here: judge devices hold the publishable key, and a postgres_changes
 * subscription on `scores` would deliver other judges' marks to every listening
 * device — a direct breach of FSD 4.3.4 and 6.9. Broadcast payloads are composed
 * server-side and contain only what the recipient is permitted to see, so the
 * privacy rule is enforced by construction rather than by RLS policy tuning.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, supabaseEnabled } from '../config/env.js';
import { logger } from '../utils/logger.js';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!supabaseEnabled) return null;
  if (client) return client;

  client = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Channel naming. Judge devices subscribe to their session's channel only. */
export const channels = {
  session: (sessionId: string) => `session:${sessionId}`,
  event: (eventId: string) => `event:${eventId}`,
};

export const RealtimeEvent = {
  /** ADM-09-02: pushed to every judge device on the panel. */
  CURRENT_PERFORMANCE: 'current_performance',
  /** 7.3: progress(P, valid, panel_size) — counts only, never marks. */
  SCORING_PROGRESS: 'scoring_progress',
  PERFORMANCE_COMPLETE: 'performance_complete',
  PERFORMANCE_STATUS: 'performance_status',
  SESSION_STATUS: 'session_status',
  /** ADM-10-03: tells the judge's device their mark was revoked. */
  SCORE_REVOKED: 'score_revoked',
  PANEL_CHANGED: 'panel_changed',
} as const;

export type RealtimeEventName = (typeof RealtimeEvent)[keyof typeof RealtimeEvent];

/**
 * Send a broadcast over the Supabase Realtime HTTP endpoint.
 *
 * The HTTP endpoint is used rather than a websocket client because the API runs
 * as short-lived serverless invocations: opening, joining and closing a socket
 * per request would cost more than the broadcast is worth, and would frequently
 * be torn down before the frame was flushed.
 */
async function broadcast(
  channel: string,
  event: RealtimeEventName,
  payload: Record<string, unknown>,
): Promise<void> {
  const supabase = getClient();
  if (!supabase) return;

  const response = await fetch(`${env.SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      messages: [{ topic: channel, event, payload, private: false }],
    }),
  });

  if (!response.ok) {
    throw new Error(`realtime broadcast failed: ${response.status} ${await response.text()}`);
  }
}

/**
 * Fire-and-forget publish.
 *
 * Never awaited by a caller on a write path. FSD 3.3 makes the channel a
 * convenience; FSD 11.4 requires graceful degradation — "if the realtime channel
 * fails, the application polls".
 */
export function publish(
  channel: string,
  event: RealtimeEventName,
  payload: Record<string, unknown>,
): void {
  if (!supabaseEnabled) return;

  void broadcast(channel, event, payload).catch((error) => {
    logger.warn(
      { err: error, channel, event },
      'realtime broadcast failed; clients will fall back to polling',
    );
  });
}

// ---------------------------------------------------------------------------
// Typed publishers. Each one documents exactly what leaves the server, which is
// the enforcement point for FSD 6.9 ("What judges must never see").
// ---------------------------------------------------------------------------

/** ADM-09-02. Carries identity, never marks. */
export function publishCurrentPerformance(
  sessionId: string,
  performance: {
    performanceId: string;
    itemId: string;
    itemName: string;
    registrationId: string;
    chestNumber: string | null;
    memberName: string | null;
    churchName: string | null;
    photoPath: string | null;
    position: number;
    total: number;
  } | null,
): void {
  publish(channels.session(sessionId), RealtimeEvent.CURRENT_PERFORMANCE, {
    sessionId,
    performance,
    at: new Date().toISOString(),
  });
}

/**
 * FSD 7.3: "publish realtime event: progress(P, valid, P.panel_size)".
 *
 * COUNTS ONLY. ADM-09-03 is explicit that marks are not shown on the live
 * console until the performance is COMPLETE, "so that a coordinator cannot relay
 * one judge's mark to another" — so no mark value is ever placed in this
 * payload, not even for the admin channel.
 */
export function publishScoringProgress(
  sessionId: string,
  progress: {
    performanceId: string;
    submittedCount: number;
    panelSize: number;
    status: string;
    submittedJudgeIds: string[];
  },
): void {
  publish(channels.session(sessionId), RealtimeEvent.SCORING_PROGRESS, {
    ...progress,
    at: new Date().toISOString(),
  });
}

/** ADM-09-04: once COMPLETE, marks become visible to the administrator. */
export function publishPerformanceComplete(
  sessionId: string,
  performanceId: string,
  aggregate: number | null,
): void {
  publish(channels.session(sessionId), RealtimeEvent.PERFORMANCE_COMPLETE, {
    performanceId,
    aggregate,
    at: new Date().toISOString(),
  });
}

export function publishPerformanceStatus(
  sessionId: string,
  performanceId: string,
  status: string,
): void {
  publish(channels.session(sessionId), RealtimeEvent.PERFORMANCE_STATUS, {
    performanceId,
    status,
    at: new Date().toISOString(),
  });
}

export function publishSessionStatus(sessionId: string, status: string): void {
  publish(channels.session(sessionId), RealtimeEvent.SESSION_STATUS, {
    sessionId,
    status,
    at: new Date().toISOString(),
  });
}

/**
 * ADM-10-03: "the judge's device shows the performance as awaiting their mark
 * again, with a notice that their previous mark was revoked."
 */
export function publishScoreRevoked(
  sessionId: string,
  judgeId: string,
  performanceId: string,
): void {
  publish(channels.session(sessionId), RealtimeEvent.SCORE_REVOKED, {
    judgeId,
    performanceId,
    at: new Date().toISOString(),
  });
}

/** ADM-08-06: a mid-session panel change, so devices re-read their assignment. */
export function publishPanelChanged(sessionId: string, panelId: string): void {
  publish(channels.session(sessionId), RealtimeEvent.PANEL_CHANGED, {
    panelId,
    at: new Date().toISOString(),
  });
}

export function realtimeAvailable(): boolean {
  return supabaseEnabled;
}
