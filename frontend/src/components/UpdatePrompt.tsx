/**
 * Surfaces a new deployed version to whoever has the app open.
 *
 * registerType is 'prompt' (not 'autoUpdate') deliberately: a judge mid-score
 * or a coordinator mid-session must never be silently reloaded out from
 * under themselves. Without this component, though, 'prompt' mode detects an
 * update and then does nothing visible at all — the tab just keeps serving
 * the old bundle until the user happens to fully close and reopen it. That
 * gap is exactly what made a same-day bug fix look like it hadn't shipped.
 */
import { useRegisterSW } from 'virtual:pwa-register/react';

const CHECK_INTERVAL_MS = 20 * 60 * 1000;

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      // 'prompt' mode has no built-in polling — a tab left open across a
      // long judging session would otherwise never notice a new deploy.
      window.setInterval(() => void registration.update(), CHECK_INTERVAL_MS);
    },
  });

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 'calc(var(--space-4) + env(safe-area-inset-bottom, 0px))',
        transform: 'translateX(-50%)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-4)',
        background: 'var(--accent)',
        color: 'var(--text-on-accent)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        maxWidth: 'calc(100vw - var(--space-4) * 2)',
      }}
    >
      <span className="text-sm">A new version is available.</span>
      <button
        type="button"
        className="btn btn-sm"
        style={{ background: 'var(--surface)', color: 'var(--accent)', flexShrink: 0 }}
        onClick={() => void updateServiceWorker(true)}
      >
        Refresh
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        style={{ color: 'var(--text-on-accent)', flexShrink: 0 }}
        onClick={() => setNeedRefresh(false)}
      >
        Later
      </button>
    </div>
  );
}
