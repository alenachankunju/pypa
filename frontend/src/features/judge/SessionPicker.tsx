/**
 * JDG-01-03: "If the judge has no open session, the screen states clearly 'No
 * active judging session assigned' and shows their upcoming sessions with
 * scheduled times. No scoring controls are shown."
 *
 * Also doubles as the picker when a judge is on more than one open session
 * (JDG-01-02 auto-selects only when there is exactly one).
 */
import { formatDateTime } from '../../lib/format';
import { EmptyState } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useJudgeSession } from './JudgeSession';

export function SessionPicker() {
  const { sessions, setSessionId } = useJudgeSession();

  if (!sessions || (sessions.open.length === 0 && sessions.upcoming.length === 0)) {
    return (
      <EmptyState
        icon={<Icon name="clock" />}
        title="No active judging session assigned"
        body="You have not been assigned to any session yet. Check with your administrator or coordinator."
      />
    );
  }

  if (sessions.open.length === 0) {
    return (
      <div className="stack">
        <EmptyState
          icon={<Icon name="clock" />}
          title="No active judging session assigned"
          body="Your sessions have not been opened yet. They will appear here as soon as they are."
        />
        <UpcomingList sessions={sessions.upcoming} />
      </div>
    );
  }

  return (
    <div className="stack">
      <h2 className="page-title">Choose a session</h2>
      <div className="stack-sm">
        {sessions.open.map((s) => (
          <button
            key={s.id}
            type="button"
            className="card is-interactive row-between"
            style={{ width: '100%', textAlign: 'left' }}
            onClick={() => setSessionId(s.id)}
          >
            <div>
              <div className="strong">{s.name}</div>
              <div className="text-sm muted">
                {s.panelName} · {s.stage ?? 'Stage not set'}
              </div>
            </div>
            {s.myOutstandingCount > 0 && (
              <span className="badge badge-warning">{s.myOutstandingCount} awaiting you</span>
            )}
          </button>
        ))}
      </div>
      {sessions.upcoming.length > 0 && <UpcomingList sessions={sessions.upcoming} />}
    </div>
  );
}

function UpcomingList({
  sessions,
}: {
  sessions: { id: string; name: string; scheduledStart: string | null }[];
}) {
  if (sessions.length === 0) return null;

  return (
    <div className="card">
      <p className="eyebrow" style={{ marginBottom: 'var(--space-2)' }}>
        Upcoming sessions
      </p>
      <div className="stack-sm">
        {sessions.map((s) => (
          <div key={s.id} className="row-between text-sm">
            <span>{s.name}</span>
            <span className="muted">{formatDateTime(s.scheduledStart)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
