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

interface FilterOptions {
  entityTypes: string[];
  actors: { id: string; name: string }[];
  knownActions: string[];
}

export function AuditLog() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [actorId, setActorId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filters, setFilters] = useState<FilterOptions>({ entityTypes: [], actors: [], knownActions: [] });
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<FilterOptions>('/api/admin/audit/filters')
      .then(setFilters)
      .catch(() => undefined);
  }, []);

  function load() {
    api
      .get<AuditRow[]>('/api/admin/audit', {
        search: search || undefined,
        action: action || undefined,
        entityType: entityType || undefined,
        actorId: actorId || undefined,
        from: from || undefined,
        to: to || undefined,
        pageSize: 100,
      })
      .then(setRows)
      .catch(setError);
  }

  useEffect(load, [search, action, entityType, actorId, from, to]);

  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <div className="stack-lg">
      <PageHeader title="Audit log" subtitle="Append-only — cannot be edited or deleted" />

      <div className="row-wrap">
        <input className="input" placeholder="Search actor, reason or action" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 280 }} />
        <select className="select" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {filters.knownActions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select className="select" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
          <option value="">All entity types</option>
          {filters.entityTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select className="select" value={actorId} onChange={(e) => setActorId(e.target.value)}>
          <option value="">All actors</option>
          {filters.actors.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <label className="row text-sm" style={{ gap: 'var(--space-1)' }}>
          From
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="row text-sm" style={{ gap: 'var(--space-1)' }}>
          To
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
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
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-sm muted" style={{ textAlign: 'center', padding: 'var(--space-4)' }}>
                      No entries match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
