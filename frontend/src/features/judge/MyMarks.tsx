/**
 * Screen J9 — My marks (FSD 6.7).
 *
 * JDG-07-01: read-only list of every mark this judge has submitted.
 * JDG-07-02: searchable and filterable by item.
 * JDG-07-03: "No edit or delete control exists anywhere on this screen."
 * JDG-07-04: a revoked mark appears struck through with "Revoked — please
 * re-enter", and tapping it opens mark entry again.
 *
 * Also shows the offline queue (JDG-08-04) above the submitted list, since both
 * are "marks this judge has entered" from the judge's point of view.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { discard, flushQueue } from '../../lib/offlineQueue';
import { formatDateTime } from '../../lib/format';
import { useOnline } from '../../hooks/useOnline';
import { useQueue } from '../../hooks/useQueue';
import { Banner, ErrorState, LoadingState } from '../../components/ui';
import { useJudgeSession } from './JudgeSession';

interface MyScoreRow {
  scoreId: string;
  performanceId: string;
  mark: number;
  submittedAt: string;
  remarks: string | null;
  itemName: string;
  itemCode: string;
  chestNumber: string | null;
  participantName: string;
  churchName: string;
  isOutOfSequence: boolean;
  revoked: boolean;
  revokedReason: string | null;
  canReEnter: boolean;
}

export function MyMarks() {
  const { sessionId, bundle } = useJudgeSession();
  const navigate = useNavigate();
  const online = useOnline();
  const { queue, needingAttention } = useQueue();
  const [rows, setRows] = useState<MyScoreRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filterItem, setFilterItem] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    api
      .get<MyScoreRow[]>('/api/judge/my-scores', { sessionId })
      .then((data) => !cancelled && setRows(data))
      .catch((err) => !cancelled && setError(err));

    return () => {
      cancelled = true;
    };
  }, [sessionId, queue.length]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (filterItem && r.itemName !== filterItem) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          r.participantName.toLowerCase().includes(q) ||
          (r.chestNumber ?? '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [rows, filterItem, search]);

  const itemNames = useMemo(
    () => Array.from(new Set((rows ?? []).map((r) => r.itemName))).sort(),
    [rows],
  );

  if (error) return <ErrorState error={error} />;

  return (
    <div className="stack">
      {queue.length > 0 && (
        <div className="card stack-sm">
          <div className="row-between">
            <span className="strong">
              {queue.length} mark{queue.length === 1 ? '' : 's'} waiting to send
            </span>
            {online && (
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => void flushQueue()}>
                Retry now
              </button>
            )}
          </div>
          {!online && <p className="text-sm muted">These will send automatically once you're back online.</p>}

          {needingAttention.length > 0 && (
            <Banner tone="danger" title="Some marks have failed repeatedly">
              Show this to your administrator — they may need to check the session status.
            </Banner>
          )}

          <div className="stack-sm">
            {queue.map((q) => (
              <div key={q.idempotencyKey} className="row-between text-sm">
                <span>
                  {q.chestNumber ?? '—'} · {q.participantName} · {q.itemName}
                </span>
                <span className="row">
                  <span className="numeric strong">{q.mark.toFixed(1)}</span>
                  {q.needsAttention && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => void discard(q.idempotencyKey)}
                      title="Remove from the queue without sending"
                    >
                      Discard
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="row-wrap" style={{ gap: 'var(--space-2)' }}>
        <input
          className="input grow"
          placeholder="Filter by name or chest number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="select" value={filterItem} onChange={(e) => setFilterItem(e.target.value)}>
          <option value="">All items</option>
          {itemNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {!rows ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <p className="muted" style={{ textAlign: 'center', padding: 'var(--space-8) 0' }}>
          {bundle ? 'No marks submitted yet in this session.' : 'Choose a session first.'}
        </p>
      ) : (
        <div className="stack-sm">
          {filtered.map((row) => (
            <button
              key={row.scoreId}
              type="button"
              className="card row-between"
              style={{ width: '100%', textAlign: 'left', cursor: row.canReEnter ? 'pointer' : 'default' }}
              onClick={() => row.canReEnter && navigate(`/judge/score/${row.performanceId}`)}
              disabled={!row.canReEnter && row.revoked}
            >
              <div>
                <div className={row.revoked ? 'strong' : 'strong'} style={row.revoked ? { textDecoration: 'line-through' } : undefined}>
                  {row.chestNumber ?? '—'} · {row.participantName}
                </div>
                <div className="text-sm muted">
                  {row.itemName} · {formatDateTime(row.submittedAt)}
                </div>
                {row.revoked && (
                  <div className="text-xs" style={{ color: 'var(--danger-text)', fontWeight: 600 }}>
                    Revoked — please re-enter
                  </div>
                )}
              </div>
              <span className="mark-value" style={row.revoked ? { textDecoration: 'line-through', opacity: 0.5 } : undefined}>
                {row.mark.toFixed(1)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* JDG-07-03: no edit or delete control anywhere on this screen. */}
    </div>
  );
}
