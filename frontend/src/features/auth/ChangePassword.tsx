/**
 * ADM-01-05: "On first login a user must change the password issued to them."
 *
 * Reached automatically after login when mustChangePassword is set, and is the
 * only screen (besides logout) available until it is done — enforced by the
 * route guard in App.tsx and independently by the server's
 * requirePasswordChanged middleware.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { Banner } from '../../components/ui';

export function ChangePassword() {
  const { user, changePassword, logout } = useAuth();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('The new password and confirmation do not match.');
      return;
    }

    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      const landing =
        user?.role === 'JUDGE' ? '/judge' : user?.role === 'COORDINATOR' ? '/admin/live' : '/admin';
      navigate(landing, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-4)',
      }}
    >
      <div className="card stack" style={{ width: '100%', maxWidth: 380 }}>
        <div>
          <h1 className="page-title">Set a new password</h1>
          <p className="text-sm muted">
            You're signing in with a temporary password. Choose a new one to continue.
          </p>
        </div>

        <form className="stack" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="label" htmlFor="current">
              Temporary password
            </label>
            <input
              id="current"
              type="password"
              className="input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="new">
              New password
            </label>
            <input
              id="new"
              type="password"
              className="input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
            <p className="hint">At least 8 characters, with at least one letter and one number.</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="confirm">
              Confirm new password
            </label>
            <input
              id="confirm"
              type="password"
              className="input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>

          {error && <Banner tone="danger">{error}</Banner>}

          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? 'Saving…' : 'Set password and continue'}
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={async () => {
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            Sign out instead
          </button>
        </form>
      </div>
    </div>
  );
}
