/**
 * Screen A2 — Church list / form (FSD 5.2).
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { ErrorState, Field, LoadingState, PageHeader, Sheet } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface Church {
  id: string;
  name: string;
  shortCode: string;
  zone: string | null;
  contactPerson: string | null;
  contactMobile: string | null;
  isActive: boolean;
  memberCount: number;
  registrationCount: number;
  hasNoEntries: boolean;
}

export function Churches() {
  const { can } = useAuth();
  const [rows, setRows] = useState<Church[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Partial<Church> | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    api
      .get<Church[]>('/api/admin/churches', { search: search || undefined, pageSize: 200 })
      .then(setRows)
      .catch(setError);
  }

  useEffect(load, [search]);

  async function save() {
    if (!editing) return;
    setSaving(true);
    try {
      if (editing.id) {
        await api.patch(`/api/admin/churches/${editing.id}`, {
          name: editing.name,
          shortCode: editing.shortCode,
          zone: editing.zone,
          contactPerson: editing.contactPerson,
          contactMobile: editing.contactMobile,
        });
      } else {
        await api.post('/api/admin/churches', {
          name: editing.name,
          shortCode: editing.shortCode,
          zone: editing.zone,
          contactPerson: editing.contactPerson,
          contactMobile: editing.contactMobile,
        });
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Churches"
        subtitle="Global master data, reused across events"
        actions={
          can('MANAGE_CHURCHES') && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing({ isActive: true })}>
              + Add church
            </button>
          )
        }
      />

      <input
        className="input"
        placeholder="Search by name or code"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ maxWidth: 320 }}
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
                  <th>Code</th>
                  <th>Zone</th>
                  <th>Members</th>
                  <th>Registrations</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.shortCode}</td>
                    <td>{c.zone ?? '—'}</td>
                    <td className="num">{c.memberCount}</td>
                    <td className="num">
                      {c.registrationCount}
                      {/* ADM-02-04: spot a church that has not submitted entries. */}
                      {c.hasNoEntries && c.memberCount > 0 && (
                        <span className="badge badge-warning" style={{ marginLeft: 6 }}>
                          No entries
                        </span>
                      )}
                    </td>
                    <td>
                      {can('MANAGE_CHURCHES') && (
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(c)}>
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? 'Edit church' : 'Add church'}>
        {editing && (
          <div className="stack">
            <Field label="Name" required>
              <input
                className="input"
                value={editing.name ?? ''}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="Short code" required hint="3–6 letters/numbers, used on badges and result sheets">
              <input
                className="input"
                maxLength={6}
                value={editing.shortCode ?? ''}
                onChange={(e) => setEditing({ ...editing, shortCode: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field label="Zone / district">
              <input
                className="input"
                value={editing.zone ?? ''}
                onChange={(e) => setEditing({ ...editing, zone: e.target.value })}
              />
            </Field>
            <Field label="Contact person">
              <input
                className="input"
                value={editing.contactPerson ?? ''}
                onChange={(e) => setEditing({ ...editing, contactPerson: e.target.value })}
              />
            </Field>
            <Field label="Contact mobile">
              <input
                className="input"
                value={editing.contactMobile ?? ''}
                onChange={(e) => setEditing({ ...editing, contactMobile: e.target.value })}
              />
            </Field>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
