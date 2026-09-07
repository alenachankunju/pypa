/**
 * Screen J10 — Profile (FSD 6, screen inventory J10).
 * "Name, session, password change, theme, sign out."
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import { Avatar, ErrorState } from '../../components/ui';
import { useJudgeSession } from './JudgeSession';

export function Profile() {
  const { user, logout, changePassword } = useAuth();
  const { bundle, setSessionId } = useJudgeSession();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();

  const [changing, setChanging] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleChangePassword() {
    setError(null);
    if (newPassword !== confirmPassword) {
      setError(new Error('The new password and confirmation do not match.'));
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setDone(true);
      setChanging(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <div className="card stack-sm" style={{ alignItems: 'center', textAlign: 'center' }}>
        <Avatar name={user?.fullName ?? '?'} size="lg" />
        <div className="participant-name">{user?.fullName}</div>
        <div className="muted">{user?.username}</div>
        {bundle && <div className="badge badge-neutral">{bundle.session.name}</div>}
      </div>

      <div className="card stack-sm">
        <span className="eyebrow">Appearance</span>
        <div className="row" role="radiogroup" aria-label="Theme">
          {(['system', 'light', 'dark'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className="chip"
              role="radio"
              aria-checked={theme === option}
              aria-pressed={theme === option}
              onClick={() => setTheme(option)}
              style={{ textTransform: 'capitalize' }}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="card stack-sm">
        <span className="eyebrow">Session</span>
        <button type="button" className="btn btn-secondary btn-block" onClick={() => setSessionId(null)}>
          Change session
        </button>
      </div>

      <div className="card stack-sm">
        <span className="eyebrow">Password</span>
        {done && <p className="text-sm" style={{ color: 'var(--success-text)' }}>Password changed.</p>}
        {!changing ? (
          <button type="button" className="btn btn-secondary btn-block" onClick={() => setChanging(true)}>
            Change password
          </button>
        ) : (
          <div className="stack-sm">
            <input
              type="password"
              className="input"
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
            <input
              type="password"
              className="input"
              placeholder="New password (min. 8 characters, 1 letter, 1 number)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            <input
              type="password"
              className="input"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
            {error !== null && <ErrorState error={error} />}
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={() => setChanging(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={handleChangePassword} disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        className="btn btn-danger btn-block"
        onClick={async () => {
          await logout();
          navigate('/login', { replace: true });
        }}
      >
        Sign out
      </button>
    </div>
  );
}
