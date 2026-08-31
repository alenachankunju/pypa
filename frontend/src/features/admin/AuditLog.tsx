/**
 * Screen A18 — Audit log (FSD 5.14).
 * ADM-14-04: searchable by date range, user, action type and entity. Read-only.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { ErrorState, LoadingState, PageHeader } from '../../components/ui';

interface AuditRow {
  id: number;
  occurredAt: string;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  reason: string | null;
}

export function AuditLog() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [actions, setActions] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<{ knownActions: string[] }>('/api/admin/audit/filters')
      .then((r) => setActions(r.knownActions))
      .catch(() => undefined);
  }, []);

  function load() {
    api
      .get<AuditRow[]>('/api/admin/audit', { search: search || undefined, action: action || undefined, pageSize: 100 })
      .then(setRows)
      .catch(setError);
  }

  useEffect(load, [search, action]);

  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <div className="stack-lg">
      <PageHeader title="Audit log" subtitle="Append-only — cannot be edited or deleted" />

      <div className="row-wrap">
        <input className="input" placeholder="Search actor, reason or action" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
        <select className="select" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {!rows ? (
        <LoadingState />
      ) : (
        <div className="card-flush">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDateTime(r.occurredAt)}</td>
                    <td>
                      {r.actorName ?? 'System'}
                      {r.actorRole && <div className="text-xs muted">{r.actorRole}</div>}
                    </td>
                    <td>{r.action}</td>
                    <td>
                      {r.entityType}
                      {r.entityId && <div className="text-xs muted">{r.entityId.slice(0, 8)}</div>}
                    </td>
                    <td className="text-sm">{r.reason ?? '—'}</td>
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
