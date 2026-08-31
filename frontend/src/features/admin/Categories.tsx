/**
 * Screen A3 — Category list / form (FSD 5.3).
 * ADM-03-04: the system warns of overlapping or gapped age bands.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { ErrorState, Field, LoadingState, PageHeader, Sheet } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface Category {
  id: string;
  name: string;
  minAge: number;
  maxAge: number;
  genderRestriction: string;
  displayOrder: number;
  isActive: boolean;
  memberCount: number;
  itemCount: number;
}

export function Categories() {
  const { can } = useAuth();
  const [rows, setRows] = useState<Category[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Partial<Category> | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    api
      .getWithMeta<Category[]>('/api/admin/categories')
      .then((r) => {
        setRows(r.data);
        setWarnings((r.meta?.bandWarnings as string[] | undefined) ?? []);
      })
      .catch(setError);
  }

  useEffect(load, []);

  async function save() {
    if (!editing) return;
    setSaving(true);
    try {
      const payload = {
        name: editing.name,
        minAge: editing.minAge,
        maxAge: editing.maxAge,
        genderRestriction: editing.genderRestriction ?? 'ANY',
        displayOrder: editing.displayOrder ?? 0,
      };
      if (editing.id) await api.patch(`/api/admin/categories/${editing.id}`, payload);
      else await api.post('/api/admin/categories', payload);
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
        title="Categories"
        subtitle="Age and eligibility bands for this event"
        actions={
          can('MANAGE_CATEGORIES') && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setEditing({ minAge: 0, maxAge: 0, genderRestriction: 'ANY', isActive: true })}
            >
              + Add category
            </button>
          )
        }
      />

      {warnings.map((w, i) => (
        <div className="banner banner-warning" key={i}>
          <span className="banner-icon" aria-hidden="true">⚠</span>
          <div>{w}</div>
        </div>
      ))}

      {!rows ? (
        <LoadingState />
      ) : (
        <div className="card-flush">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Age range</th>
                  <th>Gender</th>
                  <th>Members</th>
                  <th>Items</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="num">{c.minAge}–{c.maxAge}</td>
                    <td>{c.genderRestriction}</td>
                    <td className="num">{c.memberCount}</td>
                    <td className="num">{c.itemCount}</td>
                    <td>
                      {can('MANAGE_CATEGORIES') && (
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

      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? 'Edit category' : 'Add category'}>
        {editing && (
          <div className="stack">
            <Field label="Name" required>
              <input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <div className="row">
              <Field label="Min age" required>
                <input
                  type="number"
                  className="input"
                  value={editing.minAge ?? 0}
                  onChange={(e) => setEditing({ ...editing, minAge: Number(e.target.value) })}
                />
              </Field>
              <Field label="Max age" required>
                <input
                  type="number"
                  className="input"
                  value={editing.maxAge ?? 0}
                  onChange={(e) => setEditing({ ...editing, maxAge: Number(e.target.value) })}
                />
              </Field>
            </div>
            <Field label="Gender restriction">
              <select
                className="select"
                value={editing.genderRestriction ?? 'ANY'}
                onChange={(e) => setEditing({ ...editing, genderRestriction: e.target.value })}
              >
                <option value="ANY">Any</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
              </select>
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
