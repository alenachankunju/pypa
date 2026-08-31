/**
 * Screen A9 — Judge list / form (FSD 5.7).
 * ADM-07-04: submitted counts and outstanding marks per judge, "the fastest way
 * to identify the judge holding up an item."
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { ErrorState, Field, LoadingState, PageHeader, Sheet } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface JudgeRow {
  id: string;
  username: string;
  fullName: string;
  role: string;
  isActive: boolean;
  isLocked: boolean;
  scoresSubmitted: number;
  outstandingMarks: number;
  meanDeviation: number | null;
}

export function Judges() {
  const { can } = useAuth();
  const [rows, setRows] = useState<JudgeRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState<{ fullName: string; username: string; role: string } | null>(null);
  const [created, setCreated] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    api.get<JudgeRow[]>('/api/admin/users', { role: 'JUDGE', pageSize: 200 }).then(setRows).catch(setError);
  }

  useEffect(load, []);

  async function saveNew() {
    if (!creating) return;
    setSaving(true);
    try {
      const result = await api.post<{ username: string; temporaryPassword: string }>('/api/admin/users', {
        fullName: creating.fullName,
        username: creating.username,
        role: 'JUDGE',
      });
      setCreated(result);
      setCreating(null);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function forceLogout(id: string) {
    await api.post(`/api/admin/users/${id}/force-logout`, {});
    load();
  }

  async function resetPassword(id: string) {
    const result = await api.post<{ temporaryPassword: string; username: string }>(
      `/api/admin/users/${id}/reset-password`,
      {},
    );
    setCreated(result);
  }

  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Judges"
        actions={
          can('MANAGE_JUDGE_ACCOUNTS') && (
            <button type="button" className="btn btn-primary" onClick={() => setCreating({ fullName: '', username: '', role: 'JUDGE' })}>
              + Add judge
            </button>
          )
        }
      />

      {!rows ? (
        <LoadingState />
      ) : (
        <div className="card-flush">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Submitted</th>
                  <th>Outstanding</th>
                  <th>Deviation</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((j) => (
                  <tr key={j.id} style={!j.isActive ? { opacity: 0.5 } : undefined}>
                    <td>
                      {j.fullName}
                      {j.isLocked && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Locked</span>}
                    </td>
                    <td>{j.username}</td>
                    <td className="num">{j.scoresSubmitted}</td>
                    <td className="num" style={j.outstandingMarks > 0 ? { color: 'var(--warning-text)', fontWeight: 700 } : undefined}>
                      {j.outstandingMarks}
                    </td>
                    <td className="num">{j.meanDeviation != null ? j.meanDeviation.toFixed(2) : '—'}</td>
                    <td className="row">
                      {can('MANAGE_JUDGE_ACCOUNTS') && (
                        <>
                          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void resetPassword(j.id)}>
                            Reset password
                          </button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void forceLogout(j.id)}>
                            Force logout
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Sheet open={creating !== null} onClose={() => setCreating(null)} title="Add judge">
        {creating && (
          <div className="stack">
            <Field label="Full name" required>
              <input className="input" value={creating.fullName} onChange={(e) => setCreating({ ...creating, fullName: e.target.value })} />
            </Field>
            <Field label="Username" required>
              <input className="input" value={creating.username} onChange={(e) => setCreating({ ...creating, username: e.target.value })} />
            </Field>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void saveNew()}>
                {saving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={created !== null} onClose={() => setCreated(null)} title="Temporary password">
        {created && (
          <div className="stack">
            <p>
              Username: <strong>{created.username}</strong>
            </p>
            <p className="mark-value">{created.temporaryPassword}</p>
            <div className="banner banner-warning">
              Give this password to the user directly. It is shown only once and cannot be retrieved again.
            </div>
            <button type="button" className="btn btn-primary" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        )}
      </Sheet>
    </div>
  );
}
