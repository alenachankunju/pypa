/**
 * Offline queue state for the interface (JDG-08-04).
 *
 * "The queue depth is visible to the judge, for example '3 marks waiting to
 * send'." FSD 12.3 explains why this is a requirement rather than a nicety: if a
 * device dies with marks queued, those marks are lost and must be re-entered, so
 * the judge needs to know at all times whether anything is still waiting.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { subscribeToQueue, type QueuedScore } from '../lib/offlineQueue';

export interface QueueState {
  queue: QueuedScore[];
  depth: number;
  /** JDG-08-05: surfaced to the judge after three failed attempts. */
  needingAttention: QueuedScore[];
}

export function useQueue(): QueueState {
  const [queue, setQueue] = useState<QueuedScore[]>([]);

  useEffect(() => subscribeToQueue(setQueue), []);

  // JDG-08-07: let the coordinator's live console tell "waiting" apart from
  // "already scored, just not synced yet" — debounced so a burst of
  // enqueue/dequeue during normal use doesn't fire one request per change.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      api.post('/api/judge/queue-status', { count: queue.length }).catch(() => undefined);
    }, 2000);
    return () => window.clearTimeout(handle);
  }, [queue.length]);

  return {
    queue,
    depth: queue.length,
    needingAttention: queue.filter((q) => q.needsAttention),
  };
}
