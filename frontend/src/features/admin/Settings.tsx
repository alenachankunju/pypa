/**
 * Screen A19 — Settings (FSD 5.15).
 * ADM-15-01: event details, cut-off date. ADM-15-07: freeze mode.
 * ADM-14-05: audit retention period. ADM-15-02..05: backups and export.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { AlertDialog, Banner, ErrorState, Field, LoadingState, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface EventData {
  id: string;
  name: string;
  edition: string | null;
  logoPath: string | null;
  startDate: string | null;
  endDate: string | null;
  ageCutoffDate: string;
  timezone: string;
  freezeMode: boolean;
  freezeReason: string | null;
  auditRetentionMonths: number;
}

interface RetentionStatus {
  cutoff: string | null;
  eligibleForPurgeCount: number;
  retentionMonths: number;
}

interface Snapshot {
  id: string;
  label: string;
  reason: string;
  createdAt: string;
  createdByName: string | null;
  sizeBytes: number;
}

export function Settings() {
  const { can } = useAuth();
  const [event, setEvent] = useState<EventData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [alertError, setAlertError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [freezeReason, setFreezeReason] = useState('');

  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [restoreConfirm, setRestoreConfirm] = useState<Snapshot | null>(null);
  const [retention, setRetention] = useState<RetentionStatus | null>(null);

  function load() {
    api.get<EventData | null>('/api/admin/events/active').then((e) => e && setEvent(e)).catch(setError);
  }

  function loadRetention() {
    api.get<RetentionStatus>('/api/admin/audit/retention').then(setRetention).catch(() => undefined);
  }

  function loadSnapshots() {
    api
      .get<Snapshot[]>('/api/admin/snapshots')
      .then(setSnapshots)
      .catch(() => setSnapshots([]));
  }

  useEffect(load, []);
  useEffect(loadSnapshots, []);
  useEffect(loadRetention, []);

  async function save() {
    if (!event) return;
    setSaving(true);
    try {
      await api.patch(`/api/admin/events/${event.id}`, {
        name: event.name,
        edition: event.edition,
        logoPath: event.logoPath,
        startDate: event.startDate,
        endDate: event.endDate,
        ageCutoffDate: event.ageCutoffDate,
        timezone: event.timezone,
        auditRetentionMonths: event.auditRetentionMonths,
      });
      load();
      loadRetention();
    } catch (err) {
      setAlertError(err);
    } finally {
      setSaving(false);
    }
  }

  async function toggleFreeze() {
    if (!event) return;
    try {
      await api.post(`/api/admin/events/${event.id}/freeze`, {
        frozen: !event.freezeMode,
        reason: !event.freezeMode ? freezeReason : undefined,
      });
      load();
    } catch (err) {
      setAlertError(err);
    }
  }

  async function takeSnapshot() {
    setSnapshotBusy(true);
    try {
      await api.post('/api/admin/snapshots', { label: snapshotLabel || 'Manual snapshot', reason: 'Manual snapshot before a bulk operation (ADM-15-03).' });
      setSnapshotLabel('');
      loadSnapshots();
    } catch (err) {
      setAlertError(err);
    } finally {
      setSnapshotBusy(false);
    }
  }

  async function exportData() {
    try {
      const payload = await api.post('/api/admin/snapshots/export', {});
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pypa-export-${event?.id ?? 'event'}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setAlertError(err);
    }
  }

  async function confirmRestore() {
    if (!restoreConfirm) return;
    setSnapshotBusy(true);
    try {
      await api.post(`/api/admin/snapshots/${restoreConfirm.id}/restore`, { confirm: true });
      setRestoreConfirm(null);
      load();
      loadSnapshots();
    } catch (err) {
      setAlertError(err);
    } finally {
      setSnapshotBusy(false);
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!event) return <LoadingState />;

  return (
    <div className="stack-lg">
      <PageHeader icon="⚒" title="Settings" />

      {event.freezeMode && (
        <Banner tone="danger" title="Event is frozen">
          {event.freezeReason ?? 'No data changes are permitted.'}
        </Banner>
      )}

      <fieldset disabled={!can('MANAGE_SETTINGS')} style={{ border: 'none', padding: 0 }}>
        <div className="card stack">
          <p className="eyebrow">Event details</p>
          <Field label="Event name">
            <input className="input" value={event.name} onChange={(e) => setEvent({ ...event, name: e.target.value })} />
          </Field>
          <Field label="Edition / year">
            <input className="input" value={event.edition ?? ''} onChange={(e) => setEvent({ ...event, edition: e.target.value })} />
          </Field>
          <Field label="Logo URL">
            <input className="input" value={event.logoPath ?? ''} onChange={(e) => setEvent({ ...event, logoPath: e.target.value })} />
          </Field>
          <div className="row">
            <Field label="Start date">
              <input
                type="date"
                className="input"
                value={event.startDate?.slice(0, 10) ?? ''}
                onChange={(e) => setEvent({ ...event, startDate: e.target.value })}
              />
            </Field>
            <Field label="End date">
              <input
                type="date"
                className="input"
                value={event.endDate?.slice(0, 10) ?? ''}
                onChange={(e) => setEvent({ ...event, endDate: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Age cut-off date" hint="Determines every member's category (FSD ADM-03-03)">
            <input
              type="date"
              className="input"
              value={event.ageCutoffDate.slice(0, 10)}
              onChange={(e) => setEvent({ ...event, ageCutoffDate: e.target.value })}
            />
          </Field>
          <Field label="Timezone" hint="IANA timezone, e.g. Asia/Kolkata">
            <input className="input" value={event.timezone} onChange={(e) => setEvent({ ...event, timezone: e.target.value })} />
          </Field>
          <Field label="Audit retention (months)" hint="ADM-14-05: months after the end date before entries are archival-eligible">
            <input
              type="number"
              className="input"
              min={1}
              value={event.auditRetentionMonths}
              onChange={(e) => setEvent({ ...event, auditRetentionMonths: Number(e.target.value) })}
            />
          </Field>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </fieldset>

      {can('MANAGE_SETTINGS') && (
        <div className="card stack">
          <p className="eyebrow">Freeze mode</p>
          <p className="text-sm muted">Blocks all data changes once results are final (FSD ADM-15-07).</p>
          {!event.freezeMode && (
            <textarea
              className="textarea"
              placeholder="Reason for freezing"
              value={freezeReason}
              onChange={(e) => setFreezeReason(e.target.value)}
            />
          )}
          <button
            type="button"
            className={`btn ${event.freezeMode ? 'btn-secondary' : 'btn-danger'}`}
            onClick={() => void toggleFreeze()}
          >
            {event.freezeMode ? 'Lift freeze' : 'Freeze event'}
          </button>
        </div>
      )}

      {retention && (
        <div className="card stack">
          <p className="eyebrow">Audit retention (ADM-14-05)</p>
          {retention.cutoff ? (
            <p className="text-sm muted">
              {retention.eligibleForPurgeCount > 0
                ? `${retention.eligibleForPurgeCount} ${retention.eligibleForPurgeCount === 1 ? 'entry is' : 'entries are'} past the ${retention.retentionMonths}-month retention cut-off (${new Date(retention.cutoff).toLocaleDateString()}).`
                : `Nothing is past the ${retention.retentionMonths}-month retention cut-off yet.`}
            </p>
          ) : (
            <p className="text-sm muted">Set the event's end date to activate a retention cut-off.</p>
          )}
          <p className="text-xs muted">
            The audit log is append-only by design (ADM-14-03) — no application action can delete entries, including
            this one. Purging past the retention period is a deliberate out-of-band database action, not an in-app button.
          </p>
        </div>
      )}

      {can('BACKUP_RESTORE') && (
        <div className="card stack">
          <p className="eyebrow">Backups and export (ADM-15-02..05)</p>
          <p className="text-sm muted">Take a manual snapshot before any bulk or destructive operation, or export a full restorable dump.</p>
          <div className="row">
            <input
              className="input"
              placeholder="Snapshot label (optional)"
              value={snapshotLabel}
              onChange={(e) => setSnapshotLabel(e.target.value)}
            />
            <button type="button" className="btn btn-secondary" disabled={snapshotBusy} onClick={() => void takeSnapshot()}>
              {snapshotBusy ? 'Working…' : 'Snapshot now'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void exportData()}>
              Export full data
            </button>
          </div>

          {snapshots === null ? (
            <LoadingState />
          ) : snapshots.length === 0 ? (
            <p className="text-sm muted">No snapshots yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Taken</th>
                    <th>By</th>
                    <th>Size</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s) => (
                    <tr key={s.id}>
                      <td>{s.label}</td>
                      <td>{new Date(s.createdAt).toLocaleString()}</td>
                      <td>{s.createdByName ?? '—'}</td>
                      <td className="num">{(s.sizeBytes / 1024).toFixed(0)} KB</td>
                      <td>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => setRestoreConfirm(s)}>
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {restoreConfirm && (
        <div className="overlay" onClick={() => setRestoreConfirm(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2 className="page-title">Restore "{restoreConfirm.label}"?</h2>
            <Banner tone="danger" title="This replaces all current data with the snapshot">
              Every change made since this snapshot was taken will be lost. This cannot be undone (ADM-15-05).
            </Banner>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setRestoreConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={snapshotBusy} onClick={() => void confirmRestore()}>
                {snapshotBusy ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog error={alertError} onClose={() => setAlertError(null)} />
    </div>
  );
}
