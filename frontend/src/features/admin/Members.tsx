/**
 * Screens A5/A6 — Member list and form (FSD 5.5).
 *
 * ADM-05-03/04: item multi-select, offering only eligible items by default.
 * ADM-05-06: search by chest number, name or church; filter by category and
 * active status; sort by chest number or name.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { storageUrl } from '../../lib/realtime';
import { Avatar, ErrorState, Field, LoadingState, PageHeader, Sheet } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface MemberRow {
  id: string;
  chestNumber: string;
  fullName: string;
  churchName: string;
  categoryName: string | null;
  photoPath: string | null;
  isActive: boolean;
  itemCount: number;
}

interface Church {
  id: string;
  name: string;
}
interface EligibleItem {
  id: string;
  name: string;
  code: string;
  eligible: boolean;
  alreadyRegistered: boolean;
  problems: { message: string }[];
}

export function Members() {
  const { can } = useAuth();
  const [rows, setRows] = useState<MemberRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [churches, setChurches] = useState<Church[]>([]);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [eligibleItems, setEligibleItems] = useState<EligibleItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [showIneligible, setShowIneligible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  function load() {
    api
      .get<MemberRow[]>('/api/admin/members', { search: search || undefined, pageSize: 200, sort: 'chest' })
      .then(setRows)
      .catch(setError);
  }

  useEffect(load, [search]);

  useEffect(() => {
    api.get<{ id: string; name: string }[]>('/api/admin/churches', { pageSize: 500 }).then(setChurches).catch(() => undefined);
  }, []);

  function startCreate() {
    setEditing({ isActive: true });
    setSelectedItems(new Set());
    setEligibleItems([]);
  }

  async function startEdit(member: MemberRow) {
    const full = await api.get<Record<string, unknown>>(`/api/admin/members/${member.id}`);
    setEditing(full);
    const registrations = (full.registrations as { item_id: string; status: string }[] | undefined) ?? [];
    setSelectedItems(new Set(registrations.filter((r) => r.status === 'REGISTERED').map((r) => r.item_id)));
  }

  // Load the eligible-item list once the church/category-relevant fields are known.
  useEffect(() => {
    if (!editing?.id) return;
    api
      .get<EligibleItem[]>(`/api/admin/members/${editing.id}/eligible-items`, {
        includeIneligible: String(showIneligible),
      })
      .then(setEligibleItems)
      .catch(() => undefined);
  }, [editing?.id, showIneligible]);

  async function save() {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        chestNumber: editing.chestNumber ?? editing.chest_number,
        fullName: editing.fullName ?? editing.full_name,
        dateOfBirth: editing.dateOfBirth ?? editing.date_of_birth,
        gender: editing.gender,
        churchId: editing.churchId ?? editing.church_id,
        photoPath: editing.photoPath ?? editing.photo_path,
        mobile: editing.mobile,
        itemIds: editing.id ? undefined : Array.from(selectedItems),
      };

      if (editing.id) {
        await api.patch(`/api/admin/members/${editing.id}`, payload);
      } else {
        await api.post('/api/admin/members', payload);
      }
      setEditing(null);
      load();
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Members"
        actions={
          can('MANAGE_MEMBERS') && (
            <button type="button" className="btn btn-primary" onClick={startCreate}>
              + Add member
            </button>
          )
        }
      />

      <input
        className="input"
        placeholder="Search by chest number, name or church"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ maxWidth: 360 }}
      />

      {!rows ? (
        <LoadingState />
      ) : (
        <div className="card-flush">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Chest</th>
                  <th>Name</th>
                  <th>Church</th>
                  <th>Category</th>
                  <th>Items</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} style={!m.isActive ? { opacity: 0.5 } : undefined}>
                    <td className="num strong">{m.chestNumber}</td>
                    <td>
                      <div className="row">
                        <Avatar src={storageUrl(m.photoPath)} name={m.fullName} />
                        {m.fullName}
                      </div>
                    </td>
                    <td>{m.churchName}</td>
                    <td>{m.categoryName ?? '—'}</td>
                    <td className="num">{m.itemCount}</td>
                    <td>
                      {can('MANAGE_MEMBERS') && (
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => void startEdit(m)}>
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

      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? 'Edit member' : 'Add member'}>
        {editing && (
          <div className="stack">
            <Field label="Chest number" required>
              <input
                className="input"
                value={(editing.chestNumber ?? editing.chest_number ?? '') as string}
                onChange={(e) => setEditing({ ...editing, chestNumber: e.target.value })}
              />
            </Field>
            <Field label="Full name" required>
              <input
                className="input"
                value={(editing.fullName ?? editing.full_name ?? '') as string}
                onChange={(e) => setEditing({ ...editing, fullName: e.target.value })}
              />
            </Field>
            <Field label="Date of birth" hint="Determines category via the event age cut-off (FSD ADM-03-03)">
              <input
                type="date"
                className="input"
                value={(editing.dateOfBirth ?? (editing.date_of_birth as string)?.slice(0, 10) ?? '') as string}
                onChange={(e) => setEditing({ ...editing, dateOfBirth: e.target.value })}
              />
            </Field>
            <Field label="Gender">
              <select
                className="select"
                value={(editing.gender ?? '') as string}
                onChange={(e) => setEditing({ ...editing, gender: e.target.value || null })}
              >
                <option value="">Not set</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
              </select>
            </Field>
            <Field label="Church" required>
              <select
                className="select"
                value={(editing.churchId ?? editing.church_id ?? '') as string}
                onChange={(e) => setEditing({ ...editing, churchId: e.target.value })}
              >
                <option value="">Select a church</option>
                {churches.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            {editing.categoryName != null && (
              <p className="text-sm muted">
                Derived category: <strong>{editing.categoryName as string}</strong>
                {editing.ageAtCutoff != null ? ` (age ${editing.ageAtCutoff} at cut-off)` : ''}
              </p>
            )}

            {!editing.id && (
              <div className="field">
                <div className="row-between">
                  <label className="label">Items</label>
                  <label className="text-xs row">
                    <input
                      type="checkbox"
                      checked={showIneligible}
                      onChange={(e) => setShowIneligible(e.target.checked)}
                    />
                    Show ineligible
                  </label>
                </div>
                <div className="stack-sm" style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {eligibleItems.length === 0 && <p className="text-sm muted">Save the church first to see eligible items.</p>}
                  {eligibleItems.map((item) => (
                    <label
                      key={item.id}
                      className="row"
                      style={{ opacity: item.eligible ? 1 : 0.5 }}
                      title={item.problems.map((p) => p.message).join(' ')}
                    >
                      <input
                        type="checkbox"
                        disabled={!item.eligible}
                        checked={selectedItems.has(item.id)}
                        onChange={(e) =>
                          setSelectedItems((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          })
                        }
                      />
                      {item.name} ({item.code})
                    </label>
                  ))}
                </div>
              </div>
            )}

            {editing.registrations != null && Array.isArray(editing.registrations) && (
              <div className="field">
                <span className="label">Registered items</span>
                <div className="stack-sm">
                  {(editing.registrations as { item_name: string; status: string }[]).map((r, i) => (
                    <div key={i} className="text-sm row-between">
                      <span>{r.item_name}</span>
                      <span className="badge badge-neutral">{r.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {saveError !== null && <ErrorState error={saveError} />}

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
