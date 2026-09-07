/**
 * Screen A10 — Panel builder (FSD 5.8).
 * ADM-08-01/02: name, judges, chief judge; panel size is whatever is assigned.
 * ADM-07-03: conflict-of-interest warnings when assigning a judge.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { AlertDialog, Banner, ConfirmDialog, ErrorState, Field, LoadingState, PageHeader, Sheet } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface Judge {
  userId: string;
  fullName: string;
  weight: number;
  isChief: boolean;
  affiliatedChurchName: string | null;
}
interface Panel {
  id: string;
  name: string;
  panelSize: number;
  chiefJudgeId: string | null;
  isActive: boolean;
  judges: Judge[];
}
interface JudgeOption {
  id: string;
  fullName: string;
  role: string;
}

export function Panels() {
  const { can } = useAuth();
  const [panels, setPanels] = useState<Panel[] | null>(null);
  const [judgeOptions, setJudgeOptions] = useState<JudgeOption[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [alertError, setAlertError] = useState<unknown>(null);
  const [creating, setCreating] = useState<{ name: string } | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [selectedJudge, setSelectedJudge] = useState('');
  const [conflictWarning, setConflictWarning] = useState<{ message: string; requiresOverride: boolean } | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [deleting, setDeleting] = useState<Panel | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function load() {
    api.get<Panel[]>('/api/admin/panels').then(setPanels).catch(setError);
  }

  useEffect(load, []);
  useEffect(() => {
    api.get<JudgeOption[]>('/api/admin/users', { role: 'JUDGE', pageSize: 200 }).then(setJudgeOptions).catch(() => undefined);
  }, []);

  async function createPanel() {
    if (!creating) return;
    try {
      await api.post('/api/admin/panels', { name: creating.name });
      setCreating(null);
      load();
    } catch (err) {
      setAlertError(err);
    }
  }

  async function assignJudge(panelId: string, override?: string) {
    try {
      await api.post(`/api/admin/panels/${panelId}/judges`, {
        userId: selectedJudge,
        conflictOverrideReason: override,
      });
      setAssigning(null);
      setSelectedJudge('');
      setConflictWarning(null);
      setOverrideReason('');
      load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        setConflictWarning({ message: err.message, requiresOverride: true });
      } else {
        setAlertError(err);
      }
    }
  }

  async function removeJudge(panelId: string, userId: string) {
    const reason = window.prompt('Reason for removing this judge (FSD ADM-08-06):') ?? 'Panel change';
    try {
      await api.del(`/api/admin/panels/${panelId}/judges/${userId}`, { reason });
      load();
    } catch (err) {
      setAlertError(err);
    }
  }

  async function toggleActive(panel: Panel) {
    try {
      await api.patch(`/api/admin/panels/${panel.id}`, { isActive: !panel.isActive });
      load();
    } catch (err) {
      setAlertError(err);
    }
  }

  async function confirmDeletePanel() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.del(`/api/admin/panels/${deleting.id}`);
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
      setDeleteBusy(false);
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!panels) return <LoadingState />;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Panels"
        actions={
          can('MANAGE_PANELS') && (
            <button type="button" className="btn btn-primary" onClick={() => setCreating({ name: '' })}>
              + Add panel
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

      <div className="grid grid-2">
        {panels.map((panel) => (
          <div key={panel.id} className="card stack-sm" style={!panel.isActive ? { opacity: 0.5 } : undefined}>
            <div className="row-between">
              <span className="strong">{panel.name}</span>
              <span className="badge badge-neutral">{panel.panelSize} judge(s)</span>
            </div>
            <div className="stack-sm">
              {panel.judges.map((j) => (
                <div key={j.userId} className="row-between text-sm">
                  <span>
                    {j.fullName}
                    {j.isChief && <span className="badge badge-award" style={{ marginLeft: 4 }}>Chief</span>}
                    {j.affiliatedChurchName && <span className="text-xs muted"> · linked to {j.affiliatedChurchName}</span>}
                  </span>
                  {can('MANAGE_PANELS') && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => void removeJudge(panel.id, j.userId)}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
            {can('MANAGE_PANELS') && (
              <div className="row row-wrap">
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAssigning(panel.id)}>
                  + Add judge
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void toggleActive(panel)}>
                  {panel.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeleting(panel)}>
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <Sheet open={creating !== null} onClose={() => setCreating(null)} title="Add panel">
        {creating && (
          <div className="stack">
            <Field label="Name" required>
              <input className="input" value={creating.name} onChange={(e) => setCreating({ name: e.target.value })} />
            </Field>
            <button type="button" className="btn btn-primary" onClick={() => void createPanel()}>
              Create
            </button>
          </div>
        )}
      </Sheet>

      <Sheet open={assigning !== null} onClose={() => setAssigning(null)} title="Add judge to panel">
        <div className="stack">
          <Field label="Judge">
            <select className="select" value={selectedJudge} onChange={(e) => setSelectedJudge(e.target.value)}>
              <option value="">Select a judge</option>
              {judgeOptions.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.fullName}
                </option>
              ))}
            </select>
          </Field>

          {conflictWarning && (
            <Banner tone="warning" title="Conflict of interest">
              <p style={{ marginBottom: 'var(--space-2)' }}>{conflictWarning.message}</p>
              <textarea
                className="textarea"
                placeholder="Reason to proceed anyway"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
            </Banner>
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={!selectedJudge}
            onClick={() => void assignJudge(assigning!, conflictWarning ? overrideReason : undefined)}
          >
            {conflictWarning ? 'Assign anyway' : 'Assign'}
          </button>
        </div>
      </Sheet>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete panel"
        consequence={<><strong>{deleting?.name}</strong> will be permanently deleted. This cannot be undone.</>}
        confirmLabel="Delete"
        busy={deleteBusy}
        onConfirm={() => void confirmDeletePanel()}
        onCancel={() => setDeleting(null)}
      />

      <AlertDialog error={alertError} onClose={() => setAlertError(null)} />
    </div>
  );
}
