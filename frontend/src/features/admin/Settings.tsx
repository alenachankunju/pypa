/**
 * Screen A19 — Settings (FSD 5.15).
 * ADM-15-01: event details, cut-off date. ADM-15-07: freeze mode.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Banner, ErrorState, Field, LoadingState, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface EventData {
  id: string;
  name: string;
  edition: string | null;
  ageCutoffDate: string;
  timezone: string;
  freezeMode: boolean;
  freezeReason: string | null;
}

export function Settings() {
  const { can } = useAuth();
  const [event, setEvent] = useState<EventData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [freezeReason, setFreezeReason] = useState('');

  function load() {
    api.get<EventData | null>('/api/admin/events/active').then((e) => e && setEvent(e)).catch(setError);
  }

  useEffect(load, []);

  async function save() {
    if (!event) return;
    setSaving(true);
    try {
      await api.patch(`/api/admin/events/${event.id}`, {
        name: event.name,
        edition: event.edition,
        ageCutoffDate: event.ageCutoffDate,
        timezone: event.timezone,
      });
      load();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function toggleFreeze() {
    if (!event) return;
    await api.post(`/api/admin/events/${event.id}/freeze`, {
      frozen: !event.freezeMode,
      reason: !event.freezeMode ? freezeReason : undefined,
    });
    load();
  }

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!event) return <LoadingState />;

  return (
    <div className="stack-lg">
      <PageHeader title="Settings" />

      {event.freezeMode && (
        <Banner tone="danger" title="Event is frozen">
          {event.freezeReason ?? 'No data changes are permitted.'}
        </Banner>
      )}

      <fieldset disabled={!can('MANAGE_SETTINGS')} style={{ border: 'none', padding: 0 }}>
        <div className="card stack">
          <Field label="Event name">
            <input className="input" value={event.name} onChange={(e) => setEvent({ ...event, name: e.target.value })} />
          </Field>
          <Field label="Edition / year">
            <input className="input" value={event.edition ?? ''} onChange={(e) => setEvent({ ...event, edition: e.target.value })} />
          </Field>
          <Field label="Age cut-off date" hint="Determines every member's category (FSD ADM-03-03)">
            <input
              type="date"
              className="input"
              value={event.ageCutoffDate.slice(0, 10)}
              onChange={(e) => setEvent({ ...event, ageCutoffDate: e.target.value })}
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
    </div>
  );
}
