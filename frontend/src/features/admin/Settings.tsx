/**
 * Screen A19 — Settings (FSD 5.15).
 * ADM-15-01: event details, cut-off date. ADM-15-07: freeze mode.
 * ADM-14-05: audit retention period. ADM-15-02..05: backups and export.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { AlertDialog, Banner, ErrorState, Field, LoadingState, PageHeader, Sheet } from '../../components/ui';
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
  status: string;
  freezeMode: boolean;
  freezeReason: string | null;
  auditRetentionMonths: number;
}

interface ArchivePreview {
  dryRun: true;
  willArchive: { members: number; items: number; registrations: number; scores: number };
  note: string;
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

  // ADM-15-06: event list, creating the next one, and archive-and-reset.
  const [events, setEvents] = useState<EventData[] | null>(null);
  const [creating, setCreating] = useState<{
    name: string;
    edition: string;
    startDate: string;
    endDate: string;
    ageCutoffDate: string;
    timezone: string;
    activate: boolean;
  } | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [activateBusy, setActivateBusy] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [archivePreview, setArchivePreview] = useState<ArchivePreview | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);

  function load() {
    api.get<EventData | null>('/api/admin/events/active').then((e) => e && setEvent(e)).catch(setError);
  }

  function loadEvents() {
    api.get<EventData[]>('/api/admin/events').then(setEvents).catch(() => undefined);
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
  useEffect(loadEvents, []);
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

  function startCreateEvent() {
    setCreating({
      name: '',
      edition: '',
      startDate: '',
      endDate: '',
      ageCutoffDate: '',
      timezone: 'Asia/Kolkata',
      activate: false,
    });
  }

  async function saveNewEvent() {
    if (!creating) return;
    setCreateBusy(true);
    try {
      await api.post('/api/admin/events', {
        name: creating.name,
        edition: creating.edition || undefined,
        startDate: creating.startDate || undefined,
        endDate: creating.endDate || undefined,
        ageCutoffDate: creating.ageCutoffDate,
        timezone: creating.timezone || undefined,
        activate: creating.activate,
      });
      setCreating(null);
      loadEvents();
      if (creating.activate) load();
    } catch (err) {
      setAlertError(err);
    } finally {
      setCreateBusy(false);
    }
  }

  async function activateEvent(id: string) {
    setActivateBusy(id);
    try {
      await api.post(`/api/admin/events/${id}/activate`, {});
      loadEvents();
      load();
    } catch (err) {
      setAlertError(err);
    } finally {
      setActivateBusy(null);
    }
  }

  function startArchive() {
    setArchiving(true);
    setArchiveReason('');
    setArchivePreview(null);
  }

  async function previewArchive() {
    if (!event || archiveReason.trim().length < 10) return;
    setArchiveBusy(true);
    try {
      const result = await api.post<ArchivePreview>(`/api/admin/events/${event.id}/archive`, {
        reason: archiveReason,
        confirm: false,
      });
      setArchivePreview(result);
    } catch (err) {
      setAlertError(err);
    } finally {
      setArchiveBusy(false);
    }
  }

  async function confirmArchive() {
    if (!event) return;
    setArchiveBusy(true);
    try {
      await api.post(`/api/admin/events/${event.id}/archive`, { reason: archiveReason, confirm: true });
      setArchiving(false);
      setArchivePreview(null);
      loadEvents();
      load();
    } catch (err) {
      setAlertError(err);
    } finally {
      setArchiveBusy(false);
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
          <div className="row-between">
            <p className="eyebrow">Events (ADM-15-06)</p>
            <button type="button" className="btn btn-sm btn-secondary" onClick={startCreateEvent}>
              + New event
            </button>
          </div>
          <p className="text-sm muted">
            Only one event is active at a time. Starting a new one doesn't touch the old event's data — it just
            stops being active. Churches and user accounts are global and carry over automatically.
          </p>
          {!events ? (
            <LoadingState />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Edition</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td>{e.name}</td>
                      <td>{e.edition ?? '—'}</td>
                      <td>
                        <span
                          className={`badge ${e.status === 'ACTIVE' ? 'badge-success' : e.status === 'ARCHIVED' ? 'badge-neutral' : 'badge-info'}`}
                        >
                          {e.status}
                        </span>
                      </td>
                      <td>
                        {e.status === 'SETUP' && (
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            disabled={activateBusy !== null}
                            onClick={() => void activateEvent(e.id)}
                          >
                            {activateBusy === e.id ? 'Activating…' : 'Activate'}
                          </button>
                        )}
                        {e.status === 'ACTIVE' && (
                          <button type="button" className="btn btn-sm btn-danger" onClick={startArchive}>
                            Archive &amp; start fresh
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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

      <Sheet open={creating !== null} onClose={() => setCreating(null)} title="New event">
        {creating && (
          <div className="stack">
            <Field label="Event name" required>
              <input className="input" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />
            </Field>
            <Field label="Edition / year">
              <input className="input" value={creating.edition} onChange={(e) => setCreating({ ...creating, edition: e.target.value })} />
            </Field>
            <div className="row">
              <Field label="Start date">
                <input type="date" className="input" value={creating.startDate} onChange={(e) => setCreating({ ...creating, startDate: e.target.value })} />
              </Field>
              <Field label="End date">
                <input type="date" className="input" value={creating.endDate} onChange={(e) => setCreating({ ...creating, endDate: e.target.value })} />
              </Field>
            </div>
            <Field label="Age cut-off date" required hint="Determines every member's category (FSD ADM-03-03)">
              <input
                type="date"
                className="input"
                value={creating.ageCutoffDate}
                onChange={(e) => setCreating({ ...creating, ageCutoffDate: e.target.value })}
              />
            </Field>
            <Field label="Timezone">
              <input className="input" value={creating.timezone} onChange={(e) => setCreating({ ...creating, timezone: e.target.value })} />
            </Field>
            <label className="row" style={{ gap: 'var(--space-2)' }}>
              <input type="checkbox" checked={creating.activate} onChange={(e) => setCreating({ ...creating, activate: e.target.checked })} />
              Make this the active event immediately
            </label>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={createBusy || !creating.name || !creating.ageCutoffDate}
                onClick={() => void saveNewEvent()}
              >
                {createBusy ? 'Creating…' : 'Create event'}
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet
        open={archiving}
        onClose={() => {
          setArchiving(false);
          setArchivePreview(null);
        }}
        title="Archive & start fresh"
      >
        <div className="stack">
          <Banner tone="danger" title={`This closes "${event.name}"`}>
            The event becomes read-only (frozen) and stops being active. Nothing is deleted — churches and user
            accounts stay available, and the old event's own data (members, items, registrations, scores) is kept
            exactly as it stood, for the record.
          </Banner>
          <Field label="Reason" required hint="At least 10 characters — recorded in the audit log">
            <textarea className="textarea" value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} />
          </Field>

          {archivePreview && (
            <div className="card stack-sm" style={{ background: 'var(--surface-sunken)' }}>
              <span className="text-sm strong">This event currently has:</span>
              <div className="grid grid-4">
                <StatMini value={archivePreview.willArchive.members} label="Members" />
                <StatMini value={archivePreview.willArchive.items} label="Items" />
                <StatMini value={archivePreview.willArchive.registrations} label="Registrations" />
                <StatMini value={archivePreview.willArchive.scores} label="Scores" />
              </div>
              <p className="text-xs muted">{archivePreview.note}</p>
            </div>
          )}

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setArchiving(false);
                setArchivePreview(null);
              }}
            >
              Cancel
            </button>
            {!archivePreview ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={archiveBusy || archiveReason.trim().length < 10}
                onClick={() => void previewArchive()}
              >
                {archiveBusy ? 'Checking…' : 'Preview'}
              </button>
            ) : (
              <button type="button" className="btn btn-danger" disabled={archiveBusy} onClick={() => void confirmArchive()}>
                {archiveBusy ? 'Archiving…' : 'Confirm archive'}
              </button>
            )}
          </div>
        </div>
      </Sheet>

      <AlertDialog error={alertError} onClose={() => setAlertError(null)} />
    </div>
  );
}

function StatMini({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="stat-value" style={{ fontSize: 'var(--text-lg)' }}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
