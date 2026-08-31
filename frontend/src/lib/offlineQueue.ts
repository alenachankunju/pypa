/**
 * Offline score queue (FSD 6.8).
 *
 * "Venue wireless networks fail. The judge application must degrade gracefully
 * rather than block scoring."
 *
 *   JDG-08-03  Scoring continues offline. Submissions are queued locally with
 *              their idempotency keys and timestamps.
 *   JDG-08-04  The queue depth is visible to the judge.
 *   JDG-08-05  On reconnection the queue is transmitted automatically IN ORDER.
 *              Successful items disappear; failures are retried with backoff and
 *              surfaced after three failures.
 *   JDG-08-06  The recorded time is the CLIENT submission time carried in the
 *              payload, not the server receipt time.
 *
 * The idempotency key is generated when the judge confirms, not when the request
 * is sent. That is what makes the queue safe: a mark delivered just before the
 * connection dropped, and retried on reconnection, is recognised by the server
 * as the same submission and returns the original result rather than a duplicate
 * (JDG-06-05).
 *
 * FSD 12.3 records the one loss this design accepts: "A judge's phone battery
 * dies mid-session — Any marks queued offline on the dead device are lost and
 * must be re-entered — which is why the queue depth indicator is a requirement,
 * not a nicety."
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { ApiError, ErrorCode, api } from './api';

export interface QueuedScore {
  /** Primary key. Also the idempotency key sent to the server. */
  idempotencyKey: string;
  performanceId: string;
  sessionId: string;
  mark: number;
  remarks: string | null;
  criteria?: { itemCriteriaId: string; mark: number }[];
  /** JDG-08-06: client submission time, authoritative for the audit trail. */
  submittedAt: string;
  deviceId: string;
  /** Context kept so the queue can be displayed without a network call. */
  chestNumber: string | null;
  participantName: string;
  itemName: string;
  /** JDG-08-05: retry bookkeeping. */
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** Set once three attempts have failed, so it is surfaced to the judge. */
  needsAttention: boolean;
  queuedAt: string;
}

interface PypaDB extends DBSchema {
  'score-queue': {
    key: string;
    value: QueuedScore;
    indexes: { 'by-queued': string; 'by-session': string };
  };
}

const DB_NAME = 'pypa-marking';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<PypaDB>> | null = null;

function getDb(): Promise<IDBPDatabase<PypaDB>> {
  dbPromise ??= openDB<PypaDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore('score-queue', { keyPath: 'idempotencyKey' });
      store.createIndex('by-queued', 'queuedAt');
      store.createIndex('by-session', 'sessionId');
    },
  });
  return dbPromise;
}

// --- Subscription -----------------------------------------------------------

type Listener = (queue: QueuedScore[]) => void;
const listeners = new Set<Listener>();

async function notify(): Promise<void> {
  const queue = await listQueue();
  for (const listener of listeners) listener(queue);
}

export function subscribeToQueue(listener: Listener): () => void {
  listeners.add(listener);
  void listQueue().then(listener);
  return () => listeners.delete(listener);
}

// --- Queue operations -------------------------------------------------------

/** JDG-08-05: transmitted in order, so the queue is read oldest-first. */
export async function listQueue(): Promise<QueuedScore[]> {
  const db = await getDb();
  return db.getAllFromIndex('score-queue', 'by-queued');
}

export async function queueDepth(): Promise<number> {
  const db = await getDb();
  return db.count('score-queue');
}

export async function enqueue(
  score: Omit<QueuedScore, 'attempts' | 'lastAttemptAt' | 'lastError' | 'needsAttention' | 'queuedAt'>,
): Promise<void> {
  const db = await getDb();
  await db.put('score-queue', {
    ...score,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    needsAttention: false,
    queuedAt: new Date().toISOString(),
  });
  await notify();
}

export async function dequeue(idempotencyKey: string): Promise<void> {
  const db = await getDb();
  await db.delete('score-queue', idempotencyKey);
  await notify();
}

/** Discard a queued mark the judge has decided not to send. */
export async function discard(idempotencyKey: string): Promise<void> {
  await dequeue(idempotencyKey);
}

// --- Flush ------------------------------------------------------------------

export interface FlushResult {
  sent: number;
  failed: number;
  remaining: number;
  needingAttention: QueuedScore[];
}

let flushing = false;

/**
 * Send everything in the queue, oldest first.
 *
 * Strictly sequential rather than parallel. FSD 7.2's completion check runs
 * inside each insert's transaction, and sending in order keeps the submitted_at
 * sequence on the server matching the order the judge actually awarded the
 * marks — which is what the audit trail is read against afterwards.
 */
export async function flushQueue(): Promise<FlushResult> {
  if (flushing) return { sent: 0, failed: 0, remaining: await queueDepth(), needingAttention: [] };
  if (!navigator.onLine) {
    return { sent: 0, failed: 0, remaining: await queueDepth(), needingAttention: [] };
  }

  flushing = true;
  const result: FlushResult = { sent: 0, failed: 0, remaining: 0, needingAttention: [] };

  try {
    const queue = await listQueue();

    for (const item of queue) {
      // Exponential backoff: 0s, 2s, 8s, 30s from the last attempt.
      if (item.lastAttemptAt) {
        const backoffMs = Math.min(30_000, 2_000 * 4 ** (item.attempts - 1));
        if (Date.now() - new Date(item.lastAttemptAt).getTime() < backoffMs) continue;
      }

      try {
        await api.post('/api/judge/scores', {
          performanceId: item.performanceId,
          mark: item.mark,
          remarks: item.remarks,
          idempotencyKey: item.idempotencyKey,
          submittedAt: item.submittedAt,
          deviceId: item.deviceId,
          criteria: item.criteria,
        });

        await dequeue(item.idempotencyKey);
        result.sent += 1;
      } catch (error) {
        const apiError = error instanceof ApiError ? error : null;

        // JDG-06-07: an ALREADY_SCORED response means the mark IS recorded —
        // the first attempt reached the server before the connection dropped.
        // Treat it as success and clear it from the queue, rather than showing
        // the judge a failure for a mark that stands.
        if (apiError?.code === ErrorCode.ALREADY_SCORED) {
          await dequeue(item.idempotencyKey);
          result.sent += 1;
          continue;
        }

        // Still offline — stop trying and leave the queue intact.
        if (apiError?.isOffline) break;

        const db = await getDb();
        const attempts = item.attempts + 1;
        const updated: QueuedScore = {
          ...item,
          attempts,
          lastAttemptAt: new Date().toISOString(),
          lastError: apiError?.message ?? 'Could not send this mark.',
          // JDG-08-05: "failures are retried with backoff and surfaced after
          // three failures."
          needsAttention: attempts >= 3,
        };
        await db.put('score-queue', updated);

        result.failed += 1;
        if (updated.needsAttention) result.needingAttention.push(updated);

        // A rejection the server will repeat (published result, closed session,
        // not on panel) will never succeed on retry. It stays in the queue and
        // is flagged so the judge can raise it with the administrator, per
        // FSD 12.1's offline-after-publication case.
      }
    }

    result.remaining = await queueDepth();
    await notify();
    return result;
  } finally {
    flushing = false;
  }
}

/**
 * Start automatic flushing.
 *
 * Triggered by the browser's online event, on visibility change (a judge
 * unlocking their phone is the most common moment connectivity returns), and on
 * a slow interval as a backstop for the case where `online` never fires because
 * the device was on a captive-portal wifi the whole time.
 */
export function startAutoFlush(): () => void {
  const attempt = () => void flushQueue();

  window.addEventListener('online', attempt);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') attempt();
  });

  const interval = window.setInterval(attempt, 20_000);
  attempt();

  return () => {
    window.removeEventListener('online', attempt);
    window.clearInterval(interval);
  };
}

/** JDG-08-08: offline scoring is limited to the cached current session. */
export async function queueForSession(sessionId: string): Promise<QueuedScore[]> {
  const db = await getDb();
  return db.getAllFromIndex('score-queue', 'by-session', sessionId);
}

/** Whether a specific performance already has a mark waiting to send. */
export async function isQueued(performanceId: string): Promise<QueuedScore | null> {
  const queue = await listQueue();
  return queue.find((q) => q.performanceId === performanceId) ?? null;
}
