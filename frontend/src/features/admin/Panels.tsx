/**
 * Screen A10 — Panel builder (FSD 5.8).
 * ADM-08-01/02: name, judges, chief judge; panel size is whatever is assigned.
 * ADM-07-03: conflict-of-interest warnings when assigning a judge.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Banner, ErrorState, Field, LoadingState, PageHeader, Sheet } from '../../components/ui';
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
  const [creating, setCreating] = useState<{ name: string } | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [selectedJudge, setSelectedJudge] = useState('');
  const [conflictWarning, setConflictWarning] = useState<{ message: string; requiresOverride: boolean } | null>(null);
  const [overrideReason, setOverrideReason] = useState('');

  function load() {
    api.get<Panel[]>('/api/admin/panels').then(setPanels).catch(setError);
  }

  useEffect(load, []);
  useEffect(() => {
    api.get<JudgeOption[]>('/api/admin/users', { role: 'JUDGE', pageSize: 500 }).then(setJudgeOptions);
  }, []);

  async function createPanel() {
    if (!creating) return;
    await api.post('/api/admin/panels', { name: creating.name });
    setCreating(null);
    load();
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
        setError(err);
      }
    }
  }

  async function removeJudge(panelId: string, userId: string) {
    const reason = window.prompt('Reason for removing this judge (FSD ADM-08-06):') ?? 'Panel change';
    await api.del(`/api/admin/panels/${panelId}/judges/${userId}`, { reason });
    load();
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

      <div className="grid grid-2">
        {panels.map((panel) => (
          <div key={panel.id} className="card stack-sm">
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
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAssigning(panel.id)}>
                + Add judge
              </button>
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
    </div>
  );
}
