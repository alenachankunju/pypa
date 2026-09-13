/**
 * Judge application shell: header (JDG-01-04), bottom navigation (FSD 10.2),
 * offline banner (JDG-08-02) and the queue-badge wiring.
 */
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useOnline } from '../../hooks/useOnline';
import { useQueue } from '../../hooks/useQueue';
import { useJudgeSession } from './JudgeSession';
import { Icon } from '../../components/Icon';

export function JudgeShell() {
  const { user } = useAuth();
  const online = useOnline();
  const { depth } = useQueue();
  const { bundle } = useJudgeSession();

  return (
    <div>
      {/* JDG-08-02: "a persistent amber banner reads 'Offline — marks will be
          saved and sent automatically.'" */}
      {!online && (
        <div className="offline-banner" role="status">
          <Icon name="zap" />
          Offline — marks will be saved and sent automatically.
        </div>
      )}

      {/* JDG-01-04: judge name and active session always visible. */}
      <header className="app-header is-glass">
        <div className="row" style={{ gap: 'var(--space-2)', minWidth: 0 }}>
          <span className="sidebar-brand-mark" aria-hidden="true" style={{ width: 28, height: 28, fontSize: '0.9rem' }}>
            P
          </span>
          <div className="header-context">
            <strong>{user?.fullName}</strong>
            <span>{bundle?.session.name ?? 'No active session'}</span>
          </div>
        </div>
        {bundle && (
          <span className="badge badge-neutral">{bundle.session.panelName}</span>
        )}
      </header>

      <main className="judge-main">
        <Outlet />
      </main>

      <nav className={`bottom-nav is-glass${!online ? ' is-offline' : ''}`} aria-label="Judge navigation">
        <NavLink to="/judge" end className="bottom-nav-item">
          <span className="bottom-nav-icon">
            <Icon name="play" />
          </span>
          Now
        </NavLink>
        <NavLink to="/judge/search" className="bottom-nav-item">
          <span className="bottom-nav-icon">
            <Icon name="search" />
          </span>
          Search
        </NavLink>
        <NavLink to="/judge/my-marks" className="bottom-nav-item" style={{ position: 'relative' }}>
          <span className="bottom-nav-icon">
            <Icon name="check-circle" />
          </span>
          My Marks
          {depth > 0 && (
            <span className="bottom-nav-badge" aria-label={`${depth} marks waiting to send`}>
              {depth}
            </span>
          )}
        </NavLink>
        <NavLink to="/judge/profile" className="bottom-nav-item">
          <span className="bottom-nav-icon">
            <Icon name="user" />
          </span>
          Profile
        </NavLink>
      </nav>
    </div>
  );
}
