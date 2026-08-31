/**
 * Screen J4 — Search (FSD 6.3).
 *
 * JDG-03-01: numeric-first input, device numeric keypad.
 * JDG-03-02: results filter as the judge types, after a minimum of two characters.
 * JDG-03-06: "Silent empty results are not acceptable" — the API throws a
 * NOT_FOUND naming the chest number, rendered here as the explicit message.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { Avatar, ErrorState, LoadingState } from '../../components/ui';
import { useJudgeSession } from './JudgeSession';

interface SearchResult {
  memberId: string;
  registrationId: string;
  chestNumber: string;
  participantName: string;
  photoPath: string | null;
  churchName: string;
  categoryName: string | null;
}

export function Search() {
  const { sessionId } = useJudgeSession();
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    // JDG-03-02: "Results filter as the judge types, after a minimum of two
    // characters." Debounced so a fast typist does not fire a request per
    // keystroke.
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      setResults(null);
      setNotFound(null);
      setError(null);
      return;
    }

    setLoading(true);
    const timeout = window.setTimeout(async () => {
      try {
        const data = await api.get<SearchResult[]>('/api/judge/search', { sessionId, q: trimmed });
        setResults(data);
        setNotFound(null);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'NOT_FOUND') {
          setResults([]);
          setNotFound(err.message);
          setError(null);
        } else {
          setError(err);
        }
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [term, sessionId]);

  if (!sessionId) {
    return <p className="muted">Choose a session from the Now tab first.</p>;
  }

  return (
    <div className="stack">
      <div className="field">
        <label className="label" htmlFor="chest-search">
          Chest number or name
        </label>
        <input
          ref={inputRef}
          id="chest-search"
          className="input"
          style={{ fontSize: 'var(--text-xl)', textAlign: 'center' }}
          // JDG-03-01: numeric-first — inputMode opens the numeric keypad while
          // still accepting the partial-name fallback in JDG-03-03.
          inputMode="numeric"
          autoComplete="off"
          placeholder="e.g. 214"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>

      {loading && <LoadingState label="Searching…" />}

      {error !== null && <ErrorState error={error} />}

      {notFound && (
        <div className="banner banner-warning">
          <span className="banner-icon" aria-hidden="true">
            ⚠
          </span>
          <div>{notFound}</div>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="stack-sm">
          {results.map((r) => (
            <button
              key={r.registrationId}
              type="button"
              className="card row"
              style={{ width: '100%', textAlign: 'left' }}
              onClick={() => navigate(`/judge/member/${r.memberId}`)}
            >
              <Avatar name={r.participantName} />
              <div className="grow">
                <div className="strong">
                  {r.chestNumber} · {r.participantName}
                </div>
                <div className="text-sm muted">
                  {r.churchName}
                  {r.categoryName ? ` · ${r.categoryName}` : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
