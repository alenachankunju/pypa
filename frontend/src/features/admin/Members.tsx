/**
 * Screens A5/A6 — Member list and form (FSD 5.5).
 *
 * ADM-05-03/04: item multi-select, offering only eligible items by default,
 * with an override path (reason required) once "show ineligible" is on.
 * ADM-05-02: category override, reason required when it differs from the
 * derived category (FSD 4.2.3).
 * ADM-05-05: possible-duplicate confirmation.
 * ADM-05-01: deactivate / reactivate.
 * ADM-05-06: search by chest number, name or church; filter by category and
 * active status; sort by chest number or name.
 */
import { useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { storageUrl } from '../../lib/realtime';
import { Avatar, ConfirmDialog, ErrorState, Field, LoadingState, PageHeader, Sheet } from '../../components/ui';
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
interface CategoryOption {
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
interface IneligibleRegistration {
  registrationId: string;
  itemName: string;
  reason: string;
}

export function Members() {
  const { can } = useAuth();
  const [rows, setRows] = useState<MemberRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState('true');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [churches, setChurches] = useState<Church[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [eligibleItems, setEligibleItems] = useState<EligibleItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [showIneligible, setShowIneligible] = useState(false);
  const [eligibilityOverrideReason, setEligibilityOverrideReason] = useState('');
  const [overrideCategory, setOverrideCategory] = useState(false);
  const [categoryOverrideReason, setCategoryOverrideReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [deactivating, setDeactivating] = useState<MemberRow | null>(null);

  const [duplicateConfirm, setDuplicateConfirm] = useState<{ message: string } | null>(null);
  const [categoryChangeConfirm, setCategoryChangeConfirm] = useState<{
    message: string;
    ineligible: IneligibleRegistration[];
  } | null>(null);

  function load() {
    api
      .get<MemberRow[]>('/api/admin/members', {
        search: search || undefined,
        isActive: activeFilter || undefined,
        pageSize: 200,
        sort: 'chest',
      })
      .then(setRows)
      .catch(setError);
  }

  useEffect(load, [search, activeFilter]);

  useEffect(() => {
    api.get<{ id: string; name: string }[]>('/api/admin/churches', { pageSize: 200 }).then(setChurches).catch(() => undefined);
    api.get<CategoryOption[]>('/api/admin/categories', { pageSize: 200 }).then(setCategories).catch(() => undefined);
  }, []);

  function startCreate() {
    setEditing({ isActive: true });
    setSelectedItems(new Set());
    setEligibleItems([]);
    setOverrideCategory(false);
    setCategoryOverrideReason('');
    setEligibilityOverrideReason('');
  }

  async function startEdit(member: MemberRow) {
    const full = await api.get<Record<string, unknown>>(`/api/admin/members/${member.id}`);
    setEditing(full);
    const registrations = (full.registrations as { item_id: string; status: string }[] | undefined) ?? [];
    setSelectedItems(new Set(registrations.filter((r) => r.status === 'REGISTERED').map((r) => r.item_id)));
    setOverrideCategory(Boolean(full.isCategoryOverridden));
    setCategoryOverrideReason((full.category_override_reason as string) ?? '');
    setEligibilityOverrideReason('');
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

  async function save(extra?: { confirmPossibleDuplicate?: boolean; confirmCategoryChange?: boolean }) {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    try {
      const selectedIneligible = Array.from(selectedItems).some(
        (id) => eligibleItems.find((i) => i.id === id)?.eligible === false,
      );

      const payload: Record<string, unknown> = {
        chestNumber: editing.chestNumber ?? editing.chest_number,
        fullName: editing.fullName ?? editing.full_name,
        dateOfBirth: editing.dateOfBirth ?? editing.date_of_birth,
        gender: editing.gender,
        churchId: editing.churchId ?? editing.church_id,
        photoPath: editing.photoPath ?? editing.photo_path,
        mobile: editing.mobile,
        itemIds: editing.id ? undefined : Array.from(selectedItems),
        eligibilityOverrideReason: selectedIneligible ? eligibilityOverrideReason : undefined,
        ...(overrideCategory
          ? { categoryId: editing.categoryId ?? editing.category_id, categoryOverrideReason: categoryOverrideReason || undefined }
          : {}),
        ...extra,
      };

      if (editing.id) {
        await api.patch(`/api/admin/members/${editing.id}`, payload);
      } else {
        await api.post('/api/admin/members', payload);
      }
      setEditing(null);
      setDuplicateConfirm(null);
      setCategoryChangeConfirm(null);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        const details = err.details as { requiresConfirmation?: string; ineligible?: IneligibleRegistration[] } | undefined;
        if (details?.requiresConfirmation === 'confirmPossibleDuplicate') {
          setDuplicateConfirm({ message: err.message });
          return;
        }
        if (details?.requiresConfirmation === 'confirmCategoryChange') {
          setCategoryChangeConfirm({ message: err.message, ineligible: details.ineligible ?? [] });
          return;
        }
      }
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDeactivate() {
    if (!deactivating) return;
    setSaving(true);
    try {
      await api.del(`/api/admin/members/${deactivating.id}`);
      setDeactivating(null);
      setNotice(`${deactivating.fullName} deactivated. Chest number ${deactivating.chestNumber} stays reserved (FSD 4.2.2).`);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function reactivate(member: MemberRow) {
    await api.patch(`/api/admin/members/${member.id}`, { isActive: true });
    setNotice(`${member.fullName} reactivated.`);
    load();
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
          placeholder="Search by chest number, name or church"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 360 }}
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
                    <td className="row row-wrap">
                      {can('MANAGE_MEMBERS') && (
                        <>
                          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void startEdit(m)}>
                            Edit
                          </button>
                          {m.isActive ? (
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeactivating(m)}>
                              Deactivate
                            </button>
                          ) : (
                            <button type="button" className="btn btn-sm btn-secondary" onClick={() => void reactivate(m)}>
                              Reactivate
                            </button>
                          )}
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

            <div className="field">
              <label className="row" style={{ gap: 'var(--space-2)' }}>
                <input type="checkbox" checked={overrideCategory} onChange={(e) => setOverrideCategory(e.target.checked)} />
                Override category (ADM-05-02)
              </label>
              {overrideCategory && (
                <div className="stack-sm" style={{ marginTop: 'var(--space-2)' }}>
                  <select
                    className="select"
                    value={(editing.categoryId ?? editing.category_id ?? '') as string}
                    onChange={(e) => setEditing({ ...editing, categoryId: e.target.value })}
                  >
                    <option value="">Select a category</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <textarea
                    className="textarea"
                    placeholder="Reason for overriding the derived category (min. 10 characters, FSD 4.2.3)"
                    value={categoryOverrideReason}
                    onChange={(e) => setCategoryOverrideReason(e.target.value)}
                  />
                </div>
              )}
            </div>

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
                      style={{ opacity: item.eligible ? 1 : 0.7 }}
                      title={item.problems.map((p) => p.message).join(' ')}
                    >
                      <input
                        type="checkbox"
                        disabled={!item.eligible && !showIneligible}
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
                      {!item.eligible && <span className="badge badge-warning" style={{ marginLeft: 6 }}>Ineligible</span>}
                    </label>
                  ))}
                </div>
                {showIneligible && Array.from(selectedItems).some((id) => eligibleItems.find((i) => i.id === id)?.eligible === false) && (
                  <Field label="Reason for ineligible selection" required hint="ADM-05-04: required whenever an ineligible item is selected">
                    <textarea
                      className="textarea"
                      value={eligibilityOverrideReason}
                      onChange={(e) => setEligibilityOverrideReason(e.target.value)}
                    />
                  </Field>
                )}
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

      <ConfirmDialog
        open={duplicateConfirm !== null}
        title="Possible duplicate"
        consequence={duplicateConfirm?.message}
        confirmLabel="Add anyway"
        tone="primary"
        busy={saving}
        onConfirm={() => void save({ confirmPossibleDuplicate: true })}
        onCancel={() => setDuplicateConfirm(null)}
      />

      <Sheet open={categoryChangeConfirm !== null} onClose={() => setCategoryChangeConfirm(null)} title="Category change affects registrations">
        {categoryChangeConfirm && (
          <div className="stack">
            <div className="banner banner-warning">{categoryChangeConfirm.message}</div>
            <ul>
              {categoryChangeConfirm.ineligible.map((r) => (
                <li key={r.registrationId}>
                  {r.itemName} — {r.reason}
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

      <ConfirmDialog
        open={deactivating !== null}
        title="Deactivate member"
        consequence={
          <>
            <strong>{deactivating?.fullName}</strong> will be deactivated. Chest number{' '}
            <strong>{deactivating?.chestNumber}</strong> stays reserved and historical scores remain attributed to
            them (ADM-05-01, FSD 4.2.2).
          </>
        }
        confirmLabel="Deactivate"
        busy={saving}
        onConfirm={() => void confirmDeactivate()}
        onCancel={() => setDeactivating(null)}
      />
    </div>
  );
}
