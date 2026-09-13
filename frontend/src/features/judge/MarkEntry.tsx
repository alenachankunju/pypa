/**
 * Screens J6/J7/J8 — Mark entry, Confirm sheet, Success (FSD 6.5, 6.6).
 *
 * "Design principle: a judge should be able to complete a full scoring cycle —
 * identify participant, choose item, enter mark, confirm, submit — in under
 * fifteen seconds and no more than four taps."
 *
 * JDG-05-02: a large stepper with increment/decrement plus direct numeric entry.
 * "A slider alone is not acceptable because precision matters."
 * JDG-05-03: out-of-range values cannot be entered, not merely rejected after.
 * JDG-06-01/02/03: confirmation sheet restates everything, states immutability
 * explicitly, and Cancel preserves the value.
 * JDG-06-04/05: idempotency key generated here, at confirm time — see
 * offlineQueue.ts for why that timing is what makes the queue safe.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, deviceId } from '../../lib/api';
import { enqueue } from '../../lib/offlineQueue';
import { useOnline } from '../../hooks/useOnline';
import { Banner, ErrorState, LoadingState, Sheet } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useJudgeSession } from './JudgeSession';

export function MarkEntry() {
  const { performanceId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const online = useOnline();
  const { findPerformance, findItem, bundle, markScoredLocally, refreshBundle } = useJudgeSession();

  const performance = findPerformance(performanceId);
  const item = performance ? findItem(performance.itemId) : undefined;

  // JDG-04-04: the item-mismatch warning, acknowledged before mark entry opens.
  const mismatchItemName = searchParams.get('confirmMismatch');
  const [mismatchAcknowledged, setMismatchAcknowledged] = useState(!mismatchItemName);

  const maxMark = item?.maxMark ?? bundle?.config.maxMark ?? 10;
  const decimalPlaces = bundle?.config.decimalPlaces ?? 1;
  // Half-mark steps read naturally for a 10-point scale; whole-number scales
  // step by 1. Either way the value is always re-clamped to the configured
  // precision before it can be submitted.
  const stepSize = decimalPlaces >= 1 ? 0.5 : 1;

  const [mark, setMark] = useState<number | null>(null);
  const [remarks, setRemarks] = useState('');
  const [criteriaMarks, setCriteriaMarks] = useState<Record<string, number>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [queuedOffline, setQueuedOffline] = useState(false);
  const [success, setSuccess] = useState<number | null>(null);

  const hasCriteria = (item?.criteria.length ?? 0) > 0;
  const criteriaTotal = useMemo(
    () => Object.values(criteriaMarks).reduce((sum, v) => sum + v, 0),
    [criteriaMarks],
  );

  useEffect(() => {
    if (hasCriteria) setMark(roundTo(criteriaTotal, decimalPlaces));
  }, [criteriaTotal, hasCriteria, decimalPlaces]);

  if (!bundle) return <LoadingState label="Loading…" />;

  if (!performance || !item) {
    return (
      <ErrorState
        error={new Error('This performance could not be found in your cached session.')}
        onRetry={() => void refreshBundle()}
      />
    );
  }

  if (performance.myScore) {
    // JDG-02-03 equivalent for a direct navigation: already scored, no edit.
    navigate('/judge', { replace: true });
    return null;
  }

  // Narrowed, non-optional locals for the closures below — TypeScript's
  // control-flow narrowing of `performance`/`item`/`bundle` does not extend
  // into a function declared later in the same scope, even though none of
  // them can change before handleConfirm actually runs.
  const currentPerformance = performance;
  const currentItem = item;
  const currentBundle = bundle;

  const clamp = (value: number) => Math.min(maxMark, Math.max(0, roundTo(value, decimalPlaces)));

  const adjust = (delta: number) => setMark((prev) => clamp((prev ?? 0) + delta));

  const canSubmit =
    mark !== null &&
    mark >= 0 &&
    mark <= maxMark &&
    (!hasCriteria || Math.abs(criteriaTotal - mark) < 1e-9) &&
    mismatchAcknowledged;

  async function handleConfirm() {
    if (mark === null) return;
    setSubmitting(true);
    setSubmitError(null);

    const idempotencyKey =
      typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const submittedAt = new Date().toISOString();
    const deviceIdValue = deviceId();

    const criteriaPayload = hasCriteria
      ? currentItem.criteria.map((c) => ({ itemCriteriaId: c.id, mark: criteriaMarks[c.id] ?? 0 }))
      : undefined;

    if (!online) {
      // JDG-08-03: "Scoring continues offline. Submissions are queued locally
      // with their idempotency keys and timestamps."
      await enqueue({
        idempotencyKey,
        performanceId,
        sessionId: currentBundle.session.id,
        mark,
        remarks: remarks.trim() || null,
        criteria: criteriaPayload,
        submittedAt,
        deviceId: deviceIdValue,
        chestNumber: currentPerformance.chestNumber,
        participantName: currentPerformance.participantName,
        itemName: currentItem.name,
      });

      markScoredLocally(performanceId, mark);
      setQueuedOffline(true);
      setSuccess(mark);
      setSubmitting(false);
      setConfirmOpen(false);
      return;
    }

    try {
      const result = await api.post<{ mark: number; wasReplay: boolean }>('/api/judge/scores', {
        performanceId,
        mark,
        remarks: remarks.trim() || null,
        idempotencyKey,
        submittedAt,
        deviceId: deviceIdValue,
        criteria: criteriaPayload,
        acknowledgedOutOfSequence: mismatchItemName ? true : undefined,
      });

      markScoredLocally(performanceId, result.mark);
      setSuccess(result.mark);
      setConfirmOpen(false);
    } catch (error) {
      // JDG-06-07: "If the server reports that this judge has already scored
      // this performance, the app shows the existing mark and treats the action
      // as complete rather than showing a failure."
      if (error instanceof ApiError && error.code === 'ALREADY_SCORED') {
        const existingMark = (error.details as { mark?: number } | undefined)?.mark ?? mark;
        markScoredLocally(performanceId, existingMark);
        setSuccess(existingMark);
        setConfirmOpen(false);
        return;
      }

      // A network error mid-request is treated the same as starting offline —
      // the mark is queued rather than lost.
      if (error instanceof ApiError && error.isOffline) {
        await enqueue({
          idempotencyKey,
          performanceId,
          sessionId: currentBundle.session.id,
          mark,
          remarks: remarks.trim() || null,
          criteria: criteriaPayload,
          submittedAt,
          deviceId: deviceIdValue,
          chestNumber: currentPerformance.chestNumber,
          participantName: currentPerformance.participantName,
          itemName: currentItem.name,
        });
        markScoredLocally(performanceId, mark);
        setQueuedOffline(true);
        setSuccess(mark);
        setConfirmOpen(false);
        setSubmitting(false);
        return;
      }

      setSubmitError(error instanceof Error ? error.message : 'Could not submit this mark.');
    } finally {
      setSubmitting(false);
    }
  }

  if (success !== null) {
    return (
      <div className="state">
        <div className="state-icon" style={{ color: 'var(--success)' }}>
          <Icon name="check-circle" />
        </div>
        <p className="state-title">Mark recorded</p>
        <div className="mark-value-hero">{success.toFixed(decimalPlaces)}</div>
        {queuedOffline && (
          <Banner tone="warning">
            Saved on this device and will send automatically once you're back online.
          </Banner>
        )}
        <button type="button" className="btn btn-primary btn-lg" onClick={() => navigate('/judge')}>
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      {/* JDG-05-01: restate chest number, name, church, item and the maximum. */}
      <div className="card stage-card stack-sm">
        <div className="row-between">
          <span className="eyebrow">{item.name}</span>
          <span className="badge badge-neutral">Max {maxMark}</span>
        </div>
        <div className="chest-number" style={{ fontSize: 'var(--text-2xl)' }}>
          {performance.chestNumber ?? '—'} · {performance.participantName}
        </div>
        <div className="text-sm muted">{performance.churchName}</div>
      </div>

      {performance.revokedScore && (
        <Banner tone="warning" title="Your previous mark was revoked">
          {performance.revokedScore.reason ?? 'An administrator revoked this mark. Please re-enter it.'}
        </Banner>
      )}

      {/* JDG-04-04: prominent, must-acknowledge mismatch warning. */}
      {mismatchItemName && !mismatchAcknowledged && (
        <Banner tone="danger" title="This is not the item on stage">
          <p style={{ marginBottom: 'var(--space-3)' }}>
            The item on stage is <strong>{mismatchItemName}</strong>. You are about to score{' '}
            <strong>{item.name}</strong>.
          </p>
          <div className="row">
            <button type="button" className="btn btn-secondary" onClick={() => navigate(-1)}>
              Go back
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => setMismatchAcknowledged(true)}
            >
              I understand, continue
            </button>
          </div>
        </Banner>
      )}

      {(!mismatchItemName || mismatchAcknowledged) && (
        <>
          {hasCriteria ? (
            <div className="stack">
              {item.criteria.map((criterion) => (
                <CriterionInput
                  key={criterion.id}
                  criterion={criterion}
                  value={criteriaMarks[criterion.id] ?? 0}
                  decimalPlaces={decimalPlaces}
                  onChange={(v) =>
                    setCriteriaMarks((prev) => ({
                      ...prev,
                      [criterion.id]: Math.min(criterion.maxMark, Math.max(0, v)),
                    }))
                  }
                />
              ))}
              <div className="row-between card" style={{ background: 'var(--surface-sunken)' }}>
                <span className="strong">Total</span>
                <span className="mark-value">{criteriaTotal.toFixed(decimalPlaces)}</span>
              </div>
            </div>
          ) : (
            <>
              {/* JDG-05-02: stepper with increment/decrement plus a direct field. */}
              <div className="stepper">
                <button
                  type="button"
                  className="stepper-btn"
                  onClick={() => adjust(-stepSize)}
                  disabled={mark !== null && mark <= 0}
                  aria-label={`Decrease by ${stepSize}`}
                >
                  −
                </button>
                <input
                  className="stepper-value"
                  inputMode="decimal"
                  aria-label="Mark"
                  value={mark === null ? '' : mark}
                  onChange={(e) => {
                    const value = Number.parseFloat(e.target.value);
                    setMark(Number.isNaN(value) ? null : clamp(value));
                  }}
                  placeholder="—"
                />
                <button
                  type="button"
                  className="stepper-btn"
                  onClick={() => adjust(stepSize)}
                  disabled={mark !== null && mark >= maxMark}
                  aria-label={`Increase by ${stepSize}`}
                >
                  +
                </button>
              </div>

              <div className="chip-row" role="group" aria-label="Quick marks">
                {quickPicks(maxMark, decimalPlaces).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="chip"
                    aria-pressed={mark === value}
                    onClick={() => setMark(value)}
                  >
                    {value.toFixed(decimalPlaces)}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* JDG-05-05: optional remarks, admin-only, never affects calculation. */}
          <div className="field">
            <label className="label" htmlFor="remarks">
              Remarks (optional, visible to administrators only)
            </label>
            <textarea
              id="remarks"
              className="textarea"
              maxLength={250}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="e.g. Strong second verse, slightly rushed ending"
            />
          </div>

          <div className="action-dock">
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              disabled={!canSubmit}
              onClick={() => setConfirmOpen(true)}
            >
              Submit mark
            </button>
          </div>
        </>
      )}

      {/* JDG-06-01/02/03: confirm sheet — largest type, immutability warning,
          Cancel preserves the value. */}
      <Sheet open={confirmOpen} onClose={() => !submitting && setConfirmOpen(false)} title="Confirm mark">
        <div className="stack" style={{ textAlign: 'center' }}>
          <div>
            <div className="strong">
              {performance.chestNumber} · {performance.participantName}
            </div>
            <div className="text-sm muted">
              {performance.churchName} · {item.name}
            </div>
          </div>

          <div className="mark-value-hero">{mark?.toFixed(decimalPlaces)}</div>

          <Banner tone="warning">Once submitted this mark cannot be changed.</Banner>

          {submitError && <ErrorState error={new Error(submitError)} />}

          <div className="row" style={{ justifyContent: 'center' }}>
            <button
              type="button"
              className="btn btn-secondary btn-lg"
              onClick={() => setConfirmOpen(false)}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={handleConfirm}
              disabled={submitting}
            >
              {submitting ? 'Submitting…' : 'Confirm'}
            </button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

function CriterionInput({
  criterion,
  value,
  decimalPlaces,
  onChange,
}: {
  criterion: { id: string; name: string; maxMark: number };
  value: number;
  decimalPlaces: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="card stack-sm">
      <div className="row-between">
        <span className="strong">{criterion.name}</span>
        <span className="muted">/ {criterion.maxMark}</span>
      </div>
      <div className="stepper">
        <button
          type="button"
          className="stepper-btn"
          onClick={() => onChange(roundTo(value - 0.5, decimalPlaces))}
          disabled={value <= 0}
        >
          −
        </button>
        <input
          className="stepper-value"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            const v = Number.parseFloat(e.target.value);
            onChange(Number.isNaN(v) ? 0 : v);
          }}
        />
        <button
          type="button"
          className="stepper-btn"
          onClick={() => onChange(roundTo(value + 0.5, decimalPlaces))}
          disabled={value >= criterion.maxMark}
        >
          +
        </button>
      </div>
    </div>
  );
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function quickPicks(maxMark: number, decimalPlaces: number): number[] {
  const picks: number[] = [];
  const step = decimalPlaces >= 1 ? 0.5 : 1;
  for (let v = maxMark * 0.6; v <= maxMark; v += step) picks.push(roundTo(v, decimalPlaces));
  return picks;
}
