/**
 * Screen A11 — Session list / form (FSD 5.8).
 * ADM-08-04/05: open (materialises performances) and close (validates
 * completeness, force-close with a reason).
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Banner, ConfirmDialog, ErrorState, Field, LoadingState, PageHeader, Sheet, StatusBadge } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface SessionRow {
  id: string;
  name: string;
  stage: string | null;
  status: string;
  panelName: string;
  panelSize: number;
  itemCount: number;
  performanceCount: number;
  completeCount: number;
}
interface Panel {
  id: string;
  name: string;
}
interface ItemOption {
  id: string;
  name: string;
}

export function Sessions() {
  const { can } = useAuth();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [items, setItems] = useState<ItemOption[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState<{ name: string; panelId: string; itemIds: string[] } | null>(null);
  const [closeBlock, setCloseBlock] = useState<{ sessionId: string; incomplete: { itemName: string; participantName: string }[] } | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [deleting, setDeleting] = useState<SessionRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [addingItemsTo, setAddingItemsTo] = useState<SessionRow | null>(null);
  const [selectedAddItemIds, setSelectedAddItemIds] = useState<string[]>([]);
  const [addItemsBusy, setAddItemsBusy] = useState(false);
  const [addItemsError, setAddItemsError] = useState<unknown>(null);

  function load() {
    api.get<SessionRow[]>('/api/admin/sessions').then(setRows).catch(setError);
  }

  useEffect(load, []);
  useEffect(() => {
    api.get<Panel[]>('/api/admin/panels').then(setPanels);
    api.get<ItemOption[]>('/api/admin/items').then(setItems);
  }, []);

  async function createSession() {
    if (!creating) return;
    await api.post('/api/admin/sessions', creating);
    setCreating(null);
    load();
  }

  async function openSession(id: string) {
    try {
      await api.post(`/api/admin/sessions/${id}/open`, {});
      load();
    } catch (err) {
      setError(err);
    }
  }

  async function closeSession(id: string, force = false) {
    try {
      await api.post(`/api/admin/sessions/${id}/close`, force ? { force: true, reason: closeReason } : {});
      setCloseBlock(null);
      setCloseReason('');
      load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        const details = err.details as { incompletePerformances?: { itemName: string; participantName: string }[] } | undefined;
        setCloseBlock({ sessionId: id, incomplete: details?.incompletePerformances ?? [] });
      } else {
        setError(err);
      }
    }
  }

  function startAddItems(session: SessionRow) {
    setAddingItemsTo(session);
    setSelectedAddItemIds([]);
    setAddItemsError(null);
  }

  async function submitAddItems() {
    if (!addingItemsTo || selectedAddItemIds.length === 0) return;
    setAddItemsBusy(true);
    setAddItemsError(null);
    try {
      const result = await api.post<{ itemsAdded: number; performancesCreated: number }>(
        `/api/admin/sessions/${addingItemsTo.id}/items`,
        { itemIds: selectedAddItemIds },
      );
      setNotice(
        `${result.itemsAdded} item(s) added to "${addingItemsTo.name}"` +
          (result.performancesCreated > 0 ? ` — ${result.performancesCreated} performance(s) created and ready on stage.` : '.'),
      );
      setAddingItemsTo(null);
      load();
    } catch (err) {
      setAddItemsError(err);
    } finally {
      setAddItemsBusy(false);
    }
  }

  async function confirmDeleteSession() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.del(`/api/admin/sessions/${deleting.id}`);
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

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!rows) return <LoadingState />;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Sessions"
        actions={
          can('MANAGE_SESSIONS') && (
            <button type="button" className="btn btn-primary" onClick={() => setCreating({ name: '', panelId: '', itemIds: [] })}>
              + Add session
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

      <div className="card-flush">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Panel</th>
                <th>Status</th>
                <th>Progress</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.name}
                    <div className="text-xs muted">{s.stage ?? 'No stage set'}</div>
                  </td>
                  <td>
                    {s.panelName} ({s.panelSize})
                  </td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="num">
                    {s.completeCount}/{s.performanceCount}
                  </td>
                  <td className="row">
                    {can('MANAGE_SESSIONS') && s.status === 'DRAFT' && (
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => void openSession(s.id)}>
                        Open
                      </button>
                    )}
                    {can('MANAGE_SESSIONS') && s.status === 'OPEN' && (
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => void closeSession(s.id)}>
                        Close
                      </button>
                    )}
                    {can('MANAGE_SESSIONS') && (s.status === 'DRAFT' || s.status === 'OPEN') && (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => startAddItems(s)}>
                        + Add item
                      </button>
                    )}
                    {can('MANAGE_SESSIONS') && s.status === 'DRAFT' && (
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeleting(s)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Sheet open={creating !== null} onClose={() => setCreating(null)} title="Add session">
        {creating && (
          <div className="stack">
            <Field label="Name" required>
              <input className="input" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />
            </Field>
            <Field label="Panel" required>
              <select className="select" value={creating.panelId} onChange={(e) => setCreating({ ...creating, panelId: e.target.value })}>
                <option value="">Select a panel</option>
                {panels.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Items">
              <div className="stack-sm" style={{ maxHeight: 200, overflowY: 'auto' }}>
                {items.map((item) => (
                  <label key={item.id} className="row text-sm">
                    <input
                      type="checkbox"
                      checked={creating.itemIds.includes(item.id)}
                      onChange={(e) =>
                        setCreating({
                          ...creating,
                          itemIds: e.target.checked
                            ? [...creating.itemIds, item.id]
                            : creating.itemIds.filter((id) => id !== item.id),
                        })
                      }
                    />
                    {item.name}
                  </label>
                ))}
              </div>
            </Field>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!creating.name || !creating.panelId || creating.itemIds.length === 0}
              onClick={() => void createSession()}
            >
              Create
            </button>
          </div>
        )}
      </Sheet>

      <Sheet open={closeBlock !== null} onClose={() => setCloseBlock(null)} title="Cannot close session">
        {closeBlock && (
          <div className="stack">
            <Banner tone="warning">
              {closeBlock.incomplete.length} performance(s) are not complete. Force-close requires a reason
              (FSD ADM-08-05) and is flagged in the exceptions report.
            </Banner>
            <div className="stack-sm text-sm">
              {closeBlock.incomplete.map((p, i) => (
                <div key={i}>
                  {p.itemName} — {p.participantName}
                </div>
              ))}
            </div>
            <textarea
              className="textarea"
              placeholder="Reason for force-closing (min. 15 characters)"
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-danger"
              disabled={closeReason.length < 15}
              onClick={() => void closeSession(closeBlock.sessionId, true)}
            >
              Force close
            </button>
          </div>
        )}
      </Sheet>

      <Sheet
        open={addingItemsTo !== null}
        onClose={() => setAddingItemsTo(null)}
        title={addingItemsTo ? `Add item — ${addingItemsTo.name}` : 'Add item'}
      >
        {addingItemsTo && (
          <div className="stack">
            {addingItemsTo.status === 'OPEN' && (
              <p className="text-sm muted">
                This session is already open — any item you add here gets performances created for its current
                entries right away, ready to put on stage.
              </p>
            )}
            <Field label="Items">
              <div className="stack-sm" style={{ maxHeight: 240, overflowY: 'auto' }}>
                {items.map((item) => (
                  <label key={item.id} className="row text-sm">
                    <input
                      type="checkbox"
                      checked={selectedAddItemIds.includes(item.id)}
                      onChange={(e) =>
                        setSelectedAddItemIds((prev) =>
                          e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id),
                        )
                      }
                    />
                    {item.name}
                  </label>
                ))}
              </div>
            </Field>
            {addItemsError !== null && <ErrorState error={addItemsError} />}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setAddingItemsTo(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={selectedAddItemIds.length === 0 || addItemsBusy}
                onClick={() => void submitAddItems()}
              >
                {addItemsBusy ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete session"
        consequence={<><strong>{deleting?.name}</strong> will be permanently deleted. This cannot be undone.</>}
        confirmLabel="Delete"
        busy={deleteBusy}
        onConfirm={() => void confirmDeleteSession()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
