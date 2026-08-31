/**
 * Screen A4 — Item list / form (FSD 5.4).
 * Grouped by category and stage, with registration counts and scoring status.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorState, Field, LoadingState, PageHeader, Sheet, StatusBadge } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface ItemRow {
  id: string;
  name: string;
  code: string;
  categoryName: string | null;
  type: string;
  stage: string | null;
  weightMultiplier: number;
  registrationCount: number;
  publicationState: string;
  isReady: boolean;
  hasUnresolvedTie: boolean;
  isActive: boolean;
}

interface Category {
  id: string;
  name: string;
}

export function Items() {
  const { can } = useAuth();
  const [rows, setRows] = useState<ItemRow[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    api.get<ItemRow[]>('/api/admin/items').then(setRows).catch(setError);
  }

  useEffect(load, []);
  useEffect(() => {
    api.get<Category[]>('/api/admin/categories').then(setCategories).catch(() => undefined);
  }, []);

  async function save() {
    if (!editing) return;
    setSaving(true);
    try {
      const payload = {
        name: editing.name,
        code: editing.code,
        categoryId: editing.categoryId || null,
        openToAllCategories: !editing.categoryId,
        type: editing.type ?? 'INDIVIDUAL',
        stage: editing.stage,
        maxMark: editing.maxMark ? Number(editing.maxMark) : undefined,
        maxPerChurch: editing.maxPerChurch ? Number(editing.maxPerChurch) : undefined,
        minTeamSize: editing.minTeamSize ? Number(editing.minTeamSize) : undefined,
        maxTeamSize: editing.maxTeamSize ? Number(editing.maxTeamSize) : undefined,
        weightMultiplier: editing.weightMultiplier ? Number(editing.weightMultiplier) : undefined,
      };
      if (editing.id) await api.patch(`/api/admin/items/${editing.id}`, payload);
      else await api.post('/api/admin/items', payload);
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
        title="Items"
        actions={
          can('MANAGE_ITEMS') && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing({ type: 'INDIVIDUAL' })}>
              + Add item
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
                  <th>Code</th>
                  <th>Category</th>
                  <th>Type</th>
                  <th>Stage</th>
                  <th>Entries</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.code}</td>
                    <td>{item.categoryName ?? 'Open'}</td>
                    <td>{item.type}</td>
                    <td>{item.stage ?? '—'}</td>
                    <td className="num">{item.registrationCount}</td>
                    <td>
                      <StatusBadge status={item.publicationState} />
                      {item.hasUnresolvedTie && <span className="badge badge-danger" style={{ marginLeft: 4 }}>Tie</span>}
                    </td>
                    <td className="row">
                      {can('MANAGE_ITEMS') && (
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={() => setEditing(item as unknown as Record<string, unknown>)}
                        >
                          Edit
                        </button>
                      )}
                      <Link to={`/admin/results/${item.id}`} className="btn btn-sm btn-ghost">
                        Results
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? 'Edit item' : 'Add item'}>
        {editing && (
          <div className="stack">
            <Field label="Name" required>
              <input className="input" value={(editing.name as string) ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Code" required>
              <input className="input" value={(editing.code as string) ?? ''} onChange={(e) => setEditing({ ...editing, code: e.target.value })} />
            </Field>
            <Field label="Category" hint="Leave blank for 'open to all categories'">
              <select
                className="select"
                value={(editing.categoryId as string) ?? ''}
                onChange={(e) => setEditing({ ...editing, categoryId: e.target.value })}
              >
                <option value="">Open to all</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Type">
              <select className="select" value={(editing.type as string) ?? 'INDIVIDUAL'} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
                <option value="INDIVIDUAL">Individual</option>
                <option value="GROUP">Group</option>
              </select>
            </Field>
            <Field label="Stage">
              <input className="input" value={(editing.stage as string) ?? ''} onChange={(e) => setEditing({ ...editing, stage: e.target.value })} />
            </Field>
            <div className="row">
              <Field label="Max mark override">
                <input type="number" className="input" value={(editing.maxMark as number) ?? ''} onChange={(e) => setEditing({ ...editing, maxMark: e.target.value })} />
              </Field>
              <Field label="Max per church">
                <input type="number" className="input" value={(editing.maxPerChurch as number) ?? ''} onChange={(e) => setEditing({ ...editing, maxPerChurch: e.target.value })} />
              </Field>
            </div>
            {editing.type === 'GROUP' && (
              <div className="row">
                <Field label="Min team size">
                  <input type="number" className="input" value={(editing.minTeamSize as number) ?? ''} onChange={(e) => setEditing({ ...editing, minTeamSize: e.target.value })} />
                </Field>
                <Field label="Max team size">
                  <input type="number" className="input" value={(editing.maxTeamSize as number) ?? ''} onChange={(e) => setEditing({ ...editing, maxTeamSize: e.target.value })} />
                </Field>
                <Field label="Weight multiplier">
                  <input type="number" step="0.1" className="input" value={(editing.weightMultiplier as number) ?? 2.0} onChange={(e) => setEditing({ ...editing, weightMultiplier: e.target.value })} />
                </Field>
              </div>
            )}
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
