/**
 * Shared interface primitives.
 *
 * FSD 10.1: "Loading, empty, error and offline states are designed explicitly
 * for every screen. A blank screen is a defect." The state components here are
 * that requirement made reusable, so no screen has to reinvent them and none
 * ends up shipping without them.
 */
import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';

// --- States ----------------------------------------------------------------

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p className="state-body">{label}</p>
    </div>
  );
}

export function SkeletonRows({ rows = 4, height = 56 }: { rows?: number; height?: number }) {
  return (
    <div className="stack-sm" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon = '∅',
  title,
  body,
  action,
}: {
  icon?: string;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state">
      <div className="state-icon" aria-hidden="true">
        {icon}
      </div>
      <p className="state-title">{title}</p>
      {body && <p className="state-body">{body}</p>}
      {action}
    </div>
  );
}

/**
 * Error state.
 *
 * FSD 11.3: "Error messages state what went wrong and what to do next, in plain
 * language." The API already returns such a message for every FSD 9.4 code, so
 * it is shown verbatim rather than replaced with a generic one. The request id
 * is offered only for a server fault, where it is the thing an engineer needs.
 */
export function ErrorState({
  error,
  onRetry,
  title = 'Something went wrong',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  const apiError = error instanceof ApiError ? error : null;
  const message =
    apiError?.message ??
    (error instanceof Error ? error.message : 'An unexpected problem occurred.');

  if (apiError?.isOffline) {
    return (
      <div className="state">
        <div className="state-icon" aria-hidden="true">
          ⚡
        </div>
        <p className="state-title">No connection</p>
        <p className="state-body">
          This device is offline. Anything you have already submitted is safe, and this screen will
          refresh when the connection returns.
        </p>
        {onRetry && (
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="state" role="alert">
      <div className="state-icon" aria-hidden="true">
        ⚠
      </div>
      <p className="state-title">{title}</p>
      <p className="state-body">{message}</p>
      {apiError && apiError.status >= 500 && apiError.requestId && (
        <p className="text-xs subtle">Reference: {apiError.requestId}</p>
      )}
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Error alert dialog — centred on screen, dismissed with a single "OK".
 *
 * `ErrorState` is for a screen that has nothing else to show (the initial
 * list load failed); this is for the opposite case, where a save or action
 * failed *inside* an already-useful screen (an open form, a populated table).
 * Routing that into `ErrorState`'s page-level early return would blank out
 * the very form the admin needs to go fix and retry — this instead sits on
 * top of it, so closing the alert leaves everything exactly as it was.
 */
export function AlertDialog({
  error,
  onClose,
  title = 'Something went wrong',
}: {
  error: unknown;
  onClose: () => void;
  title?: string;
}) {
  const apiError = error instanceof ApiError ? error : null;
  const message =
    apiError?.message ??
    (error instanceof Error ? error.message : 'An unexpected problem occurred.');

  return (
    <Sheet open={error !== null} onClose={onClose} title={title}>
      <div className="stack">
        <div className="banner banner-danger">
          <span className="banner-icon" aria-hidden="true">
            ⚠
          </span>
          <div className="grow">{message}</div>
        </div>
        {apiError && apiError.status >= 500 && apiError.requestId && (
          <p className="text-xs subtle">Reference: {apiError.requestId}</p>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// --- Banners ----------------------------------------------------------------

export function Banner({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const icon = { info: 'ℹ', warning: '⚠', danger: '⚠', success: '✓' }[tone];

  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="banner-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="grow">
        {title && <div className="banner-title">{title}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}

// --- Badges -----------------------------------------------------------------

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'award';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/**
 * Performance status badge.
 *
 * FSD 11.3: "No information conveyed by colour alone; status is always
 * accompanied by text or an icon." The label is always rendered.
 */
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: BadgeTone; label: string }> = {
    SCHEDULED: { tone: 'neutral', label: 'Scheduled' },
    ON_STAGE: { tone: 'info', label: 'On stage' },
    IN_PROGRESS: { tone: 'warning', label: 'Being scored' },
    COMPLETE: { tone: 'success', label: 'Complete' },
    ABSENT: { tone: 'neutral', label: 'Absent' },
    VOID: { tone: 'danger', label: 'Voided' },
    WITHDRAWN: { tone: 'neutral', label: 'Withdrawn' },
    // Publication states (FSD 4.8)
    READY: { tone: 'info', label: 'Ready' },
    PROVISIONAL: { tone: 'warning', label: 'Provisional' },
    PUBLISHED: { tone: 'success', label: 'Published' },
    WITHHELD: { tone: 'danger', label: 'Withheld' },
    // Session states
    DRAFT: { tone: 'neutral', label: 'Draft' },
    OPEN: { tone: 'success', label: 'Open' },
    CLOSED: { tone: 'neutral', label: 'Closed' },
    FORCE_CLOSED: { tone: 'danger', label: 'Force-closed' },
  };

  const entry = map[status] ?? { tone: 'neutral' as BadgeTone, label: status };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

/** Position pill. Gold, silver and bronze for the first three (FSD 5.13). */
export function PositionPill({ position, placed }: { position: number | null; placed: boolean }) {
  if (position === null || !placed) {
    return (
      <span className="position" aria-label="No position awarded">
        —
      </span>
    );
  }
  const modifier = position <= 3 ? ` position-${position}` : '';
  return (
    <span className={`position${modifier}`} aria-label={`Position ${position}`}>
      {position}
    </span>
  );
}

// --- Progress ---------------------------------------------------------------

export function ProgressBar({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const complete = max > 0 && value >= max;

  return (
    <div
      className="progress-track"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label ?? `${value} of ${max}`}
    >
      <div className={`progress-fill${complete ? ' is-complete' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// --- Modal / bottom sheet ---------------------------------------------------

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  dismissable?: boolean;
}) {
  if (!open) return null;

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={dismissable ? onClose : undefined}
    >
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        {title && (
          <h2 className="page-title" style={{ marginBottom: 'var(--space-4)' }}>
            {title}
          </h2>
        )}
        {children}
        {footer && <div style={{ marginTop: 'var(--space-5)' }}>{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Confirmation dialog.
 *
 * FSD 10.1: "Every destructive or irreversible action requires explicit
 * confirmation naming what will happen." The consequence prop is mandatory for
 * exactly that reason — a confirm dialog that only says "Are you sure?" does not
 * satisfy the rule.
 */
export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  reasonLabel,
  reasonMinLength,
  reason,
  onReasonChange,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  consequence: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  /** Where the FSD requires a typed justification, pass a label to show the field. */
  reasonLabel?: string;
  reasonMinLength?: number;
  reason?: string;
  onReasonChange?: (value: string) => void;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const reasonTooShort =
    reasonLabel !== undefined && (reason ?? '').trim().length < (reasonMinLength ?? 1);

  return (
    <Sheet open={open} onClose={onCancel} title={title} dismissable={!busy}>
      <div className="stack">
        <div className="banner banner-warning">
          <span className="banner-icon" aria-hidden="true">
            ⚠
          </span>
          <div className="grow">{consequence}</div>
        </div>

        {reasonLabel !== undefined && (
          <div className="field">
            <label className="label" htmlFor="confirm-reason">
              {reasonLabel} <span className="required">*</span>
            </label>
            <textarea
              id="confirm-reason"
              className="textarea"
              value={reason ?? ''}
              onChange={(e) => onReasonChange?.(e.target.value)}
              placeholder="This is recorded in the audit log and printed on the exceptions report."
              aria-describedby="confirm-reason-hint"
            />
            <p className="hint" id="confirm-reason-hint">
              {reasonMinLength
                ? `At least ${reasonMinLength} characters. ${(reason ?? '').trim().length} entered.`
                : 'Required.'}
            </p>
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy || reasonTooShort}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// --- Misc -------------------------------------------------------------------

export function StatCard({
  value,
  label,
  tone,
  hint,
}: {
  value: ReactNode;
  label: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  hint?: string;
}) {
  const color =
    tone === 'warning'
      ? 'var(--warning-text)'
      : tone === 'danger'
        ? 'var(--danger-text)'
        : tone === 'success'
          ? 'var(--success-text)'
          : undefined;

  return (
    <div className="stat-card">
      <div className="stat-value" style={color ? { color } : undefined}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
      {hint && (
        <p className="text-xs subtle" style={{ marginTop: 'var(--space-1)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function Avatar({
  src,
  name,
  size = 'md',
}: {
  src?: string | null;
  name: string;
  size?: 'md' | 'lg';
}) {
  const className = size === 'lg' ? 'avatar avatar-lg' : 'avatar';

  if (src) {
    return <img className={className} src={src} alt="" loading="lazy" />;
  }

  return (
    <div className={`${className} avatar-placeholder`} aria-hidden="true">
      {name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase())
        .join('')}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="row-between row-wrap" style={{ marginBottom: 'var(--space-5)' }}>
      <div className="grow">
        <h1 className="page-title">{title}</h1>
        {subtitle && (
          <p className="text-sm muted" style={{ marginTop: 'var(--space-1)' }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Field({
  label,
  required,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={htmlFor}>
        {label} {required && <span className="required">*</span>}
      </label>
      {children}
      {hint && !error && <p className="hint">{hint}</p>}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
