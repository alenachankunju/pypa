/**
 * Screen A16 — Champions (FSD 5.12).
 * ADM-12-07: individual champion and category champions with qualifying detail.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { ErrorState, LoadingState, PageHeader } from '../../components/ui';

interface MemberStanding {
  rank: number;
  memberId: string;
  chestNumber: string;
  fullName: string;
  churchName: string;
  totalPoints: number;
  itemsCompeted: number;
  eligible: boolean;
  ineligibleReason: string | null;
  isChampion: boolean;
}
interface CategoryChampion {
  categoryId: string;
  categoryName: string;
  champion: MemberStanding | null;
  contenders: MemberStanding[];
}
interface ChampionsResponse {
  individual: { champion: MemberStanding | null; standings: MemberStanding[] };
  categories: CategoryChampion[];
}

export function Champions() {
  const [data, setData] = useState<ChampionsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<ChampionsResponse>('/api/admin/results/champions').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingState />;

  return (
    <div className="stack-lg">
      <PageHeader title="Champions" />

      <div className="card">
        <div className="card-header">
          <span className="card-title">Individual champion</span>
        </div>
        <div className="card-body">
          {data.individual.champion ? (
            <div className="row-between">
              <div>
                <div className="participant-name">{data.individual.champion.fullName}</div>
                <div className="text-sm muted">
                  {data.individual.champion.chestNumber} · {data.individual.champion.churchName}
                </div>
              </div>
              <span className="badge badge-award">{data.individual.champion.totalPoints} pts</span>
            </div>
          ) : (
            <p className="muted">No champion determined yet — no published results with points.</p>
          )}
        </div>
      </div>

      <div className="card-flush">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Member</th>
                <th>Church</th>
                <th>Points</th>
                <th>Items</th>
                <th>Eligible</th>
              </tr>
            </thead>
            <tbody>
              {data.individual.standings.slice(0, 25).map((m) => (
                <tr key={m.memberId} style={m.isChampion ? { background: 'var(--award-subtle)' } : undefined}>
                  <td className="num">{m.rank}</td>
                  <td>
                    {m.chestNumber} · {m.fullName}
                  </td>
                  <td>{m.churchName}</td>
                  <td className="num strong">{m.totalPoints}</td>
                  <td className="num">{m.itemsCompeted}</td>
                  <td>
                    {m.eligible ? (
                      <span className="badge badge-success">Yes</span>
                    ) : (
                      <span className="badge badge-neutral" title={m.ineligibleReason ?? ''}>
                        No
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {data.categories.length > 0 && (
        <div className="grid grid-3">
          {data.categories.map((cat) => (
            <div key={cat.categoryId} className="card">
              <p className="eyebrow">{cat.categoryName}</p>
              {cat.champion ? (
                <div className="stack-sm">
                  <div className="strong">{cat.champion.fullName}</div>
                  <div className="text-sm muted">{cat.champion.churchName}</div>
                  <span className="badge badge-award">{cat.champion.totalPoints} pts</span>
                </div>
              ) : (
                <p className="text-sm muted">No champion yet</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
