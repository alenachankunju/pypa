/**
 * Realtime subscriptions (FSD 3.3).
 *
 * The channel pushes two things: the performance currently on stage, so every
 * judge device follows the coordinator automatically (ADM-09-02, JDG-02-02), and
 * live scoring progress to the admin console.
 *
 * FSD 3.3: "If the realtime channel is unavailable the application degrades to
 * polling; it is a convenience layer, NEVER A CORRECTNESS DEPENDENCY." Every
 * screen that subscribes here also polls, so a failed subscription costs
 * freshness and nothing else.
 *
 * The payloads are composed server-side and carry no marks — see
 * backend/src/services/realtime.ts for why postgres_changes is deliberately not
 * used.
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  client ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return client;
}

export const realtimeEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const RealtimeEvent = {
  CURRENT_PERFORMANCE: 'current_performance',
  SCORING_PROGRESS: 'scoring_progress',
  PERFORMANCE_COMPLETE: 'performance_complete',
  PERFORMANCE_STATUS: 'performance_status',
  SESSION_STATUS: 'session_status',
  SCORE_REVOKED: 'score_revoked',
  PANEL_CHANGED: 'panel_changed',
} as const;

export type RealtimeEventName = (typeof RealtimeEvent)[keyof typeof RealtimeEvent];
export type RealtimeHandler = (event: RealtimeEventName, payload: Record<string, unknown>) => void;

/**
 * Subscribe to one session's channel.
 *
 * @returns an unsubscribe function. Safe to call when realtime is unavailable —
 *          it does nothing and the caller's polling carries the screen.
 */
export function subscribeToSession(sessionId: string, handler: RealtimeHandler): () => void {
  const supabase = getClient();
  if (!supabase) return () => undefined;

  let channel: RealtimeChannel | null = null;

  try {
    channel = supabase.channel(`session:${sessionId}`, { config: { broadcast: { self: false } } });

    for (const event of Object.values(RealtimeEvent)) {
      channel.on('broadcast', { event }, (message) => {
        handler(event, (message.payload ?? {}) as Record<string, unknown>);
      });
    }

    channel.subscribe();
  } catch {
    // Non-fatal by design (FSD 3.3).
    return () => undefined;
  }

  return () => {
    if (channel) void supabase.removeChannel(channel);
  };
}

/** Public URL for a file in Supabase Storage (member photos, church logos). */
export function storageUrl(path: string | null | undefined, bucket = 'pypa'): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  if (!SUPABASE_URL) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path.replace(/^\/+/, '')}`;
}
