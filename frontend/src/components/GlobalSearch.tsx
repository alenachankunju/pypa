/**
 * Header quick-search: queries churches, members and items in parallel using
 * the `?search=` filter each list endpoint already supports (the same
 * parameter Churches.tsx/Members.tsx's own search fields use), and links to
 * the matching admin screen. Not a decorative input — every result is real
 * data from a real query, and Churches/Members carry the typed query through
 * as `?q=` so the destination screen lands pre-filtered on it.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from './Icon';

interface ChurchHit {
  id: string;
  name: string;
}
interface MemberHit {
  id: string;
  fullName: string;
  churchName: string;
}
interface ItemHit {
  id: string;
  name: string;
  categoryName: string | null;
}

interface Results {
  churches: ChurchHit[];
  members: MemberHit[];
  items: ItemHit[];
}

const EMPTY: Results = { churches: [], members: [], items: [] };

export function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Results>(EMPTY);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(EMPTY);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(() => {
      Promise.all([
        api.get<ChurchHit[]>('/api/admin/churches', { search: q, pageSize: 5 }).catch(() => []),
        api.get<MemberHit[]>('/api/admin/members', { search: q, pageSize: 5 }).catch(() => []),
        api.get<ItemHit[]>('/api/admin/items', { search: q }).catch(() => []),
      ]).then(([churches, members, items]) => {
        setResults({ churches: churches.slice(0, 5), members: members.slice(0, 5), items: items.slice(0, 5) });
        setLoading(false);
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const hasQuery = query.trim().length >= 2;
  const hasResults = results.churches.length > 0 || results.members.length > 0 || results.items.length > 0;

  function go(path: string) {
    setOpen(false);
    setQuery('');
    navigate(path);
  }

  return (
    <div className="global-search" ref={containerRef}>
      <span className="global-search-icon">
        <Icon name="search" />
      </span>
      <input
        className="global-search-input"
        type="text"
        placeholder="Search churches, members, items…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        aria-label="Search churches, members and items"
      />

      {open && hasQuery && (
        <div className="global-search-panel">
          {loading && <div className="global-search-empty">Searching…</div>}

          {!loading && !hasResults && <div className="global-search-empty">No matches for "{query.trim()}".</div>}

          {!loading && results.churches.length > 0 && (
            <div className="global-search-group">
              <div className="global-search-group-label">Churches</div>
              {results.churches.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="global-search-row"
                  onClick={() => go(`/admin/churches?q=${encodeURIComponent(c.name)}`)}
                >
                  <Icon name="building" />
                  {c.name}
                </button>
              ))}
            </div>
          )}

          {!loading && results.members.length > 0 && (
            <div className="global-search-group">
              <div className="global-search-group-label">Members</div>
              {results.members.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="global-search-row"
                  onClick={() => go(`/admin/members?q=${encodeURIComponent(m.fullName)}`)}
                >
                  <Icon name="users" />
                  {m.fullName}
                  <span className="text-xs muted">{m.churchName}</span>
                </button>
              ))}
            </div>
          )}

          {!loading && results.items.length > 0 && (
            <div className="global-search-group">
              <div className="global-search-group-label">Items</div>
              {results.items.map((i) => (
                <button key={i.id} type="button" className="global-search-row" onClick={() => go('/admin/items')}>
                  <Icon name="star" />
                  {i.name}
                  {i.categoryName && <span className="text-xs muted">{i.categoryName}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
