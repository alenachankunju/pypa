/**
 * Screen A15 — Church leaderboard (FSD 5.12, ADM-12-06, ADM-12-08).
 * "Total points, first-place count, second-place count, participant count,
 * ranked, with the champion highlighted."
 */
import { useEffect, useState } from 'react';
import { api, type ApiMeta } from '../../lib/api';
import { ErrorState, LoadingState, PageHeader } from '../../components/ui';

interface ChurchStanding {
  rank: number;
  churchId: string;
  churchName: string;
  shortCode: string;
  totalPoints: number;
  firstPlaces: number;
  secondPlaces: number;
  thirdPlaces: number;
  memberCount: number;
  isChampion: boolean;
  isTied: boolean;
}

export function ChurchLeaderboard() {
  const [provisional, setProvisional] = useState(false);
  const [rows, setRows] = useState<ChurchStanding[] | null>(null);
  const [meta, setMeta] = useState<ApiMeta>({});
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getWithMeta<ChurchStanding[]>('/api/admin/results/churches', { provisional: String(provisional) })
      .then((r) => {
        if (cancelled) return;
        setRows(r.data);
        setMeta(r.meta ?? {});
      })
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [provisional]);

  if (error) return <ErrorState error={error} />;

  return (
    <div className="stack-lg">
      <PageHeader
        icon="🏆"
        title="Church leaderboard"
        subtitle={
          typeof meta.unpublishedItemCount === 'number'
            ? `${meta.unpublishedItemCount as number} item(s) still unpublished`
            : undefined
        }
        actions={
          <label className="row text-sm">
            <input type="checkbox" checked={provisional} onChange={(e) => setProvisional(e.target.checked)} />
            Include unpublished (provisional preview)
          </label>
        }
      />

      {typeof meta.watermark === 'string' && (
        <div className="banner banner-warning">
          <span className="banner-icon" aria-hidden="true">⚠</span>
          <div className="banner-title">{meta.watermark}</div>
        </div>
      )}

      {!rows ? (
        <LoadingState />
      ) : (
        <div className="card-flush">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Church</th>
                  <th>Points</th>
                  <th>1st</th>
                  <th>2nd</th>
                  <th>3rd</th>
                  <th>Members</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.churchId}
                    style={row.isChampion ? { background: 'var(--award-subtle)' } : undefined}
                  >
                    <td className="num strong">
                      {row.rank}
                      {row.isChampion && <span className="badge badge-award" style={{ marginLeft: 6 }}>Champion</span>}
                      {row.isTied && !row.isChampion && (
                        <span className="badge badge-neutral" style={{ marginLeft: 6 }}>Tied</span>
                      )}
                    </td>
                    <td>
                      {row.churchName} <span className="muted">({row.shortCode})</span>
                    </td>
                    <td className="num strong">{row.totalPoints}</td>
                    <td className="num">{row.firstPlaces}</td>
                    <td className="num">{row.secondPlaces}</td>
                    <td className="num">{row.thirdPlaces}</td>
                    <td className="num">{row.memberCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
