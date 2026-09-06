/**
 * Screen A4 — Item list / form (FSD 5.4).
 * Grouped by category and stage, with registration counts and scoring status.
 * ADM-04-04: category-change confirmation. ADM-04-05: cancel. ADM-04-06:
 * per-criterion scoring editor.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { ConfirmDialog, ErrorState, Field, LoadingState, PageHeader, Sheet, StatusBadge } from '../../components/ui';
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
  performanceCount: number;
  criteriaCount: number;
  publicationState: string;
  isReady: boolean;
  hasUnresolvedTie: boolean;
  isActive: boolean;
  status: string;
}

interface Category {
  id: string;
  name: string;
}

interface Criterion {
  id?: string;
  name: string;
  maxMark: number;
}

interface AffectedRegistration {
  registrationId: string;
  chestNumber: string;
  memberName: string;
  currentCategory: string | null;
}

export function Items() {
  const { can } = useAuth();
  const [rows, setRows] = useState<ItemRow[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [categoryChangeConfirm, setCategoryChangeConfirm] = useState<{ message: string; affected: AffectedRegistration[] } | null>(null);

  const [cancelling, setCancelling] = useState<ItemRow | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [deleting, setDeleting] = useState<ItemRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [criteriaFor, setCriteriaFor] = useState<{ id: string; name: string; maxMark: number } | null>(null);
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [criteriaSaving, setCriteriaSaving] = useState(false);
  const [criteriaError, setCriteriaError] = useState<unknown>(null);

  function load() {
    api.get<ItemRow[]>('/api/admin/items').then(setRows).catch(setError);
  }

  useEffect(load, []);
  useEffect(() => {
    api.get<Category[]>('/api/admin/categories').then(setCategories).catch(() => undefined);
  }, []);

  async function save(extra?: { confirmCategoryChange?: boolean }) {
    if (!editing) return;
    setSaving(true);
    try {
      const payload = {
        name: editing.name,
        code: editing.code,
        categoryId: editing.categoryId || null,
        openToAllCategories: !editing.categoryId,
        type: editing.type ?? 'INDIVIDUAL',
        genderRestriction: editing.genderRestriction ?? 'ANY',
        stage: editing.stage,
        scheduledAt: editing.scheduledAt || null,
        displayOrder: editing.displayOrder !== undefined && editing.displayOrder !== '' ? Number(editing.displayOrder) : undefined,
        isActive: editing.isActive ?? true,
        maxMark: editing.maxMark ? Number(editing.maxMark) : undefined,
        maxPerChurch: editing.maxPerChurch ? Number(editing.maxPerChurch) : undefined,
        minTeamSize: editing.minTeamSize ? Number(editing.minTeamSize) : undefined,
        maxTeamSize: editing.maxTeamSize ? Number(editing.maxTeamSize) : undefined,
        weightMultiplier: editing.weightMultiplier ? Number(editing.weightMultiplier) : undefined,
        ...extra,
      };
      if (editing.id) await api.patch(`/api/admin/items/${editing.id}`, payload);
      else await api.post('/api/admin/items', payload);
      setEditing(null);
      setCategoryChangeConfirm(null);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        const details = err.details as { requiresConfirmation?: string; affected?: AffectedRegistration[] } | undefined;
        if (details?.requiresConfirmation === 'confirmCategoryChange') {
          setCategoryChangeConfirm({ message: err.message, affected: details.affected ?? [] });
          return;
        }
      }
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function confirmCancel() {
    if (!cancelling) return;
    setCancelBusy(true);
    try {
      await api.post(`/api/admin/items/${cancelling.id}/cancel`, { reason: cancelReason });
      setCancelling(null);
      setCancelReason('');
      load();
    } catch (err) {
      setError(err);
    } finally {
      setCancelBusy(false);
    }
  }

  async function confirmDeleteItem() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.del(`/api/admin/items/${deleting.id}`);
      setNotice(`${deleting.name} deleted.`);
      setDeleting(null);
      load();
    } catch (err) {
      setDeleting(null);
      if (err instanceof ApiError && err.code === 'IN_USE') {
        setNotice(err.message);
      } else {
        setError(err);
      }
    } finally {
      setDeleteBusy(false);
    }
  }

  async function openCriteria(item: ItemRow) {
    const full = await api.get<{ max_mark: number | null; criteria: { id: string; name: string; maxMark: number }[] }>(
      `/api/admin/items/${item.id}`,
    );
    setCriteriaFor({ id: item.id, name: item.name, maxMark: full.max_mark ?? 10 });
    setCriteria(full.criteria.length > 0 ? full.criteria : []);
    setCriteriaError(null);
  }

  async function saveCriteria() {
    if (!criteriaFor) return;
    setCriteriaSaving(true);
    setCriteriaError(null);
    try {
      await api.put(`/api/admin/items/${criteriaFor.id}/criteria`, {
        criteria: criteria.map((c, i) => ({ name: c.name, maxMark: Number(c.maxMark), displayOrder: i })),
      });
      setCriteriaFor(null);
      load();
    } catch (err) {
      setCriteriaError(err);
    } finally {
      setCriteriaSaving(false);
    }
  }

  const criteriaTotal = criteria.reduce((sum, c) => sum + (Number(c.maxMark) || 0), 0);

  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Items"
        actions={
          can('MANAGE_ITEMS') && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing({ type: 'INDIVIDUAL', genderRestriction: 'ANY', isActive: true })}>
              + Add item
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
                  <tr key={item.id} style={item.status === 'CANCELLED' || !item.isActive ? { opacity: 0.5 } : undefined}>
                    <td>{item.name}</td>
                    <td>{item.code}</td>
                    <td>{item.categoryName ?? 'Open'}</td>
                    <td>{item.type}</td>
                    <td>{item.stage ?? '—'}</td>
                    <td className="num">{item.registrationCount}</td>
                    <td>
                      {item.status === 'CANCELLED' ? (
                        <span className="badge badge-danger">Cancelled</span>
                      ) : (
                        <StatusBadge status={item.publicationState} />
                      )}
                      {item.hasUnresolvedTie && <span className="badge badge-danger" style={{ marginLeft: 4 }}>Tie</span>}
                      {item.criteriaCount > 0 && <span className="badge badge-info" style={{ marginLeft: 4 }}>{item.criteriaCount} criteria</span>}
                    </td>
                    <td className="row row-wrap">
                      {can('MANAGE_ITEMS') && (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() => setEditing(item as unknown as Record<string, unknown>)}
                          >
                            Edit
                          </button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void openCriteria(item)}>
                            Criteria
                          </button>
                          {item.status !== 'CANCELLED' && (
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => setCancelling(item)}>
                              Cancel
                            </button>
                          )}
                          {item.performanceCount === 0 && (
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeleting(item)}>
                              Delete
                            </button>
                          )}
                        </>
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
            <div className="row">
              <Field label="Type">
                <select className="select" value={(editing.type as string) ?? 'INDIVIDUAL'} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
                  <option value="INDIVIDUAL">Individual</option>
                  <option value="GROUP">Group</option>
                </select>
              </Field>
              <Field label="Gender restriction">
                <select
                  className="select"
                  value={(editing.genderRestriction as string) ?? 'ANY'}
                  onChange={(e) => setEditing({ ...editing, genderRestriction: e.target.value })}
                >
                  <option value="ANY">Any</option>
                  <option value="MALE">Male</option>
                  <option value="FEMALE">Female</option>
                </select>
              </Field>
            </div>
            <div className="row">
              <Field label="Stage" hint="Pick an existing stage, or type a new one">
                <input
                  className="input"
                  list="existing-stages"
                  value={(editing.stage as string) ?? ''}
                  onChange={(e) => setEditing({ ...editing, stage: e.target.value })}
                />
                <datalist id="existing-stages">
                  {[...new Set((rows ?? []).map((r) => r.stage).filter((s): s is string => Boolean(s)))].map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </Field>
              <Field label="Scheduled at">
                <input
                  type="datetime-local"
                  className="input"
                  value={((editing.scheduledAt as string) ?? '').slice(0, 16)}
                  onChange={(e) => setEditing({ ...editing, scheduledAt: e.target.value })}
                />
              </Field>
            </div>
            <div className="row">
              <Field label="Max mark override">
                <input type="number" className="input" value={(editing.maxMark as number) ?? ''} onChange={(e) => setEditing({ ...editing, maxMark: e.target.value })} />
              </Field>
              <Field label="Max per church">
                <input type="number" className="input" value={(editing.maxPerChurch as number) ?? ''} onChange={(e) => setEditing({ ...editing, maxPerChurch: e.target.value })} />
              </Field>
              <Field label="Display order">
                <input type="number" className="input" value={(editing.displayOrder as number) ?? ''} onChange={(e) => setEditing({ ...editing, displayOrder: e.target.value })} />
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
            <Field label="Active">
              <label className="row" style={{ gap: 'var(--space-2)' }}>
                <input
                  type="checkbox"
                  checked={(editing.isActive as boolean) ?? true}
                  onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })}
                />
                Visible in eligible-item lists and dropdowns
              </label>
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

      <Sheet
        open={categoryChangeConfirm !== null}
        onClose={() => setCategoryChangeConfirm(null)}
        title="Category change affects registrations"
      >
        {categoryChangeConfirm && (
          <div className="stack">
            <div className="banner banner-warning">{categoryChangeConfirm.message}</div>
            <ul>
              {categoryChangeConfirm.affected.map((a) => (
                <li key={a.registrationId}>
                  {a.chestNumber} — {a.memberName} (currently {a.currentCategory ?? 'uncategorised'})
                </li>
              ))}
            </ul>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setCategoryChangeConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save({ confirmCategoryChange: true })}>
                {saving ? 'Saving…' : 'Confirm change'}
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={cancelling !== null} onClose={() => setCancelling(null)} title="Cancel item">
        {cancelling && (
          <div className="stack">
            <div className="banner banner-warning">
              "{cancelling.name}" will be excluded from results. This cannot be undone from here (FSD ADM-04-05).
            </div>
            <Field label="Reason" required hint="At least 10 characters">
              <textarea className="textarea" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            </Field>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setCancelling(null)}>
                Back
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={cancelBusy || cancelReason.trim().length < 10}
                onClick={() => void confirmCancel()}
              >
                {cancelBusy ? 'Cancelling…' : 'Cancel item'}
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={criteriaFor !== null} onClose={() => setCriteriaFor(null)} title={criteriaFor ? `Criteria — ${criteriaFor.name}` : 'Criteria'}>
        {criteriaFor && (
          <div className="stack">
            <p className="text-sm muted">
              Criteria maximums must sum to the item maximum ({criteriaFor.maxMark}). Leave empty for a single overall
              mark (FSD ADM-04-06).
            </p>
            <div className="stack-sm">
              {criteria.map((c, i) => (
                <div key={i} className="row">
                  <input
                    className="input"
                    style={{ flex: 2 }}
                    placeholder="Criterion name"
                    value={c.name}
                    onChange={(e) => setCriteria(criteria.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  />
                  <input
                    className="input"
                    type="number"
                    style={{ flex: 1 }}
                    placeholder="Max"
                    value={c.maxMark}
                    onChange={(e) => setCriteria(criteria.map((x, j) => (j === i ? { ...x, maxMark: Number(e.target.value) } : x)))}
                  />
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCriteria(criteria.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCriteria([...criteria, { name: '', maxMark: 0 }])}>
              + Add criterion
            </button>
            <p
              className="text-sm"
              style={criteria.length > 0 && criteriaTotal !== criteriaFor.maxMark ? { color: 'var(--danger-text)' } : undefined}
            >
              Total: {criteriaTotal} / {criteriaFor.maxMark}
            </p>
            {criteriaError !== null && <ErrorState error={criteriaError} />}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setCriteriaFor(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={criteriaSaving || (criteria.length > 0 && criteriaTotal !== criteriaFor.maxMark)}
                onClick={() => void saveCriteria()}
              >
                {criteriaSaving ? 'Saving…' : 'Save criteria'}
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete item"
        consequence={<><strong>{deleting?.name}</strong> will be permanently deleted. This cannot be undone.</>}
        confirmLabel="Delete"
        busy={deleteBusy}
        onConfirm={() => void confirmDeleteItem()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
