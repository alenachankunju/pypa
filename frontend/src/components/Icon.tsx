/**
 * A small hand-authored line-icon set replacing the Unicode glyphs
 * (◧ ● ⛪ ▤ ♪ ☺ ⊞ ☰ 🏆 ★ ⚖ ⚑ ⏱ ⚙ ⎙ ≡ ⚒ ⎋ ▶ 🔍 ✓ ⚠ ℹ ∅ ⚡) that used to stand in for
 * navigation and status icons throughout the app. Glyphs render inconsistently
 * across platforms/fonts; a consistent stroke-based set reads as a real,
 * designed product instead.
 *
 * Every icon is built from plain SVG primitives (circle/rect/line/polyline)
 * rather than freehand curves, and sized in `em` so it follows the font-size
 * of whatever text it sits beside — a nav-link icon and a page-header icon
 * need no separate size prop to line up with their label.
 */
import type { SVGProps } from 'react';

export type IconName =
  | 'home'
  | 'activity'
  | 'building'
  | 'grid'
  | 'star'
  | 'users'
  | 'user'
  | 'user-plus'
  | 'list'
  | 'bar-chart'
  | 'medal'
  | 'flag'
  | 'clock'
  | 'sliders'
  | 'target'
  | 'download'
  | 'log-out'
  | 'play'
  | 'search'
  | 'check-circle'
  | 'check'
  | 'x'
  | 'alert-triangle'
  | 'alert-circle'
  | 'info'
  | 'zap'
  | 'more-horizontal'
  | 'empty';

const ICONS: Record<IconName, JSX.Element> = {
  home: (
    <>
      <polyline points="4 11 12 4 20 11" />
      <path d="M6 10 L6 20 L10 20 L10 15 L14 15 L14 20 L18 20 L18 10" />
    </>
  ),
  activity: <polyline points="2 12 6 12 9 20 15 4 18 12 22 12" />,
  building: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="1" />
      <rect x="8" y="6" width="2.5" height="2.5" fill="currentColor" stroke="none" />
      <rect x="13.5" y="6" width="2.5" height="2.5" fill="currentColor" stroke="none" />
      <rect x="8" y="10.5" width="2.5" height="2.5" fill="currentColor" stroke="none" />
      <rect x="13.5" y="10.5" width="2.5" height="2.5" fill="currentColor" stroke="none" />
      <rect x="9.5" y="15" width="5" height="6" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </>
  ),
  star: (
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26" />
  ),
  users: (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  user: (
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  'user-plus': (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="20" y1="8" x2="20" y2="14" />
      <line x1="23" y1="11" x2="17" y2="11" />
    </>
  ),
  list: (
    <>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="3.5" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="18" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  'bar-chart': (
    <>
      <rect x="4" y="13" width="4" height="7" fill="currentColor" stroke="none" />
      <rect x="10" y="8" width="4" height="12" fill="currentColor" stroke="none" />
      <rect x="16" y="4" width="4" height="16" fill="currentColor" stroke="none" />
    </>
  ),
  medal: (
    <>
      <path d="M12 15 L7 3" />
      <path d="M12 15 L17 3" />
      <circle cx="12" cy="17" r="5" />
    </>
  ),
  flag: (
    <>
      <line x1="4" y1="21" x2="4" y2="3" />
      <path d="M4 4 L18 4 L14 8 L18 12 L4 12" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 16 14" />
    </>
  ),
  sliders: (
    <>
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="7" cy="18" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3 L12 15" />
      <polyline points="7 11 12 16 17 11" />
      <line x1="4" y1="21" x2="20" y2="21" />
    </>
  ),
  'log-out': (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </>
  ),
  play: <polygon points="6 4 20 12 6 20" fill="currentColor" stroke="none" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="20" y1="20" x2="15.5" y2="15.5" />
    </>
  ),
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="7.5 12.5 10.5 15.5 16.5 8.5" />
    </>
  ),
  check: <polyline points="4 12 9 17 20 6" />,
  x: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  'alert-triangle': (
    <>
      <polygon points="12 3 22 20 2 20" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <circle cx="12" cy="16.3" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  'alert-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <circle cx="12" cy="16" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  zap: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" stroke="none" />,
  'more-horizontal': (
    <>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  empty: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="7" y1="12" x2="17" y2="12" />
    </>
  ),
};

export function Icon({
  name,
  size = '1em',
  ...rest
}: { name: IconName; size?: number | string } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {ICONS[name]}
    </svg>
  );
}
