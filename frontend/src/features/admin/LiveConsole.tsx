/**
 * Screen A12 — Live judging console (FSD 5.9).
 *
 * "This is the administrator's event-day screen and the operational centre of
 * the system. It answers one question continuously: is anything stuck?"
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { subscribeToSession, RealtimeEvent } from '../../lib/realtime';
import { ErrorState, LoadingState, PageHeader, ProgressBar, StatusBadge } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface SessionSummary {
  id: string;
  name: string;
  stage: string | null;
  status: string;
}

interface ProgressPerformance {
  performanceId: string;
  itemId: string;
  itemName: string;
  categoryName: string | null;
  status: string;
  panelSize: number;
  submittedCount: number;
  outstandingCount: number;
  missingJudges: { judgeId: string; fullName: string; queuedMarks: number }[];
  isCurrent: boolean;
  callOrder: number | null;
  chestNumber: string | null;
  participantName: string;
  churchName: string;
  aggregate: number | null;
  judgeMarks: { judgeId: string; judgeName: string; mark: number }[];
}

interface ItemProgress {
  itemId: string;
  itemName: string;
  total: number;
  complete: number;
}

interface ProgressResponse {
  session: SessionSummary;
  current: ProgressPerformance | null;
  performances: ProgressPerformance[];
  outstanding: { performanceId: string; itemName: string; participantName: string; missingJudges: { fullName: string }[] }[];
  itemProgress: ItemProgress[];
  totals: { performances: number; complete: number; absent: number; void: number; pending: number };
  canSeeMarks: boolean;
}

const POLL_MS = 3000;

interface ItemGroup {
  itemId: string;
  itemName: string;
  categoryName: string | null;
  rows: ProgressPerformance[];
}

/**
 * One table per item rather than one long flat list (ADM-09-01 asks "is
 * anything stuck?" — easier to answer item by item). The server already
 * orders `performances` lower category to higher, then item name, then call
 * order (sessions.routes.ts /:id/progress), so grouping by first appearance
 * here preserves that order without re-sorting on the client.
 */
function groupByItem(rows: ProgressPerformance[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const p of rows) {
    const group = groups.get(p.itemId) ?? { itemId: p.itemId, itemName: p.itemName, categoryName: p.categoryName, rows: [] };
    group.rows.push(p);
    groups.set(p.itemId, group);
  }
  return [...groups.values()];
}

export function LiveConsole() {
  const { can } = useAuth();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<SessionSummary[]>('/api/admin/sessions', { status: 'OPEN' })
      .then((data) => {
        setSessions(data);
        if (data.length > 0) setSessionId(data[0]!.id);
      })
      .catch(setError);
  }, []);

  const refresh = useCallback(() => {
    if (!sessionId) return;
    api
      .get<ProgressResponse>(`/api/admin/sessions/${sessionId}/progress`)
      .then(setProgress)
      .catch(setError);
  }, [sessionId]);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!sessionId) return;
    return subscribeToSession(sessionId, (event) => {
      if (
        event === RealtimeEvent.SCORING_PROGRESS ||
        event === RealtimeEvent.PERFORMANCE_COMPLETE ||
        event === RealtimeEvent.PERFORMANCE_STATUS
      ) {
        refresh();
      }
    });
  }, [sessionId, refresh]);

  async function action(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
      refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorState error={error} onRetry={refresh} />;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Live console"
        subtitle="Is anything stuck?"
        actions={
          <select className="select" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            {sessions.length === 0 && <option value="">No open sessions</option>}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        }
      />

      {!progress ? (
        <LoadingState label="Loading session progress…" />
      ) : (
        <>
          <div className="grid grid-4">
            <div className="stat-card">
              <div className="stat-value">{progress.totals.complete}/{progress.totals.performances}</div>
              <div className="stat-label">Complete</div>
              <ProgressBar value={progress.totals.complete} max={progress.totals.performances} />
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: progress.totals.pending > 0 ? 'var(--warning-text)' : undefined }}>
                {progress.totals.pending}
              </div>
              <div className="stat-label">Pending</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{progress.totals.absent}</div>
              <div className="stat-label">Absent</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{progress.totals.void}</div>
              <div className="stat-label">Voided</div>
            </div>
          </div>

          {/* ADM-09-02/03/04: current performance and per-judge tiles. */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Current performance</span>
              {can('CONTROL_STAGE') && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy !== null}
                  onClick={() =>
                    action('advance', () =>
                      api.post('/api/admin/performances/advance', {
                        sessionId,
                        itemId: progress.current?.itemId,
                      }),
                    )
                  }
                >
                  Advance to next
                </button>
              )}
            </div>
            <div className="card-body">
              {!progress.current ? (
                <p className="muted">No performance is currently on stage.</p>
              ) : (
                <div className="stack">
                  <div className="row-between">
                    <div>
                      <div className="participant-name">
                        {progress.current.chestNumber} · {progress.current.participantName}
                      </div>
                      <div className="text-sm muted">
                        {progress.current.itemName} · {progress.current.churchName}
                      </div>
                    </div>
                    <StatusBadge status={progress.current.status} />
                  </div>

                  <div className="judge-tiles">
                    {progress.current.missingJudges.map((j) => (
                      <div key={j.judgeId} className="judge-tile is-waiting">
                        <span className="judge-tile-status">
                          {j.queuedMarks > 0 ? `${j.queuedMarks} queued offline` : 'Waiting'}
                        </span>
                        {j.fullName}
                      </div>
                    ))}
                    {progress.current.submittedCount > 0 &&
                      Array.from({ length: progress.current.submittedCount }).map((_, i) => (
                        <div key={i} className="judge-tile is-submitted">
                          <span className="judge-tile-status">Submitted</span>
                        </div>
                      ))}
                  </div>

                  {/* ADM-09-04: marks visible only once COMPLETE. */}
                  {progress.current.status === 'COMPLETE' && progress.canSeeMarks && (
                    <div className="row-wrap">
                      {progress.current.judgeMarks.map((m) => (
                        <span key={m.judgeId} className="badge badge-neutral">
                          {m.judgeName}: {m.mark.toFixed(1)}
                        </span>
                      ))}
                      <span className="badge badge-award">
                        Aggregate: {progress.current.aggregate?.toFixed(2)}
                      </span>
                    </div>
                  )}

                  {can('MARK_ABSENT') && (
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        disabled={busy !== null}
                        onClick={() =>
                          action('absent', () =>
                            api.post(`/api/admin/performances/${progress.current!.performanceId}/absent`, {}),
                          )
                        }
                      >
                        Mark absent
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busy !== null}
                        onClick={() => {
                          const reason = window.prompt('Reason for voiding this performance (min. 15 characters):');
                          if (reason && reason.length >= 15) {
                            void action('void', () =>
                              api.post(`/api/admin/performances/${progress.current!.performanceId}/void`, { reason }),
                            );
                          }
                        }}
                      >
                        Void
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ADM-09-09: per-item progress, complementing the session-wide totals above. */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Progress by item</span>
            </div>
            <div className="card-body stack-sm">
              {progress.itemProgress.map((ip) => (
                <div key={ip.itemId} className="row-between">
                  <span className="text-sm">{ip.itemName}</span>
                  <div className="row" style={{ minWidth: 160 }}>
                    <ProgressBar value={ip.complete} max={ip.total} />
                    <span className="num text-sm muted">
                      {ip.complete}/{ip.total}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ADM-09-08: "the single most important operational feature in the system" */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Outstanding marks</span>
              <span className="badge badge-warning">{progress.outstanding.length}</span>
            </div>
            <div className="card-body">
              {progress.outstanding.length === 0 ? (
                <p className="muted">Nothing outstanding.</p>
              ) : (
                <div className="table-wrap" style={{ border: 'none' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Participant</th>
                        <th>Waiting on</th>
                      </tr>
                    </thead>
                    <tbody>
                      {progress.outstanding.map((row) => (
                        <tr key={row.performanceId}>
                          <td>{row.itemName}</td>
                          <td>{row.participantName}</td>
                          <td>{row.missingJudges.map((j) => j.fullName).join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/*
            One table per item, in the order the server sends them: lower
            category to higher (by age band), then item name, then call order
            (sessions.routes.ts /:id/progress) — see groupByItem() above.
          */}
          {groupByItem(progress.performances).map((group) => (
            <div key={group.itemId} className="stack-sm">
              <div className="row-between">
                <span className="strong">{group.itemName}</span>
                {group.categoryName && <span className="badge badge-neutral">{group.categoryName}</span>}
              </div>
              <div className="card-flush">
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Participant</th>
                        <th>Church</th>
                        <th>Status</th>
                        <th>Progress</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((p) => (
                        <tr key={p.performanceId} style={p.isCurrent ? { background: 'var(--surface-selected)' } : undefined}>
                          <td className="num">{p.callOrder ?? '—'}</td>
                          <td>
                            {p.chestNumber} · {p.participantName}
                          </td>
                          <td>{p.churchName}</td>
                          <td>
                            <StatusBadge status={p.status} />
                          </td>
                          <td className="num">
                            {p.submittedCount}/{p.panelSize}
                          </td>
                          <td>
                            {can('CONTROL_STAGE') && !p.isCurrent && p.status !== 'COMPLETE' && (
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                disabled={busy !== null}
                                onClick={() =>
                                  action('set-current', () =>
                                    api.post(`/api/admin/performances/${p.performanceId}/set-current`, {}),
                                  )
                                }
                              >
                                Set on stage
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
