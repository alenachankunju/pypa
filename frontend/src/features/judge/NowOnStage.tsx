/**
 * Screen J3 — Now on stage (FSD 6.2).
 *
 * "The Home screen shows the performance currently set as on stage by the
 * coordinator: chest number in large type, member name, church name, item name,
 * and the member photograph where available."
 */
import { useNavigate } from 'react-router-dom';
import { storageUrl } from '../../lib/realtime';
import { Avatar, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useJudgeSession } from './JudgeSession';
import { SessionPicker } from './SessionPicker';

export function NowOnStage() {
  const { sessionId, sessions, current, useManualSearch, loading, error, bundle } = useJudgeSession();
  const navigate = useNavigate();

  if (loading && !sessions) return <LoadingState label="Loading your sessions…" />;

  // JDG-01-03: "No active judging session assigned" with upcoming times shown,
  // and no scoring controls.
  if (!sessionId) {
    return <SessionPicker />;
  }

  if (error) return <ErrorState error={error} />;

  if (!bundle) return <LoadingState label="Loading session…" />;

  // JDG-02-05: "If no performance is currently on stage, the judge is shown the
  // manual search option instead."
  if (!current || useManualSearch) {
    return (
      <EmptyState
        icon={<Icon name="play" />}
        title="No participant on stage"
        body="The coordinator hasn't set a current performance yet. You can still find a participant by chest number."
        action={
          <button type="button" className="btn btn-primary" onClick={() => navigate('/judge/search')}>
            Search by chest number
          </button>
        }
      />
    );
  }

  const photo = storageUrl(current.photoPath);

  return (
    <div className="stack-lg">
      {/* JDG-02-04: "Participant 7 of 21" */}
      <p className="eyebrow" style={{ textAlign: 'center' }}>
        Participant {current.progress.position} of {current.progress.total} · {current.itemName}
      </p>

      <div className="card stage-card stack" style={{ alignItems: 'center', textAlign: 'center', padding: 'var(--space-6)' }}>
        {photo ? (
          <img
            src={photo}
            alt=""
            style={{
              width: 140,
              height: 140,
              borderRadius: 'var(--radius-xl)',
              objectFit: 'cover',
              border: '1px solid var(--border-subtle)',
            }}
          />
        ) : (
          <div style={{ width: 140, height: 140 }}>
            <Avatar name={current.participantName} size="lg" />
          </div>
        )}

        <div className="chest-number">{current.chestNumber ?? '—'}</div>
        <div className="participant-name">{current.participantName}</div>
        <div className="muted">{current.churchName}</div>
      </div>

      {current.myScore ? (
        // JDG-02-03: "the screen shows a clear submitted confirmation with their
        // own mark, and the scoring control is replaced by a disabled state."
        <div className="card stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <span className="badge badge-success">Submitted</span>
          <div className="mark-value">{current.myScore.mark.toFixed(1)}</div>
          <p className="text-sm muted">You cannot change a mark once submitted.</p>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          onClick={() => navigate(`/judge/score/${current.performanceId}`)}
        >
          Score this participant
        </button>
      )}
    </div>
  );
}
