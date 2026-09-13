/**
 * Screen A9 — User accounts (FSD 5.1.2, 5.7).
 *
 * Covers every account role, not only judges: ADM-01-10 requires a way to
 * create Admin/Super Admin/Coordinator accounts too, and ADM-01-14 requires
 * search/role/active filtering on the list. ADM-07-04's activity figures only
 * apply to judges, so they show as "—" for other roles.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  AlertDialog,
  Badge,
  ConfirmDialog,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  Sheet,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { Capability, useAuth } from '../../lib/auth';

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'JUDGE', 'COORDINATOR'] as const;
type Role = (typeof ROLES)[number];

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  fullName: string;
  role: Role;
  mobile: string | null;
  isActive: boolean;
  isLocked: boolean;
  devicePinEnabled: boolean;
  devicePinned: boolean;
  affiliatedChurchId: string | null;
  affiliatedChurchName: string | null;
  scoresSubmitted: number;
  outstandingMarks: number;
  meanDeviation: number | null;
}

interface ChurchOption {
  id: string;
  name: string;
}

interface CreateForm {
  fullName: string;
  username: string;
  email: string;
  role: Role;
  mobile: string;
  notes: string;
  affiliatedChurchId: string;
  devicePinEnabled: boolean;
}

const BLANK_FORM: CreateForm = {
  fullName: '',
  username: '',
  email: '',
  role: 'JUDGE',
  mobile: '',
  notes: '',
  affiliatedChurchId: '',
  devicePinEnabled: false,
};

export function Users() {
  const { can, user: me } = useAuth();
  const isSuperAdmin = me?.role === 'SUPER_ADMIN';

  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [churches, setChurches] = useState<ChurchOption[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [alertError, setAlertError] = useState<unknown>(null);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('true');

  const [creating, setCreating] = useState<CreateForm | null>(null);
  const [created, setCreated] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [deactivating, setDeactivating] = useState<UserRow | null>(null);
  const [warning, setWarning] = useState<{ message: string; sessions: { id: string; name: string; pending: number }[] } | null>(null);

  function load() {
    api
      .get<UserRow[]>('/api/admin/users', {
        search: search || undefined,
        role: roleFilter || undefined,
        isActive: activeFilter || undefined,
        pageSize: 200,
      })
      .then(setRows)
      .catch(setError);
  }

  useEffect(load, [search, roleFilter, activeFilter]);

  useEffect(() => {
    api
      .get<ChurchOption[]>('/api/admin/churches', { pageSize: 200 })
      .then((list) => setChurches(list.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setChurches([]));
  }, []);

  async function saveNew() {
    if (!creating) return;
    setSaving(true);
    try {
      const result = await api.post<{ username: string; temporaryPassword: string }>('/api/admin/users', {
        fullName: creating.fullName,
        username: creating.username,
        email: creating.email || undefined,
        role: creating.role,
        mobile: creating.mobile || undefined,
        notes: creating.notes || undefined,
        affiliatedChurchId: creating.affiliatedChurchId || undefined,
        devicePinEnabled: creating.devicePinEnabled,
      });
      setCreated(result);
      setCreating(null);
      load();
    } catch (err) {
      setAlertError(err);
    } finally {
      setSaving(false);
    }
  }

  async function forceLogout(id: string) {
    try {
      await api.post(`/api/admin/users/${id}/force-logout`, {});
      load();
    } catch (err) {
      setAlertError(err);
    }
  }

  async function resetPassword(id: string) {
    try {
      const result = await api.post<{ temporaryPassword: string; username: string }>(
        `/api/admin/users/${id}/reset-password`,
        {},
      );
      setCreated(result);
    } catch (err) {
      setAlertError(err);
    }
  }

  async function unlock(id: string) {
    try {
      await api.post(`/api/admin/users/${id}/unlock`, {});
      load();
    } catch (err) {
      setAlertError(err);
    }
  }

  async function releaseDevicePin(id: string) {
    try {
      await api.post(`/api/admin/users/${id}/release-device-pin`, {});
      load();
    } catch (err) {
      setAlertError(err);
    }
  }

  async function confirmDeactivate() {
    if (!deactivating) return;
    setSaving(true);
    try {
      const result = await api.patch<{ warning?: typeof warning }>(`/api/admin/users/${deactivating.id}`, {
        isActive: false,
      });
      setDeactivating(null);
      if (result.warning) setWarning(result.warning);
      else setNotice(`${deactivating.fullName} deactivated.`);
      load();
    } catch (err) {
      setAlertError(err);
    } finally {
      setSaving(false);
    }
  }

  async function reactivate(row: UserRow) {
    try {
      await api.patch(`/api/admin/users/${row.id}`, { isActive: true });
      setNotice(`${row.fullName} reactivated.`);
      load();
    } catch (err) {
      setAlertError(err);
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />;

  const canCreateAdmins = isSuperAdmin;

  return (
    <div className="stack-lg">
      <PageHeader
        icon={<Icon name="user" />}
        title="Users"
        subtitle="Every account in the system — judges, coordinators and administrators"
        actions={
          can(Capability.MANAGE_JUDGE_ACCOUNTS) && (
            <button type="button" className="btn btn-primary" onClick={() => setCreating({ ...BLANK_FORM })}>
              + Add user
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
          placeholder="Search by name or username"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 280 }}
        />
        <select className="input" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} style={{ maxWidth: 180 }}>
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r.replace('_', ' ')}
            </option>
          ))}
        </select>
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
                  <th>Username</th>
                  <th>Role</th>
                  <th>Submitted</th>
                  <th>Outstanding</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id} style={!u.isActive ? { opacity: 0.5 } : undefined}>
                    <td>
                      {u.fullName}
                      {u.isLocked && (
                        <Badge tone="danger">Locked</Badge>
                      )}
                      {u.devicePinned && (
                        <Badge tone="neutral">Pinned</Badge>
                      )}
                      {u.affiliatedChurchName && (
                        <div className="text-xs muted">Affiliated: {u.affiliatedChurchName}</div>
                      )}
                    </td>
                    <td>{u.username}</td>
                    <td>{u.role.replace('_', ' ')}</td>
                    <td className="num">{u.role === 'JUDGE' ? u.scoresSubmitted : '—'}</td>
                    <td
                      className="num"
                      style={u.role === 'JUDGE' && u.outstandingMarks > 0 ? { color: 'var(--warning-text)', fontWeight: 700 } : undefined}
                    >
                      {u.role === 'JUDGE' ? u.outstandingMarks : '—'}
                    </td>
                    <td className="row row-wrap">
                      {can(Capability.MANAGE_JUDGE_ACCOUNTS) &&
                        ((u.role !== 'SUPER_ADMIN' && u.role !== 'ADMIN') || canCreateAdmins) && (
                        <>
                          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void resetPassword(u.id)}>
                            Reset password
                          </button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void forceLogout(u.id)}>
                            Force logout
                          </button>
                          {u.isLocked && (
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void unlock(u.id)}>
                              Unlock
                            </button>
                          )}
                          {u.devicePinned && (
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void releaseDevicePin(u.id)}>
                              Release device pin
                            </button>
                          )}
                          {u.isActive ? (
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDeactivating(u)}>
                              Deactivate
                            </button>
                          ) : (
                            <button type="button" className="btn btn-sm btn-secondary" onClick={() => void reactivate(u)}>
                              Reactivate
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-sm muted" style={{ textAlign: 'center', padding: 'var(--space-4)' }}>
                      No users match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Sheet open={creating !== null} onClose={() => setCreating(null)} title="Add user">
        {creating && (
          <div className="stack">
            <Field label="Full name" required>
              <input className="input" value={creating.fullName} onChange={(e) => setCreating({ ...creating, fullName: e.target.value })} />
            </Field>
            <Field label="Username" required>
              <input className="input" value={creating.username} onChange={(e) => setCreating({ ...creating, username: e.target.value })} />
            </Field>
            <Field label="Role" required>
              <select
                className="input"
                value={creating.role}
                onChange={(e) => setCreating({ ...creating, role: e.target.value as Role })}
              >
                {ROLES.filter((r) => canCreateAdmins || (r !== 'SUPER_ADMIN' && r !== 'ADMIN')).map((r) => (
                  <option key={r} value={r}>
                    {r.replace('_', ' ')}
                  </option>
                ))}
              </select>
              {!canCreateAdmins && (
                <p className="hint">Only a Super Admin can create Admin or Super Admin accounts (FSD 3.2).</p>
              )}
            </Field>
            <Field label="Mobile number">
              <input className="input" value={creating.mobile} onChange={(e) => setCreating({ ...creating, mobile: e.target.value })} />
            </Field>
            <Field label="Email">
              <input className="input" type="email" value={creating.email} onChange={(e) => setCreating({ ...creating, email: e.target.value })} />
            </Field>
            {(creating.role === 'JUDGE' || creating.role === 'COORDINATOR') && (
              <Field label="Affiliated church" hint="ADM-07-03: flags a conflict of interest if this judge is assigned to a panel scoring their own church">
                <select
                  className="input"
                  value={creating.affiliatedChurchId}
                  onChange={(e) => setCreating({ ...creating, affiliatedChurchId: e.target.value })}
                >
                  <option value="">None</option>
                  {churches.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Specialisation / notes">
              <textarea className="textarea" value={creating.notes} onChange={(e) => setCreating({ ...creating, notes: e.target.value })} />
            </Field>
            <Field label="Pin to a single device" hint="ADM-01-08: blocks sign-in from a second device until released here">
              <label className="row" style={{ gap: 'var(--space-2)' }}>
                <input
                  type="checkbox"
                  checked={creating.devicePinEnabled}
                  onChange={(e) => setCreating({ ...creating, devicePinEnabled: e.target.checked })}
                />
                Enabled
              </label>
            </Field>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving || !creating.fullName || !creating.username}
                onClick={() => void saveNew()}
              >
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

      <ConfirmDialog
        open={deactivating !== null}
        title="Deactivate user"
        consequence={
          <>
            <strong>{deactivating?.fullName}</strong> will no longer be able to sign in. Historical scores and
            audit entries stay attributed to them (ADM-01-12) — this can be undone with Reactivate.
          </>
        }
        confirmLabel="Deactivate"
        busy={saving}
        onConfirm={() => void confirmDeactivate()}
        onCancel={() => setDeactivating(null)}
      />

      <Sheet open={warning !== null} onClose={() => setWarning(null)} title="Open work still assigned">
        {warning && (
          <div className="stack">
            <div className="banner banner-warning">{warning.message}</div>
            <ul>
              {warning.sessions.map((s) => (
                <li key={s.id}>
                  {s.name} — {s.pending} performance(s) awaiting a mark
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-primary" onClick={() => setWarning(null)}>
              Understood
            </button>
          </div>
        )}
      </Sheet>

      <AlertDialog error={alertError} onClose={() => setAlertError(null)} />
    </div>
  );
}
