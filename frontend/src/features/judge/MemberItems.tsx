/**
 * Screen J5 — Member items (FSD 6.4).
 *
 * JDG-04-01/02: every item the member is registered in, within the session,
 * each with its per-judge status.
 * JDG-04-03: items outside the session shown greyed with the reason, by default.
 * JDG-04-04: "If the selected item is not the one currently on stage, a
 * prominent warning appears ... The judge must acknowledge before continuing."
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Avatar, ErrorState, LoadingState } from '../../components/ui';
import { useJudgeSession } from './JudgeSession';

interface MemberItemsResponse {
  member: {
    id: string;
    chestNumber: string;
    fullName: string;
    photoPath: string | null;
    churchName: string;
    categoryName: string | null;
  };
  items: {
    itemId: string;
    itemName: string;
    itemCode: string;
    maxMark: number;
    performanceId: string | null;
    performanceStatus: string | null;
    isOnStage: boolean;
    available: boolean;
    myStatus: 'SCORED_BY_YOU' | 'COMPLETE' | 'NOT_YET_SCORED' | 'NOT_IN_SESSION';
    myMark: number | null;
    unavailableReason: string | null;
  }[];
}

const STATUS_LABEL: Record<MemberItemsResponse['items'][number]['myStatus'], string> = {
  SCORED_BY_YOU: 'Already scored by you',
  COMPLETE: 'Awaiting other judges',
  NOT_YET_SCORED: 'Not yet scored',
  NOT_IN_SESSION: 'Not in your session',
};

export function MemberItems() {
  const { memberId = '' } = useParams();
  const { sessionId, current } = useJudgeSession();
  const navigate = useNavigate();
  const [data, setData] = useState<MemberItemsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    api
      .get<MemberItemsResponse>(`/api/judge/members/${memberId}/items`, { sessionId })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e));

    return () => {
      cancelled = true;
    };
  }, [memberId, sessionId]);

  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingState />;

  const handleSelect = (item: MemberItemsResponse['items'][number]) => {
    if (!item.available || !item.performanceId) return;
    if (item.myStatus === 'SCORED_BY_YOU') return;

    // JDG-04-04: block navigation to mark entry until the mismatch is
    // acknowledged, if this item is not the one on stage.
    if (current && current.itemId !== item.itemId) {
      navigate(`/judge/score/${item.performanceId}?confirmMismatch=${encodeURIComponent(current.itemName)}`);
      return;
    }

    navigate(`/judge/score/${item.performanceId}`);
  };

  return (
    <div className="stack">
      <div className="card row">
        <Avatar name={data.member.fullName} size="lg" />
        <div>
          <div className="participant-name">{data.member.fullName}</div>
          <div className="text-sm muted">
            Chest {data.member.chestNumber} · {data.member.churchName}
            {data.member.categoryName ? ` · ${data.member.categoryName}` : ''}
          </div>
        </div>
      </div>

      <div className="stack-sm">
        {data.items.map((item) => {
          const disabled = !item.available || item.myStatus === 'SCORED_BY_YOU';

          return (
            <button
              key={item.itemId}
              type="button"
              className="card row-between"
              style={{
                width: '100%',
                textAlign: 'left',
                opacity: item.available ? 1 : 0.55,
                cursor: disabled ? 'default' : 'pointer',
              }}
              onClick={() => handleSelect(item)}
              disabled={disabled && item.myStatus !== 'SCORED_BY_YOU'}
            >
              <div>
                <div className="strong">{item.itemName}</div>
                <div className="text-sm muted">
                  {item.itemCode}
                  {item.unavailableReason ? ` · ${item.unavailableReason}` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {item.myStatus === 'SCORED_BY_YOU' ? (
                  <span className="badge badge-success">You: {item.myMark?.toFixed(1)}</span>
                ) : (
                  <span
                    className={`badge ${item.myStatus === 'COMPLETE' ? 'badge-info' : 'badge-neutral'}`}
                  >
                    {STATUS_LABEL[item.myStatus]}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
