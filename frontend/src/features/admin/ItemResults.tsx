/**
 * Screen A14 — Item result (FSD 5.12).
 *
 * ADM-12-01: "Ranked list showing position, chest number, member name, church
 * name, each judge's individual mark, the aggregate, the grade, and the points
 * awarded."
 * ADM-12-02: an unresolved tie is clearly flagged and blocks Provisional.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { formatAggregate, tiebreakLabel } from '../../lib/format';
import {
  Banner,
  ConfirmDialog,
  ErrorState,
  LoadingState,
  PageHeader,
  PositionPill,
  StatusBadge,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface ResultRow {
  position: number | null;
  placed: boolean;
  performanceId: string;
  chestNumber: string | null;
  participantName: string;
  churchName: string | null;
  aggregate: number | null;
  grade: string | null;
  points: number;
  isSharedPosition: boolean;
  tieBreakApplied: string | null;
  tieBreakNote: string | null;
  manuallyResolved: boolean;
  performanceStatus: string;
  judgeMarks: { judgeId: string; judgeName: string; mark: number; isChief: boolean }[];
}

interface ItemResultResponse {
  item: { id: string; name: string; code: string; maxMark: number | null };
  publication: { state: string; hasUnresolvedTie: boolean; publishedAt: string | null };
  rows: ResultRow[];
  tiedGroups: { position: number; aggregate: number | null; rows: ResultRow[] }[];
}

export function ItemResults() {
  const { itemId = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [data, setData] = useState<ItemResultResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<'publish' | 'unpublish' | 'provisional' | null>(null);
  const [reason, setReason] = useState('');
  const [tieDecisions, setTieDecisions] = useState<Record<string, number>>({});

  const load = useCallback(() => {
    api
      .get<ItemResultResponse>(`/api/admin/results/items/${itemId}`, { recompute: 'true' })
      .then(setData)
      .catch(setError);
  }, [itemId]);

  useEffect(load, [load]);

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!data) return <LoadingState />;

  async function runAction(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      setConfirming(null);
      setReason('');
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitTieDecisions(tieGroup: ItemResultResponse['tiedGroups'][number]) {
    const decisions = tieGroup.rows.map((row) => ({
      performanceId: row.performanceId,
      assignedPosition: tieDecisions[row.performanceId] ?? tieGroup.position,
    }));

    if (new Set(decisions.map((d) => d.assignedPosition)).size !== decisions.length) {
      setError(new Error('Each performance in the tie must be given a distinct position, unless declaring a shared position.'));
      return;
    }

    const justification = window.prompt(
      'Justification for this tie decision (min. 15 characters, printed on the result sheet):',
    );
    if (!justification || justification.length < 15) return;

    await runAction(() =>
      api.post(`/api/admin/results/items/${itemId}/resolve-tie`, { decisions, reason: justification }),
    );
  }

  return (
    <div className="stack-lg">
      <PageHeader
        title={data.item.name}
        subtitle={`${data.item.code} · Max mark ${data.item.maxMark ?? '—'}`}
        actions={
          <>
            <StatusBadge status={data.publication.state} />
            {can('VIEW_PROVISIONAL_RESULTS') && data.publication.state === 'READY' && (
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming('provisional')}>
                Mark provisional
              </button>
            )}
            {can('PUBLISH_RESULTS') &&
              (data.publication.state === 'PROVISIONAL' || data.publication.state === 'READY') && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={data.publication.hasUnresolvedTie}
                  onClick={() => setConfirming('publish')}
                >
                  Publish
                </button>
              )}
            {can('PUBLISH_RESULTS') && data.publication.state === 'PUBLISHED' && (
              <button type="button" className="btn btn-danger" onClick={() => setConfirming('unpublish')}>
                Unpublish
              </button>
            )}
          </>
        }
      />

      {data.publication.hasUnresolvedTie && (
        <Banner tone="danger" title="This item has a tie that requires a decision">
          The automated tie-break sequence could not separate the performances below. Publication is
          blocked until an administrator decides (FSD 4.5).
        </Banner>
      )}

      {data.tiedGroups.map((group) => (
        <div key={group.position} className="card" style={{ borderColor: 'var(--danger)' }}>
          <div className="card-header">
            <span className="card-title">
              Tie at position {group.position} — aggregate {formatAggregate(group.aggregate)}
            </span>
          </div>
          <div className="card-body stack">
            <div className="table-wrap" style={{ border: 'none' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Participant</th>
                    {group.rows[0]?.judgeMarks.map((m) => <th key={m.judgeId}>{m.judgeName}</th>)}
                    <th>Assign position</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.performanceId}>
                      <td>
                        {row.chestNumber} · {row.participantName} ({row.churchName})
                      </td>
                      {row.judgeMarks.map((m) => (
                        <td key={m.judgeId} className="num">
                          {m.mark.toFixed(1)}
                          {m.isChief ? ' (chief)' : ''}
                        </td>
                      ))}
                      <td>
                        <input
                          type="number"
                          className="input"
                          style={{ width: 80 }}
                          min={1}
                          value={tieDecisions[row.performanceId] ?? group.position}
                          onChange={(e) =>
                            setTieDecisions((prev) => ({
                              ...prev,
                              [row.performanceId]: Number(e.target.value),
                            }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {can('VIEW_PROVISIONAL_RESULTS') && (
              <button type="button" className="btn btn-primary" onClick={() => void submitTieDecisions(group)}>
                Record decision
              </button>
            )}
          </div>
        </div>
      ))}

      <div className="card-flush">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Pos</th>
                <th>Chest</th>
                <th>Participant</th>
                <th>Church</th>
                {data.rows[0]?.judgeMarks.map((m) => <th key={m.judgeId}>{m.judgeName}</th>)}
                <th>Aggregate</th>
                <th>Grade</th>
                <th>Points</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.performanceId}>
                  <td>
                    <PositionPill position={row.position} placed={row.placed} />
                    {row.isSharedPosition && <span className="badge badge-info" style={{ marginLeft: 4 }}>Shared</span>}
                  </td>
                  <td>{row.chestNumber ?? '—'}</td>
                  <td>{row.participantName}</td>
                  <td>{row.churchName ?? '—'}</td>
                  {row.judgeMarks.length > 0
                    ? row.judgeMarks.map((m) => (
                        <td key={m.judgeId} className="num">
                          {m.mark.toFixed(1)}
                        </td>
                      ))
                    : (data.rows[0]?.judgeMarks ?? []).map((_, i) => <td key={i}>—</td>)}
                  <td className="num">{formatAggregate(row.aggregate)}</td>
                  <td>{row.grade ?? '—'}</td>
                  <td className="num strong">{row.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {data.rows.some((r) => r.tieBreakApplied) && (
        <div className="card">
          <p className="eyebrow" style={{ marginBottom: 'var(--space-2)' }}>
            Tie-break notes
          </p>
          <div className="stack-sm text-sm">
            {data.rows
              .filter((r) => r.tieBreakApplied)
              .map((r) => (
                <div key={r.performanceId}>
                  <strong>{r.participantName}:</strong>{' '}
                  {r.tieBreakNote ?? tiebreakLabel[r.tieBreakApplied!]}
                </div>
              ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming === 'publish' ? 'Publish this result?' : confirming === 'unpublish' ? 'Unpublish this result?' : 'Mark provisional?'
        }
        consequence={
          confirming === 'publish'
            ? 'This locks the result and contributes it to church totals and the championship. It can only be undone by unpublishing.'
            : confirming === 'unpublish'
              ? 'Church totals and the championship will be recalculated. Any announced result may change.'
              : 'This signals the result has been reviewed and is awaiting sign-off.'
        }
        reasonLabel={confirming === 'unpublish' ? 'Reason for unpublishing' : undefined}
        reasonMinLength={15}
        reason={reason}
        onReasonChange={setReason}
        busy={busy}
        tone={confirming === 'unpublish' ? 'danger' : 'primary'}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming === 'publish') void runAction(() => api.post(`/api/admin/results/items/${itemId}/publish`, {}));
          if (confirming === 'unpublish') void runAction(() => api.post(`/api/admin/results/items/${itemId}/unpublish`, { reason }));
          if (confirming === 'provisional') void runAction(() => api.post(`/api/admin/results/items/${itemId}/provisional`, {}));
        }}
      />

      <button type="button" className="btn btn-ghost" onClick={() => navigate(-1)}>
        ← Back to results
      </button>
    </div>
  );
}
