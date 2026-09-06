/**
 * Screens A5/A6 — Member list and form (FSD 5.5).
 *
 * ADM-05-03/04: items are added one at a time via the eligible-items list,
 * offering only eligible items by default, with an override path (reason
 * required) once "show ineligible" is on. This only works once the member
 * has an id — for a brand-new member, save the base details first (the form
 * stays open, now in edit mode), then add items below.
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
  const [showIneligible, setShowIneligible] = useState(false);
  const [overrideCategory, setOverrideCategory] = useState(false);
  const [categoryOverrideReason, setCategoryOverrideReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [deactivating, setDeactivating] = useState<MemberRow | null>(null);

  const [addBusy, setAddBusy] = useState(false);
  const [ineligibleConfirm, setIneligibleConfirm] = useState<{ itemId: string; itemName: string; message: string; reason: string } | null>(null);

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
    setEligibleItems([]);
    setOverrideCategory(false);
    setCategoryOverrideReason('');
  }

  async function loadMember(id: string) {
    const full = await api.get<Record<string, unknown>>(`/api/admin/members/${id}`);
    setEditing(full);
    setOverrideCategory(Boolean(full.isCategoryOverridden));
    setCategoryOverrideReason((full.category_override_reason as string) ?? '');
  }

  function loadEligibleItems(memberId: string) {
    api
      .get<EligibleItem[]>(`/api/admin/members/${memberId}/eligible-items`, {
        includeIneligible: String(showIneligible),
      })
      .then(setEligibleItems)
      .catch(() => undefined);
  }

  useEffect(() => {
    const id = editing?.id as string | undefined;
    if (!id) return;
    loadEligibleItems(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, showIneligible]);

  async function save(extra?: { confirmPossibleDuplicate?: boolean; confirmCategoryChange?: boolean }) {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload: Record<string, unknown> = {
        chestNumber: editing.chestNumber ?? editing.chest_number,
        fullName: editing.fullName ?? editing.full_name,
        dateOfBirth: editing.dateOfBirth ?? editing.date_of_birth,
        gender: editing.gender,
        churchId: editing.churchId ?? editing.church_id,
        photoPath: editing.photoPath ?? editing.photo_path,
        mobile: editing.mobile,
        ...(overrideCategory
          ? { categoryId: editing.categoryId ?? editing.category_id, categoryOverrideReason: categoryOverrideReason || undefined }
          : {}),
        ...extra,
      };

      if (editing.id) {
        await api.patch(`/api/admin/members/${editing.id}`, payload);
        setDuplicateConfirm(null);
        setCategoryChangeConfirm(null);
        await loadMember(editing.id as string);
        setNotice('Saved.');
      } else {
        const created = await api.post<{ id: string }>('/api/admin/members', payload);
        setDuplicateConfirm(null);
        setCategoryChangeConfirm(null);
        await loadMember(created.id);
        setNotice(`${payload.fullName as string} created — add items below, then Done.`);
      }
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

  async function addItem(itemId: string, itemName: string, eligibilityOverrideReason?: string) {
    if (!editing?.id) return;
    setAddBusy(true);
    try {
      await api.post('/api/admin/registrations', { itemId, memberId: editing.id, eligibilityOverrideReason });
      setIneligibleConfirm(null);
      await loadMember(editing.id as string);
      loadEligibleItems(editing.id as string);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INELIGIBLE_ITEM') {
        setIneligibleConfirm({ itemId, itemName, message: err.message, reason: '' });
      } else {
        setSaveError(err);
      }
    } finally {
      setAddBusy(false);
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
                          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void loadMember(m.id)}>
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

            {saveError !== null && <ErrorState error={saveError} />}

            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                {editing.id ? 'Done' : 'Cancel'}
              </button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>

            {editing.id != null && (
              <>
                <hr className="rule" />

                {editing.registrations != null && Array.isArray(editing.registrations) && (editing.registrations as unknown[]).length > 0 && (
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

                <div className="field">
                  <div className="row-between">
                    <label className="label">Add an item (ADM-05-03)</label>
                    <label className="text-xs row">
                      <input type="checkbox" checked={showIneligible} onChange={(e) => setShowIneligible(e.target.checked)} />
                      Show ineligible
                    </label>
                  </div>
                  <p className="text-xs muted" style={{ marginTop: 'calc(var(--space-1) * -1)' }}>
                    Individual items only — group items are entered as a team from the Registrations screen (ADM-06-04).
                  </p>
                  <div className="stack-sm" style={{ maxHeight: 240, overflowY: 'auto' }}>
                    {eligibleItems.filter((i) => !i.alreadyRegistered).length === 0 && (
                      <p className="text-sm muted">
                        {showIneligible
                          ? 'No individual items left to add.'
                          : `No individual items are currently open to this member${editing.categoryName ? `'s category (${editing.categoryName as string})` : ''} — try "Show ineligible" to see why.`}
                      </p>
                    )}
                    {eligibleItems
                      .filter((item) => !item.alreadyRegistered)
                      .map((item) => (
                        <div
                          key={item.id}
                          className="row-between"
                          style={{ opacity: item.eligible ? 1 : 0.7, padding: 'var(--space-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}
                          title={item.problems.map((p) => p.message).join(' ')}
                        >
                          <span>
                            {item.name} ({item.code})
                            {!item.eligible && <span className="badge badge-warning" style={{ marginLeft: 6 }}>Ineligible</span>}
                          </span>
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            disabled={addBusy}
                            onClick={() => void addItem(item.id, item.name)}
                          >
                            Add
                          </button>
                        </div>
                      ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </Sheet>

      <Sheet open={ineligibleConfirm !== null} onClose={() => setIneligibleConfirm(null)} title="Not eligible for this item">
        {ineligibleConfirm && (
          <div className="stack">
            <div className="banner banner-warning">{ineligibleConfirm.message}</div>
            <Field label="Reason to add anyway" required hint="At least 10 characters (FSD ADM-05-04)">
              <textarea
                className="textarea"
                value={ineligibleConfirm.reason}
                onChange={(e) => setIneligibleConfirm({ ...ineligibleConfirm, reason: e.target.value })}
              />
            </Field>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setIneligibleConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={addBusy || ineligibleConfirm.reason.trim().length < 10}
                onClick={() => void addItem(ineligibleConfirm.itemId, ineligibleConfirm.itemName, ineligibleConfirm.reason)}
              >
                {addBusy ? 'Adding…' : 'Add anyway'}
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
