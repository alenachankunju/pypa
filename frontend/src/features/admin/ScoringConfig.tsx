/**
 * Screen A13 — Scoring configuration (FSD 5.11).
 * ADM-11-09: locked once the first result is published; unlocking requires an
 * explicit confirmation that everything will be recomputed.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Banner, ErrorState, Field, LoadingState, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface ScoringConfigData {
  maxMark: number;
  decimalPlaces: number;
  aggregationMethod: string;
  allowSharedPositions: boolean;
  tiebreakOrder: string[];
  gradePointsEnabled: boolean;
  positionPoints: { position: number; points: number }[];
  locked: boolean;
  publishedItemCount: number;
}

export function ScoringConfig() {
  const { can } = useAuth();
  const [config, setConfig] = useState<ScoringConfigData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockPreview, setUnlockPreview] = useState<{ itemName: string }[] | null>(null);
  const [unlockReason, setUnlockReason] = useState('');

  function load() {
    api.get<ScoringConfigData>('/api/admin/config/scoring').then(setConfig).catch(setError);
  }

  useEffect(load, []);

  async function save() {
    if (!config) return;
    setSaving(true);
    try {
      await api.put('/api/admin/config/scoring', {
        maxMark: config.maxMark,
        decimalPlaces: config.decimalPlaces,
        aggregationMethod: config.aggregationMethod,
        allowSharedPositions: config.allowSharedPositions,
        tiebreakOrder: config.tiebreakOrder,
        gradePointsEnabled: config.gradePointsEnabled,
        positionPoints: config.positionPoints,
      });
      load();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function previewUnlock() {
    const result = await api.post<{ willUnpublish: { itemName: string }[] }>('/api/admin/config/scoring/unlock', {
      reason: 'preview',
      dryRun: true,
    });
    setUnlockPreview(result.willUnpublish);
    setUnlocking(true);
  }

  async function confirmUnlock() {
    await api.post('/api/admin/config/scoring/unlock', {
      reason: unlockReason,
      confirmUnpublishAll: true,
    });
    setUnlocking(false);
    setUnlockReason('');
    load();
  }

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!config) return <LoadingState />;

  return (
    <div className="stack-lg">
      <PageHeader title="Scoring configuration" />

      {config.locked && (
        <Banner tone="warning" title="Configuration is locked">
          {config.publishedItemCount} item(s) are published. Unlock to make changes — this will unpublish
          every result and force a full recomputation (FSD ADM-11-09).
          {can('CONFIGURE_SCORING') && (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void previewUnlock()}>
                Unlock configuration
              </button>
            </div>
          )}
        </Banner>
      )}

      <fieldset disabled={config.locked || !can('CONFIGURE_SCORING')} style={{ border: 'none', padding: 0 }}>
        <div className="stack-lg">
          <div className="card stack">
            <p className="eyebrow">Marks</p>
            <div className="row">
              <Field label="Maximum mark">
                <input
                  type="number"
                  className="input"
                  value={config.maxMark}
                  onChange={(e) => setConfig({ ...config, maxMark: Number(e.target.value) })}
                />
              </Field>
              <Field label="Decimal places">
                <input
                  type="number"
                  className="input"
                  min={0}
                  max={3}
                  value={config.decimalPlaces}
                  onChange={(e) => setConfig({ ...config, decimalPlaces: Number(e.target.value) })}
                />
              </Field>
              <Field label="Aggregation method">
                <select
                  className="select"
                  value={config.aggregationMethod}
                  onChange={(e) => setConfig({ ...config, aggregationMethod: e.target.value })}
                >
                  <option value="AVERAGE">Average</option>
                  <option value="SUM">Sum</option>
                  <option value="TRIMMED_MEAN">Trimmed mean (4+ judges)</option>
                  <option value="WEIGHTED_AVERAGE">Weighted average</option>
                </select>
              </Field>
            </div>
          </div>

          <div className="card stack">
            <p className="eyebrow">Position points</p>
            {config.positionPoints.map((pp, i) => (
              <div key={i} className="row">
                <span style={{ width: 60 }}>Position {pp.position}</span>
                <input
                  type="number"
                  className="input"
                  value={pp.points}
                  onChange={(e) => {
                    const next = [...config.positionPoints];
                    next[i] = { ...pp, points: Number(e.target.value) };
                    setConfig({ ...config, positionPoints: next });
                  }}
                />
              </div>
            ))}
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() =>
                setConfig({
                  ...config,
                  positionPoints: [...config.positionPoints, { position: config.positionPoints.length + 1, points: 0 }],
                })
              }
            >
              + Add position
            </button>
          </div>

          <div className="card stack">
            <p className="eyebrow">Ties</p>
            <label className="row text-sm">
              <input
                type="checkbox"
                checked={config.allowSharedPositions}
                onChange={(e) => setConfig({ ...config, allowSharedPositions: e.target.checked })}
              />
              Allow shared positions
            </label>
            <p className="hint">Tie-break order: {config.tiebreakOrder.join(' → ')}</p>
          </div>

          {can('CONFIGURE_SCORING') && (
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save configuration'}
            </button>
          )}
        </div>
      </fieldset>

      {unlocking && (
        <div className="overlay" onClick={() => setUnlocking(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2 className="page-title">Unlock configuration?</h2>
            <Banner tone="danger" title={`This will unpublish ${unlockPreview?.length ?? 0} item(s)`}>
              Church totals and the championship will be recalculated. Announced results may change.
            </Banner>
            <div className="stack-sm text-sm" style={{ margin: 'var(--space-3) 0', maxHeight: 160, overflowY: 'auto' }}>
              {unlockPreview?.map((p, i) => <div key={i}>{p.itemName}</div>)}
            </div>
            <textarea
              className="textarea"
              placeholder="Reason (min. 15 characters)"
              value={unlockReason}
              onChange={(e) => setUnlockReason(e.target.value)}
            />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setUnlocking(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={unlockReason.length < 15} onClick={() => void confirmUnlock()}>
                Unlock and unpublish
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
