/**
 * Screen A2 — Church list / form (FSD 5.2).
 */
import { useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { AlertDialog, ConfirmDialog, ErrorState, Field, LoadingState, PageHeader, Sheet } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface Church {
  id: string;
  name: string;
  shortCode: string;
  zone: string | null;
  contactPerson: string | null;
  contactMobile: string | null;
  contactEmail: string | null;
  logoPath: string | null;
  isActive: boolean;
  memberCount: number;
  registrationCount: number;
  hasNoEntries: boolean;
}

export function Churches() {
  const { can } = useAuth();
  const [rows, setRows] = useState<Church[] | null>(null);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState('true');
  const [error, setError] = useState<unknown>(null);
  const [alertError, setAlertError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Partial<Church> | null>(null);
  const [deactivating, setDeactivating] = useState<Church | null>(null);
  const [deleting, setDeleting] = useState<Church | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    api
      .get<Church[]>('/api/admin/churches', {
        search: search || undefined,
        isActive: activeFilter || undefined,
        pageSize: 200,
      })
      .then(setRows)
      .catch(setError);
  }

  useEffect(load, [search, activeFilter]);

  async function save() {
    if (!editing) return;
    setSaving(true);
    try {
      const payload = {
        name: editing.name,
        shortCode: editing.shortCode,
        zone: editing.zone,
        contactPerson: editing.contactPerson,
        contactMobile: editing.contactMobile,
        contactEmail: editing.contactEmail,
        logoPath: editing.logoPath,
      };
      if (editing.id) {
        await api.patch(`/api/admin/churches/${editing.id}`, payload);
      } else {
        await api.post('/api/admin/churches', payload);
      }
      setEditing(null);
      load();
    } catch (err) {
      setAlertError(err);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDeactivate() {
    if (!deactivating) return;
    setSaving(true);
    try {
      const result = await api.patch<{ notice?: string }>(`/api/admin/churches/${deactivating.id}`, {
        isActive: false,
      });
      setDeactivating(null);
      setNotice(result.notice ?? `${deactivating.name} deactivated — hidden from new-member dropdowns.`);
      load();
    } catch (err) {
      setAlertError(err);
    } finally {
      setSaving(false);
    }
  }

  async function reactivate(church: Church) {
    try {
      await api.patch(`/api/admin/churches/${church.id}`, { isActive: true });
      setNotice(`${church.name} reactivated.`);
      load();
    } catch (err) {
      setAlertError(err);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setSaving(true);
    try {
      await api.del(`/api/admin/churches/${deleting.id}`);
      setNotice(`${deleting.name} deleted.`);
      setDeleting(null);
      load();
    } catch (err) {
      setDeleting(null);
      if (err instanceof ApiError && err.code === 'IN_USE') {
        setNotice(err.message);
      } else {
        setAlertError(err);
      }
    } finally {
      setSaving(false);
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <div className="stack-lg">
      <PageHeader
        icon="⛪"
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

      {notice && (
        <div className="banner banner-success">
          <span className="grow">{notice}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="row row-wrap">
        <input
          className="input"
          placeholder="Search by name or code"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 320 }}
        />
        <select className="input" value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="true">Active only</option>
          <option value="false">Inactive only</option>
          <option value="">All statuses</option>
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
                  <tr key={c.id} style={!c.isActive ? { opacity: 0.5 } : undefined}>
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
                    <td className="row row-wrap">
                      {can('MANAGE_CHURCHES') && (
                        <>
                          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(c)}>
                            Edit
                          </button>
                          {c.isActive ? (
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeactivating(c)}>
                              Deactivate
                            </button>
                          ) : (
                            <button type="button" className="btn btn-sm btn-secondary" onClick={() => void reactivate(c)}>
                              Reactivate
                            </button>
                          )}
                          <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeleting(c)}>
                            Delete
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
            <Field label="Contact email">
              <input
                className="input"
                type="email"
                value={editing.contactEmail ?? ''}
                onChange={(e) => setEditing({ ...editing, contactEmail: e.target.value })}
              />
            </Field>
            <Field label="Logo URL" hint="A hosted image URL, printed on badges and result sheets">
              <input
                className="input"
                value={editing.logoPath ?? ''}
                onChange={(e) => setEditing({ ...editing, logoPath: e.target.value })}
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

      <ConfirmDialog
        open={deactivating !== null}
        title="Deactivate church"
        consequence={
          <>
            <strong>{deactivating?.name}</strong> will be hidden from new-member dropdowns. Existing members,
            registrations and results are unaffected (ADM-02-01, FSD 12.2).
          </>
        }
        confirmLabel="Deactivate"
        busy={saving}
        onConfirm={() => void confirmDeactivate()}
        onCancel={() => setDeactivating(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="Delete church"
        consequence={<><strong>{deleting?.name}</strong> will be permanently deleted. This cannot be undone.</>}
        confirmLabel="Delete"
        busy={saving}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />

      <AlertDialog error={alertError} onClose={() => setAlertError(null)} />
    </div>
  );
}
