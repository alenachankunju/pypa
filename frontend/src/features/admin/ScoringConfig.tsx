/**
 * Screen A13 — Scoring configuration (FSD 5.11).
 * ADM-11-06: tie-break order, reorderable. ADM-11-07: grade bands and grade
 * points. ADM-11-08: championship rules. ADM-11-04: per-item point overrides.
 * ADM-11-09: locked once the first result is published; unlocking requires an
 * explicit confirmation that everything will be recomputed.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { AlertDialog, Banner, ErrorState, Field, LoadingState, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface GradeBand {
  grade: string;
  minPercentage: number;
  points: number;
}

interface ScoringConfigData {
  maxMark: number;
  decimalPlaces: number;
  aggregationMethod: string;
  allowSharedPositions: boolean;
  tiebreakOrder: string[];
  gradePointsEnabled: boolean;
  gradeBands: GradeBand[];
  minItemsForChampion: number;
  computeCategoryChampions: boolean;
  positionPoints: { position: number; points: number }[];
  locked: boolean;
  publishedItemCount: number;
}

const TIEBREAK_LABELS: Record<string, string> = {
  JUDGE_TOP_MARK_COUNT: 'Judge top-mark count',
  HIGHEST_SINGLE_MARK: 'Highest single mark',
  LOWEST_SPREAD: 'Lowest spread',
  CHIEF_JUDGE_MARK: 'Chief judge mark',
};

interface ItemOption {
  id: string;
  name: string;
}

export function ScoringConfig() {
  const { can } = useAuth();
  const [config, setConfig] = useState<ScoringConfigData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [alertError, setAlertError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockPreview, setUnlockPreview] = useState<{ itemName: string }[] | null>(null);
  const [unlockReason, setUnlockReason] = useState('');

  const [items, setItems] = useState<ItemOption[]>([]);
  const [overrideItemId, setOverrideItemId] = useState('');
  const [overridePoints, setOverridePoints] = useState<{ position: number; points: number }[]>([]);
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [overrideNotice, setOverrideNotice] = useState<string | null>(null);

  function load() {
    api.get<ScoringConfigData>('/api/admin/config/scoring').then(setConfig).catch(setError);
  }

  useEffect(load, []);
  useEffect(() => {
    api.get<ItemOption[]>('/api/admin/items').then(setItems).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!overrideItemId) {
      setOverridePoints([]);
      return;
    }
    api
      .get<{ positionPoints: { position: number; points: number }[] }>(`/api/admin/config/scoring/items/${overrideItemId}/points`)
      .then((r) => setOverridePoints(r.positionPoints))
      .catch(() => setOverridePoints([]));
  }, [overrideItemId]);

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
        gradeBands: config.gradeBands,
        minItemsForChampion: config.minItemsForChampion,
        computeCategoryChampions: config.computeCategoryChampions,
        positionPoints: config.positionPoints,
      });
      load();
    } catch (err) {
      setAlertError(err);
    } finally {
      setSaving(false);
    }
  }

  function moveTiebreak(index: number, direction: -1 | 1) {
    if (!config) return;
    const next = [...config.tiebreakOrder];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setConfig({ ...config, tiebreakOrder: next });
  }

  async function saveItemOverride() {
    if (!overrideItemId) return;
    setOverrideSaving(true);
    setOverrideNotice(null);
    try {
      await api.put(`/api/admin/config/scoring/items/${overrideItemId}/points`, { positionPoints: overridePoints });
      setOverrideNotice('Saved.');
    } catch (err) {
      setAlertError(err);
    } finally {
      setOverrideSaving(false);
    }
  }

  async function previewUnlock() {
    try {
      const result = await api.post<{ willUnpublish: { itemName: string }[] }>('/api/admin/config/scoring/unlock', {
        reason: 'preview',
        dryRun: true,
      });
      setUnlockPreview(result.willUnpublish);
      setUnlocking(true);
    } catch (err) {
      setAlertError(err);
    }
  }

  async function confirmUnlock() {
    try {
      await api.post('/api/admin/config/scoring/unlock', {
        reason: unlockReason,
        confirmUnpublishAll: true,
      });
      setUnlocking(false);
      setUnlockReason('');
      load();
    } catch (err) {
      setAlertError(err);
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!config) return <LoadingState />;

  return (
    <div className="stack-lg">
      <PageHeader icon="⚙" title="Scoring configuration" />

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
            <span className="label">Tie-break order</span>
            <div className="stack-sm">
              {config.tiebreakOrder.map((rule, i) => (
                <div key={rule} className="row-between" style={{ padding: 'var(--space-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                  <span>
                    <span className="text-xs muted" style={{ marginRight: 8 }}>
                      {i + 1}.
                    </span>
                    {TIEBREAK_LABELS[rule] ?? rule}
                  </span>
                  <div className="row">
                    <button type="button" className="btn btn-sm btn-ghost" disabled={i === 0} onClick={() => moveTiebreak(i, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={i === config.tiebreakOrder.length - 1}
                      onClick={() => moveTiebreak(i, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card stack">
            <p className="eyebrow">Grades</p>
            <label className="row text-sm">
              <input
                type="checkbox"
                checked={config.gradePointsEnabled}
                onChange={(e) => setConfig({ ...config, gradePointsEnabled: e.target.checked })}
              />
              Grade points count toward the championship
            </label>
            {config.gradeBands.map((band, i) => (
              <div key={i} className="row">
                <input
                  className="input"
                  style={{ width: 80 }}
                  placeholder="Grade"
                  value={band.grade}
                  onChange={(e) => {
                    const next = [...config.gradeBands];
                    next[i] = { ...band, grade: e.target.value };
                    setConfig({ ...config, gradeBands: next });
                  }}
                />
                <Field label="Min %">
                  <input
                    type="number"
                    className="input"
                    value={band.minPercentage}
                    onChange={(e) => {
                      const next = [...config.gradeBands];
                      next[i] = { ...band, minPercentage: Number(e.target.value) };
                      setConfig({ ...config, gradeBands: next });
                    }}
                  />
                </Field>
                {config.gradePointsEnabled && (
                  <Field label="Points">
                    <input
                      type="number"
                      className="input"
                      value={band.points}
                      onChange={(e) => {
                        const next = [...config.gradeBands];
                        next[i] = { ...band, points: Number(e.target.value) };
                        setConfig({ ...config, gradeBands: next });
                      }}
                    />
                  </Field>
                )}
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setConfig({ ...config, gradeBands: config.gradeBands.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => setConfig({ ...config, gradeBands: [...config.gradeBands, { grade: '', minPercentage: 0, points: 0 }] })}
            >
              + Add grade band
            </button>
          </div>

          <div className="card stack">
            <p className="eyebrow">Championship</p>
            <Field label="Minimum items for individual champion eligibility">
              <input
                type="number"
                className="input"
                value={config.minItemsForChampion}
                onChange={(e) => setConfig({ ...config, minItemsForChampion: Number(e.target.value) })}
              />
            </Field>
            <label className="row text-sm">
              <input
                type="checkbox"
                checked={config.computeCategoryChampions}
                onChange={(e) => setConfig({ ...config, computeCategoryChampions: e.target.checked })}
              />
              Compute category champions
            </label>
          </div>

          {can('CONFIGURE_SCORING') && (
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save configuration'}
            </button>
          )}
        </div>
      </fieldset>

      <div className="card stack">
        <p className="eyebrow">Per-item point overrides (ADM-11-04)</p>
        <Field label="Item">
          <select className="select" value={overrideItemId} onChange={(e) => setOverrideItemId(e.target.value)}>
            <option value="">Select an item</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </Field>
        {overrideItemId && (
          <>
            {overridePoints.length === 0 && <p className="text-sm muted">No override — this item uses the event-wide position points above.</p>}
            {overridePoints.map((pp, i) => (
              <div key={i} className="row">
                <span style={{ width: 60 }}>Position {pp.position}</span>
                <input
                  type="number"
                  className="input"
                  value={pp.points}
                  onChange={(e) => {
                    const next = [...overridePoints];
                    next[i] = { ...pp, points: Number(e.target.value) };
                    setOverridePoints(next);
                  }}
                />
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOverridePoints(overridePoints.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            ))}
            <div className="row">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => setOverridePoints([...overridePoints, { position: overridePoints.length + 1, points: 0 }])}
              >
                + Add position
              </button>
              {can('CONFIGURE_SCORING') && (
                <button type="button" className="btn btn-sm btn-primary" disabled={overrideSaving} onClick={() => void saveItemOverride()}>
                  {overrideSaving ? 'Saving…' : 'Save override'}
                </button>
              )}
              {overrideNotice && <span className="text-sm muted">{overrideNotice}</span>}
            </div>
          </>
        )}
      </div>

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

      <AlertDialog error={alertError} onClose={() => setAlertError(null)} />
    </div>
  );
}
