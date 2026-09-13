/**
 * Admin shell (FSD 10.3): desktop left sidebar, mobile bottom bar of five with
 * everything else behind "More".
 */
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { Capability } from '../../lib/auth';
import { Sheet } from '../../components/ui';
import { Icon, type IconName } from '../../components/Icon';
import { GlobalSearch } from '../../components/GlobalSearch';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  capability?: string;
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ to: '/admin', label: 'Dashboard', icon: 'home', end: true }],
  },
  {
    label: 'Live',
    items: [{ to: '/admin/live', label: 'Live console', icon: 'activity', capability: Capability.VIEW_SCORE_PROGRESS }],
  },
  {
    label: 'Data',
    items: [
      { to: '/admin/churches', label: 'Churches', icon: 'building', capability: Capability.MANAGE_CHURCHES },
      { to: '/admin/categories', label: 'Categories', icon: 'grid', capability: Capability.MANAGE_CATEGORIES },
      { to: '/admin/items', label: 'Items', icon: 'star', capability: Capability.MANAGE_ITEMS },
      { to: '/admin/members', label: 'Members', icon: 'users', capability: Capability.MANAGE_MEMBERS },
      { to: '/admin/registrations', label: 'Registrations', icon: 'user-plus', capability: Capability.MANAGE_REGISTRATIONS },
    ],
  },
  {
    label: 'Results',
    items: [
      { to: '/admin/results', label: 'Item results', icon: 'list', capability: Capability.VIEW_PROVISIONAL_RESULTS },
      { to: '/admin/leaderboard', label: 'Church leaderboard', icon: 'bar-chart', capability: Capability.VIEW_PROVISIONAL_RESULTS },
      { to: '/admin/champions', label: 'Champions', icon: 'medal', capability: Capability.VIEW_PROVISIONAL_RESULTS },
    ],
  },
  {
    label: 'More',
    items: [
      { to: '/admin/judges', label: 'Users', icon: 'user', capability: Capability.MANAGE_JUDGE_ACCOUNTS },
      { to: '/admin/panels', label: 'Panels', icon: 'flag', capability: Capability.MANAGE_PANELS },
      { to: '/admin/sessions', label: 'Sessions', icon: 'clock', capability: Capability.MANAGE_SESSIONS },
      { to: '/admin/config', label: 'Scoring config', icon: 'sliders', capability: Capability.CONFIGURE_SCORING },
      { to: '/admin/reports', label: 'Reports', icon: 'download', capability: Capability.EXPORT_REPORTS },
      { to: '/admin/audit', label: 'Audit log', icon: 'list', capability: Capability.VIEW_AUDIT_LOG },
      { to: '/admin/settings', label: 'Settings', icon: 'target', capability: Capability.MANAGE_SETTINGS },
    ],
  },
];

/** Five primary items for the mobile bottom bar; the rest live behind More. */
const MOBILE_PRIMARY: NavItem[] = [
  { to: '/admin', label: 'Home', icon: 'home', end: true },
  { to: '/admin/live', label: 'Live', icon: 'activity', capability: Capability.VIEW_SCORE_PROGRESS },
  { to: '/admin/members', label: 'Members', icon: 'users', capability: Capability.MANAGE_MEMBERS },
  { to: '/admin/results', label: 'Results', icon: 'list', capability: Capability.VIEW_PROVISIONAL_RESULTS },
];

export function AdminShell() {
  const { user, can, logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  // React Router doesn't remount/re-run effects when a NavLink targets the
  // route that's already active — clicking "Members" while already on
  // Members is a no-op from the router's point of view, so the screen never
  // refetches. Bumping this on every nav click and keying the Outlet with it
  // forces a fresh mount (and so a fresh load()) every time, including when
  // the destination happens to be where you already are.
  const [navKey, setNavKey] = useState(0);
  const bumpNavKey = () => setNavKey((k) => k + 1);

  const visibleGroups = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.capability || can(item.capability)),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark" aria-hidden="true">
            P
          </div>
          <div style={{ lineHeight: 1.2 }}>
            <div className="sidebar-brand-name">PYPA Marking</div>
            <div className="text-xs muted">{user?.role.replace('_', ' ')}</div>
          </div>
        </div>

        {visibleGroups.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-group-label">{group.label}</div>
            {group.items.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className="nav-link" onClick={bumpNavKey}>
                <Icon name={item.icon} size={18} />
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}

        <div className="nav-group">
          <button type="button" className="nav-link" style={{ width: '100%' }} onClick={() => void logout()}>
            <Icon name="log-out" size={18} />
            Sign out
          </button>
        </div>
      </aside>

      <div className="admin-main">
        <header className="app-header is-glass no-print">
          <GlobalSearch />
          <div className="header-context">
            <strong>{user?.fullName}</strong>
            <span>{user?.role.replace('_', ' ')}</span>
          </div>
        </header>
        <div className="container" style={{ paddingTop: 'var(--space-5)' }}>
          <Outlet key={navKey} />
        </div>
      </div>

      <nav className="bottom-nav admin-nav is-glass no-print" aria-label="Admin navigation">
        {MOBILE_PRIMARY.filter((item) => !item.capability || can(item.capability)).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className="bottom-nav-item" onClick={bumpNavKey}>
            <span className="bottom-nav-icon">
              <Icon name={item.icon} />
            </span>
            {item.label}
          </NavLink>
        ))}
        <button type="button" className="bottom-nav-item" onClick={() => setMoreOpen(true)}>
          <span className="bottom-nav-icon">
            <Icon name="more-horizontal" />
          </span>
          More
        </button>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <div className="stack">
          {visibleGroups.map((group) => (
            <div key={group.label} className="nav-group">
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className="nav-link"
                  onClick={() => {
                    setMoreOpen(false);
                    bumpNavKey();
                  }}
                >
                  <Icon name={item.icon} size={18} />
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
          <button type="button" className="btn btn-danger btn-block" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </Sheet>
    </div>
  );
}
