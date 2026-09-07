/**
 * Screen A1 — Dashboard (FSD 10.4.2).
 * "Churches, members, items, sessions; outstanding marks; unpublished item count."
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { ErrorState, LoadingState, PageHeader, StatCard } from '../../components/ui';
import { useAuth } from '../../lib/auth';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

interface DashboardData {
  counts: {
    churches: number;
    categories: number;
    items: number;
    members: number;
    registrations: number;
    judges: number;
    panels: number;
    sessions: number;
    openSessions: number;
  };
  openSessions: { id: string; name: string; stage: string | null; total: number; resolved: number }[];
  outstandingMarks: {
    performanceId: string;
    sessionName: string;
    itemName: string;
    chestNumber: string | null;
    participantName: string;
    submittedCount: number;
    panelSize: number;
    missingJudges: { fullName: string }[];
  }[];
  results: { total: number; published: number; unpublished: number; withUnresolvedTies: number };
  recentActivity: { id: number; occurredAt: string; actorName: string | null; action: string; reason: string | null }[];
}

interface ChecklistStep {
  step: number;
  action: string;
  blocks: string | null;
  complete: boolean | null;
  detail: string;
}

export function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [checklist, setChecklist] = useState<{ steps: ChecklistStep[]; nextStep: ChecklistStep | null } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.get<DashboardData>('/api/admin/dashboard'),
      api.get<{ steps: ChecklistStep[]; nextStep: ChecklistStep | null }>('/api/admin/dashboard/setup-checklist'),
    ])
      .then(([d, c]) => {
        if (cancelled) return;
        setData(d);
        setChecklist(c);
      })
      .catch((e) => !cancelled && setError(e));

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingState label="Loading dashboard…" />;

  return (
    <div className="stack-lg">
      <PageHeader
        title={`${greeting()}${user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}`}
        subtitle="Here's where the event stands right now."
      />

      {checklist?.nextStep && (
        <div className="banner banner-info">
          <span className="banner-icon" aria-hidden="true">
            ℹ
          </span>
          <div>
            <div className="banner-title">Next setup step: {checklist.nextStep.action}</div>
            <div className="text-sm">{checklist.nextStep.detail}</div>
          </div>
        </div>
      )}

      <div className="grid grid-4">
        <StatCard value={data.counts.churches} label="Churches" />
        <StatCard value={data.counts.members} label="Members" />
        <StatCard value={data.counts.items} label="Items" />
        <StatCard value={data.counts.registrations} label="Registrations" />
        <StatCard value={data.counts.judges} label="Judges" />
        <StatCard value={data.counts.panels} label="Panels" />
        <StatCard value={data.counts.openSessions} label="Open sessions" tone={data.counts.openSessions > 0 ? 'success' : 'default'} />
        {/* ADM-12-09: unpublished item count, so nobody announces early. */}
        <StatCard
          value={data.results.unpublished}
          label="Unpublished items"
          tone={data.results.unpublished > 0 ? 'warning' : 'success'}
          hint={data.results.withUnresolvedTies > 0 ? `${data.results.withUnresolvedTies} with unresolved ties` : undefined}
        />
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Outstanding marks</span>
          <Link to="/admin/live" className="btn btn-sm btn-secondary">
            Open live console
          </Link>
        </div>
        <div className="card-body">
          {data.outstandingMarks.length === 0 ? (
            <p className="muted">Nothing outstanding right now.</p>
          ) : (
            <div className="table-wrap" style={{ border: 'none' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Item</th>
                    <th>Participant</th>
                    <th>Progress</th>
                    <th>Waiting on</th>
                  </tr>
                </thead>
                <tbody>
                  {data.outstandingMarks.slice(0, 15).map((row) => (
                    <tr key={row.performanceId}>
                      <td>{row.sessionName}</td>
                      <td>{row.itemName}</td>
                      <td>
                        {row.chestNumber ?? '—'} · {row.participantName}
                      </td>
                      <td className="num">
                        {row.submittedCount}/{row.panelSize}
                      </td>
                      <td>{row.missingJudges.map((j) => j.fullName).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Recent activity</span>
          <Link to="/admin/audit" className="btn btn-sm btn-secondary">
            View audit log
          </Link>
        </div>
        <div className="card-body stack-sm">
          {data.recentActivity.map((entry) => (
            <div key={entry.id} className="row-between text-sm">
              <span>
                <strong>{entry.actorName ?? 'System'}</strong> — {entry.action}
                {entry.reason ? ` (${entry.reason})` : ''}
              </span>
              <span className="muted">{relativeTime(entry.occurredAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
