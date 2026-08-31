/**
 * Screen A17 — Reports (FSD 5.13).
 *
 * The exceptions report (ADM-10-04) is rendered directly here since its data is
 * already assembled server-side; PDF/Excel generation for the other report
 * types is a Phase 4 backend deliverable (FSD 16) — this screen is the
 * navigable placeholder for those exports plus the fully working exceptions
 * view.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { ErrorState, LoadingState, PageHeader } from '../../components/ui';

interface ExceptionsReport {
  revokedScores: { id: string; mark: number; item_name: string; judge_name: string; revoked_reason: string }[];
  voidedPerformances: { id: string; item_name: string; void_reason: string }[];
  absentees: { id: string; item_name: string; chest_number: string | null }[];
  forcedSessionClosures: { id: string; name: string; force_closed_reason: string }[];
  totals: Record<string, number>;
}

const REPORT_TYPES = [
  'Item result sheet',
  'Consolidated results',
  'Church leaderboard',
  'Church detail sheet',
  'Individual champion sheet',
  'Participation list / call sheet',
  'Judge activity report',
  'Certificates',
  'Badge sheet',
];

export function Reports() {
  const [exceptions, setExceptions] = useState<ExceptionsReport | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<ExceptionsReport>('/api/admin/audit/exceptions').then(setExceptions).catch(setError);
  }, []);

  if (error) return <ErrorState error={error} />;

  return (
    <div className="stack-lg">
      <PageHeader title="Reports" subtitle="Export result sheets, leaderboards and exception reports" />

      <div className="card">
        <p className="eyebrow" style={{ marginBottom: 'var(--space-3)' }}>
          Available reports
        </p>
        <div className="grid grid-3">
          {REPORT_TYPES.map((name) => (
            <div key={name} className="card row-between" style={{ background: 'var(--surface-sunken)' }}>
              <span className="text-sm">{name}</span>
              <span className="badge badge-neutral">PDF / Excel</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Exceptions report</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => window.print()}>
            Print
          </button>
        </div>
        <div className="card-body">
          {!exceptions ? (
            <LoadingState />
          ) : (
            <div className="grid grid-2">
              <ExceptionList title="Revoked scores" items={exceptions.revokedScores.map((r) => `${r.item_name} · ${r.judge_name} · ${r.mark} · ${r.revoked_reason}`)} />
              <ExceptionList title="Voided performances" items={exceptions.voidedPerformances.map((r) => `${r.item_name} · ${r.void_reason}`)} />
              <ExceptionList title="Absentees" items={exceptions.absentees.map((r) => `${r.item_name} · ${r.chest_number ?? '—'}`)} />
              <ExceptionList title="Forced session closures" items={exceptions.forcedSessionClosures.map((r) => `${r.name} · ${r.force_closed_reason}`)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExceptionList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="strong text-sm" style={{ marginBottom: 'var(--space-2)' }}>
        {title} ({items.length})
      </p>
      {items.length === 0 ? (
        <p className="text-sm muted">None</p>
      ) : (
        <ul className="stack-sm text-sm" style={{ listStyle: 'none' }}>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
