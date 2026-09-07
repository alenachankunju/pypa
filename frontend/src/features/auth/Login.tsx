/**
 * Screen J1 / A-login — the single shared login screen (ADM-01-01).
 *
 * "All users, regardless of role, log in through a single login screen using
 * username (or email) and password." Routing by role happens after login
 * (ADM-01-02), inside useAuth's landingRoute.
 */
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { ApiError } from '../../lib/api';
import { Banner } from '../../components/ui';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const user = await login(username.trim(), password);
      const from = (location.state as { from?: string } | null)?.from;

      if (user.mustChangePassword) {
        navigate('/change-password', { replace: true });
        return;
      }

      const landing = user.role === 'JUDGE' ? '/judge' : user.role === 'COORDINATOR' ? '/admin/live' : '/admin';
      navigate(from ?? landing, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'ACCOUNT_LOCKED') {
          setError(err.message);
        } else if (err.code === 'DEVICE_PIN_MISMATCH') {
          setError(err.message);
        } else {
          setError(err.message);
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      {/* Branded panel — hidden below the split breakpoint (.login-brand's own
          media query), so mobile gets the form full-screen rather than a
          squeezed-down version of both halves. */}
      <div className="login-brand" aria-hidden="true">
        <div className="login-brand-mark">P</div>
        <h1 className="login-brand-title">PYPA Marking System</h1>
        <p className="login-brand-tagline">Competition registration, live judging and results</p>
        <div className="login-brand-rule" />
        <p className="login-brand-footnote">Pentecostal Youth &amp; Pathfinders Association</p>
      </div>

      <div className="login-panel">
        <div className="login-form-wrap">
          <div className="login-form-header">
            <div className="login-brand-mark login-brand-mark-compact" aria-hidden="true">
              P
            </div>
            <h1 className="page-title">Sign in</h1>
            <p className="text-sm muted">Enter your username and password to continue.</p>
          </div>

          <form className="stack" onSubmit={handleSubmit} noValidate>
            <div className="field">
              <label className="label" htmlFor="username">
                Username
              </label>
              <input
                id="username"
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="off"
                autoCorrect="off"
                required
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="password">
                Password
              </label>
              <div className="row" style={{ position: 'relative' }}>
                <input
                  id="password"
                  className="input"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ position: 'absolute', right: 4 }}
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            {error && <Banner tone="danger">{error}</Banner>}

            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {/* ADM-01-06: forgot password is deliberately NOT self-service. */}
          <p className="text-xs subtle" style={{ textAlign: 'center' }}>
            Forgotten your password? Ask your administrator to reset it.
          </p>
        </div>
      </div>
    </div>
  );
}
